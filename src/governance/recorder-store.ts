/**
 * Governance recorder store: tool-event and gate-run inserts with their
 * mutation-sequence and evidence-retention bookkeeping, the client-state
 * upsert, and the Stop observation. Split from repository.ts (phase 4).
 */
import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import type {
  GovernanceStopObservationInput, GovernanceToolEventInsert,
  RecorderTransactionInput, RecorderTransactionResult,
} from './repository-types.js';

interface ExistingEvent {
  event_seq: number;
  mutation_seq: number;
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

function dedupedEvent(db: Database.Database, event: GovernanceToolEventInsert): ExistingEvent | undefined {
  if (event.toolUseId !== null) {
    const row = db.prepare(`
      SELECT event_seq, mutation_seq FROM governance_tool_events
      WHERE client_name = ? AND session_id = ? AND tool_use_id = ? AND hook_event = ?
    `).get(event.clientName, event.sessionId, event.toolUseId, event.hookEvent) as ExistingEvent | undefined;
    if (row) return row;
  }
  if (event.hookEvent === 'FileChanged' && event.deliveryFingerprint !== null) {
    return db.prepare(`
      SELECT event_seq, mutation_seq FROM governance_tool_events
      WHERE client_name = ? AND session_id = ? AND hook_event = 'FileChanged'
        AND delivery_fingerprint = ?
    `).get(event.clientName, event.sessionId, event.deliveryFingerprint) as ExistingEvent | undefined;
  }
  return undefined;
}

function isCorrelatedMutation(db: Database.Database, event: GovernanceToolEventInsert): boolean {
  if (event.toolUseId === null || event.mutationClass === 'none') return false;
  const rows = db.prepare(`
    SELECT affected_paths FROM governance_tool_events
    WHERE project = ? AND client_name = ? AND session_id = ? AND tool_use_id = ?
      AND hook_event != ? AND mutation_class = 'scoped'
  `).all(
    event.project, event.clientName, event.sessionId, event.toolUseId, event.hookEvent,
  ) as Array<{ affected_paths: string }>;
  if (event.mutationClass !== 'scoped') return false;
  const expected = json([...event.affectedPaths].sort());
  return rows.some(row => {
    try {
      const paths = JSON.parse(row.affected_paths) as unknown;
      return Array.isArray(paths) && json([...paths].sort()) === expected;
    } catch {
      return false;
    }
  });
}

export function currentMutationSequence(db: Database.Database, project: string): number {
  const key = mutationSequenceKey(project);
  const persisted = db.prepare('SELECT value FROM maintenance_meta WHERE key = ?')
    .get(key) as { value: string } | undefined;
  if (persisted !== undefined) {
    const parsed = Number(persisted.value);
    if (Number.isSafeInteger(parsed) && parsed >= 0) return parsed;
    throw new Error('invalid persisted governance mutation sequence');
  }
  return (db.prepare(`
    SELECT COALESCE(MAX(mutation_seq), 0) AS mutation_seq
    FROM governance_tool_events WHERE project = ?
  `).get(project) as { mutation_seq: number }).mutation_seq;
}

function mutationSequenceKey(project: string): string {
  const digest = createHash('sha256').update(project).digest('hex');
  return `governance_mutation_seq:${digest}`;
}

function retentionKey(project: string): string {
  const digest = createHash('sha256').update(project).digest('hex');
  return `governance_evidence_days:${digest}`;
}

function persistMutationSequence(db: Database.Database, project: string, sequence: number): void {
  db.prepare(`
    INSERT INTO maintenance_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(mutationSequenceKey(project), String(sequence));
}

/** Evidence-retention window bounds. Enforced in four places, two of which
 *  also render the range into an error message — they must not drift. */
export const EVIDENCE_RETENTION_DAYS = { MIN: 1, MAX: 30, DEFAULT: 30 } as const;

export const evidenceDaysOutOfRange = (days: number): boolean =>
  !Number.isInteger(days)
  || days < EVIDENCE_RETENTION_DAYS.MIN
  || days > EVIDENCE_RETENTION_DAYS.MAX;

export const evidenceRangeMessage = (): string =>
  `evidence retention must be ${EVIDENCE_RETENTION_DAYS.MIN}..${EVIDENCE_RETENTION_DAYS.MAX} days`;

function persistEvidenceDays(db: Database.Database, project: string, days: number): void {
  if (evidenceDaysOutOfRange(days)) {
    throw new Error(evidenceRangeMessage());
  }
  db.prepare(`
    INSERT INTO maintenance_meta (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(retentionKey(project), String(days));
}

export function persistedEvidenceDays(db: Database.Database, project: string): number | null {
  const row = db.prepare('SELECT value FROM maintenance_meta WHERE key = ?')
    .get(retentionKey(project)) as { value: string } | undefined;
  if (row === undefined) return null;
  const days = Number(row.value);
  return Number.isInteger(days) && days >= 1 && days <= 30 ? days : null;
}

function updateClientState(db: Database.Database, event: GovernanceToolEventInsert): void {
  const post = event.hookEvent === 'PostToolUse' ? 1 : null;
  const failure = event.hookEvent === 'PostToolUseFailure' ? 1 : null;
  const fileChanged = event.hookEvent === 'FileChanged' ? 1 : null;
  const structured = event.observedStructuredOutput === null
    ? null : event.observedStructuredOutput ? 1 : 0;
  db.prepare(`
    INSERT INTO governance_client_state (
      project, client_installation_id, client_name, client_version,
      supports_post_tool_use, supports_post_tool_failure, supports_file_changed,
      supports_structured_output, adapter_version, last_session_id,
      last_heartbeat_at, last_probe_result
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'hook-observation')
    ON CONFLICT(project, client_installation_id) DO UPDATE SET
      client_name = excluded.client_name,
      client_version = COALESCE(excluded.client_version, governance_client_state.client_version),
      supports_post_tool_use = COALESCE(excluded.supports_post_tool_use, governance_client_state.supports_post_tool_use),
      supports_post_tool_failure = COALESCE(excluded.supports_post_tool_failure, governance_client_state.supports_post_tool_failure),
      supports_file_changed = COALESCE(excluded.supports_file_changed, governance_client_state.supports_file_changed),
      supports_structured_output = COALESCE(excluded.supports_structured_output, governance_client_state.supports_structured_output),
      adapter_version = excluded.adapter_version,
      last_session_id = excluded.last_session_id,
      last_heartbeat_at = excluded.last_heartbeat_at,
      last_probe_result = excluded.last_probe_result
  `).run(
    event.project, event.clientInstallationId, event.clientName, event.clientVersion,
    post, failure, fileChanged, structured, event.adapterVersion,
    event.sessionId, event.receivedAt,
  );
}

/** Assign event order and project mutation order in the same immediate transaction. */
export function recordToolEvent(db: Database.Database, input: RecorderTransactionInput): RecorderTransactionResult {
  const transaction = db.transaction((): RecorderTransactionResult => {
    const duplicate = dedupedEvent(db, input.event);
    if (duplicate) {
      persistEvidenceDays(db, input.event.project, input.evidenceDays);
      updateClientState(db, input.event);
      return {
        status: 'deduplicated', eventSeq: duplicate.event_seq,
        mutationSeq: duplicate.mutation_seq, gateRuns: 0,
      };
    }

    const currentMutation = currentMutationSequence(db, input.event.project);
    const increments = input.event.mutationClass !== 'none' &&
      !isCorrelatedMutation(db, input.event);
    const mutationSeq = currentMutation + (increments ? 1 : 0);
    if (increments) persistMutationSequence(db, input.event.project, mutationSeq);
    persistEvidenceDays(db, input.event.project, input.evidenceDays);
    const insert = db.prepare(`
      INSERT INTO governance_tool_events (
        project, canonical_root, session_id, client_name, client_version,
        hook_event, tool_name, tool_use_id, delivery_fingerprint,
        received_at, started_at, ended_at, duration_ms,
        raw_command, redacted_command, command_sha256, cwd, normalized_argv,
        outcome, exit_code, signal, interrupted, timed_out, output_sha256,
        redacted_diagnostic, mutation_class, affected_paths, mutation_seq,
        adapter_name, adapter_version, capture_status, capture_reason, created_at
      ) VALUES (
        @project, @canonicalRoot, @sessionId, @clientName, @clientVersion,
        @hookEvent, @toolName, @toolUseId, @deliveryFingerprint,
        @receivedAt, @startedAt, @endedAt, @durationMs,
        @rawCommand, @redactedCommand, @commandSha256, @cwd, @normalizedArgv,
        @outcome, @exitCode, @signal, @interrupted, @timedOut, @outputSha256,
        @redactedDiagnostic, @mutationClass, @affectedPaths, @mutationSeq,
        @adapterName, @adapterVersion, @captureStatus, @captureReason, @receivedAt
      )
    `).run({
      ...input.event,
      interrupted: input.event.interrupted ? 1 : 0,
      timedOut: input.event.timedOut ? 1 : 0,
      affectedPaths: json(input.event.affectedPaths),
      mutationSeq,
    });
    const eventSeq = Number(insert.lastInsertRowid);
    if (input.failAfterEventInsert) throw new Error('induced recorder failure');

    const gateInsert = db.prepare(`
      INSERT INTO governance_gate_runs (
        event_seq, project, session_id, client_name, gate_id, rule_id, rule_revision,
        config_version, config_sha256, parser_name, parser_version,
        test_total, test_pass, test_fail, test_skip, skip_reasons_complete,
        worktree_digest, digest_version, mutation_seq, relevant_paths_sha256,
        capture_result, created_at
      ) VALUES (
        @eventSeq, @project, @sessionId, @clientName, @gateId, @ruleId, @ruleRevision,
        @configVersion, @configSha256, @parserName, @parserVersion,
        @testTotal, @testPass, @testFail, @testSkip, @skipReasonsComplete,
        @worktreeDigest, @digestVersion, @mutationSeq, @relevantPathsSha256,
        @captureResult, @createdAt
      )
    `);
    const incidentInsert = db.prepare(`
      INSERT INTO governance_audit (
        project, session_id, client_name, occurred_at, event_type, actor_class,
        redacted_detail, linked_gate_id, linked_event_seq, payload_version, payload
      ) VALUES (?, ?, ?, ?, 'recorder_incident', 'system', ?, ?, ?, 1, ?)
    `);
    for (const gate of input.gateRuns) {
      gateInsert.run({
        eventSeq, project: input.event.project, sessionId: input.event.sessionId,
        clientName: input.event.clientName, mutationSeq, createdAt: input.event.receivedAt,
        ...gate,
        skipReasonsComplete: gate.skipReasonsComplete === null
          ? null : gate.skipReasonsComplete ? 1 : 0,
      });
      if (gate.incidentReason !== null) {
        incidentInsert.run(
          input.event.project, input.event.sessionId, input.event.clientName,
          input.event.receivedAt, `gate ${gate.gateId}: ${gate.incidentReason}`,
          gate.gateId, eventSeq, json({ reason: gate.incidentReason }),
        );
      }
    }
    if (input.event.captureStatus === 'incomplete' || input.event.captureStatus === 'adapter_error') {
      incidentInsert.run(
        input.event.project, input.event.sessionId, input.event.clientName,
        input.event.receivedAt, `event capture: ${input.event.captureReason ?? input.event.captureStatus}`,
        null, eventSeq, json({ reason: input.event.captureReason ?? input.event.captureStatus }),
      );
    }
    updateClientState(db, input.event);
    return { status: 'recorded', eventSeq, mutationSeq, gateRuns: input.gateRuns.length };
  });
  return transaction.immediate();
}

export function readClientState(db: Database.Database, project: string, installationId: string): Record<string, unknown> | null {
  return (db.prepare(`
    SELECT * FROM governance_client_state
    WHERE project = ? AND client_installation_id = ?
  `).get(project, installationId) as Record<string, unknown> | undefined) ?? null;
}

/** Record Stop support without overwriting capabilities this hook cannot observe. */
export function observeStop(db: Database.Database, input: GovernanceStopObservationInput): void {
  db.prepare(`
    INSERT INTO governance_client_state (
      project, client_installation_id, client_name, client_version,
      supports_stop, adapter_version, last_session_id,
      last_heartbeat_at, last_probe_result
    ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, 'hook-observation')
    ON CONFLICT(project, client_installation_id) DO UPDATE SET
      client_name = excluded.client_name,
      client_version = COALESCE(excluded.client_version, governance_client_state.client_version),
      supports_stop = COALESCE(excluded.supports_stop, governance_client_state.supports_stop),
      adapter_version = excluded.adapter_version,
      last_session_id = excluded.last_session_id,
      last_heartbeat_at = excluded.last_heartbeat_at,
      last_probe_result = excluded.last_probe_result
  `).run(
    input.project, input.clientInstallationId, input.clientName, input.clientVersion,
    input.adapterVersion, input.sessionId, input.occurredAt,
  );
}
