import { createHash } from 'node:crypto';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import {
  resolveCapabilityStatus, type GovernanceClientCapabilityRow,
} from './capability-status.js';
import { GovernanceRuleRepository } from './rule-repository.js';
import {
  CAPABILITY_DEGRADATION_REASONS, SHADOW_FAULT_CODES, SHADOW_RESULTS,
  type CapabilityDegradationReason, type ShadowResult, type ShadowVerdictReason,
} from './verdict-types.js';
import { sanitize } from '../utils/validation.js';
import { gatesPath, legacyGatesPaths } from '../constants/paths.js';

export interface GovernanceBriefingSection {
  rules: string[];
  /** Whether THIS SESSION's client is in the advisory layer's scope
   *  (claude-code only today). The renderer branches on this, never on
   *  the unsupported_client CODE: a claude-code session reading a
   *  foreign-stamped row also carries that code, and inferring identity
   *  from it would silently swallow its real degradations (review). */
  clientInScope: boolean;
  capabilityReasons: CapabilityDegradationReason[];
  lastVerdict: {
    result: ShadowResult;
    reason: ShadowVerdictReason;
    ageEvents: number;
  } | null;
}

interface ClientRow {
  project: string;
  client_installation_id: string;
  client_name: string;
  client_version: string | null;
  supports_post_tool_use: number | null;
  supports_post_tool_failure: number | null;
  supports_file_changed: number | null;
  supports_structured_output: number | null;
  supports_stop: number | null;
  supports_blocking: number | null;
  adapter_version: number;
  settings_source: string | null;
  last_session_id: string | null;
  last_heartbeat_at: string | null;
  last_probe_result: string | null;
}

function booleanOrNull(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

function capabilityRow(row: ClientRow | undefined): GovernanceClientCapabilityRow | null {
  return row === undefined ? null : {
    project: row.project, clientInstallationId: row.client_installation_id,
    clientName: row.client_name, clientVersion: row.client_version,
    supportsPostToolUse: booleanOrNull(row.supports_post_tool_use),
    supportsPostToolFailure: booleanOrNull(row.supports_post_tool_failure),
    supportsFileChanged: booleanOrNull(row.supports_file_changed),
    supportsStructuredOutput: booleanOrNull(row.supports_structured_output),
    supportsStop: booleanOrNull(row.supports_stop),
    supportsBlocking: booleanOrNull(row.supports_blocking), adapterVersion: row.adapter_version,
    settingsSource: row.settings_source, lastSessionId: row.last_session_id,
    lastHeartbeatAt: row.last_heartbeat_at, lastProbeResult: row.last_probe_result,
  };
}

function configPresent(projectRoot: string): boolean {
  try {
    const root = realpathSync.native(resolve(projectRoot));
    // Phase-B compat: un-migrated repos keep gates under the legacy dir —
    // governance presence must see them or the flip silently disarms it.
    for (const p of [gatesPath(root), ...legacyGatesPaths(root)]) {
      try { lstatSync(p); return true; } catch { /* next */ }
    }
    return false;
  } catch {
    return false;
  }
}

function installationId(sessionId: string, explicit: string | null): string {
  return explicit ?? `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}`;
}

function redactedRule(content: string): string {
  return sanitize(content)
    .replace(/\b(token|secret|password|api[-_]?key)\s*[=:]\s*\S+/giu, '$1=[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$1[REDACTED]@')
    .slice(0, 160);
}

const VERDICT_REASONS = new Set<string>([
  ...SHADOW_FAULT_CODES, ...CAPABILITY_DEGRADATION_REASONS,
  'gate_self_error', 'no_active_pre_exit_rule', 'empty_requirement_set',
  'gate_non_pass', 'gate_stale', 'gate_missing', 'all_required_gates_fresh',
]);

function lastVerdict(db: Database.Database, project: string): GovernanceBriefingSection['lastVerdict'] {
  const row = db.prepare(`
    SELECT payload_version, payload FROM governance_audit
    WHERE project = ? AND event_type = 'shadow_stop_verdict'
    ORDER BY id DESC LIMIT 1
  `).get(project) as { payload_version: number; payload: string } | undefined;
  if (row === undefined || row.payload_version !== 1) return null;
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    const evaluated = payload.evaluated_through as Record<string, unknown> | undefined;
    const eventSeq = evaluated?.event_seq;
    if (typeof payload.result !== 'string' ||
        !(SHADOW_RESULTS as readonly string[]).includes(payload.result) ||
        typeof payload.reason !== 'string' || !VERDICT_REASONS.has(payload.reason) ||
        typeof eventSeq !== 'number' || !Number.isSafeInteger(eventSeq) || eventSeq < 0) return null;
    const current = db.prepare(`
      SELECT COALESCE(MAX(event_seq), 0) AS event_seq
      FROM governance_tool_events WHERE project = ?
    `).get(project) as { event_seq: number };
    return {
      result: payload.result as ShadowResult, reason: payload.reason as ShadowVerdictReason,
      ageEvents: Math.max(0, current.event_seq - eventSeq),
    };
  } catch {
    return null;
  }
}

export function loadGovernanceBriefing(db: Database.Database, options: {
  project: string;
  projectRoot: string;
  sessionId: string;
  clientName: string;
  clientInstallationId: string | null;
  nowMs?: number;
}): GovernanceBriefingSection | null {
  try {
    const rules = new GovernanceRuleRepository(db).activeByPhase(options.project, 'pre_exit');
    if (rules.length === 0 && !configPresent(options.projectRoot)) return null;
    const clientId = installationId(options.sessionId, options.clientInstallationId);
    const row = db.prepare(`
      SELECT * FROM governance_client_state
      WHERE project = ? AND client_installation_id = ?
    `).get(options.project, clientId) as ClientRow | undefined;
    const capability = resolveCapabilityStatus({
      row: capabilityRow(row), clientName: options.clientName,
      sessionId: options.sessionId, nowMs: options.nowMs,
    });
    return {
      rules: rules.slice(0, 3).map(rule => redactedRule(rule.content).slice(0, 120)),
      clientInScope: options.clientName === 'claude-code',
      capabilityReasons: capability.reasons.slice(0, 8),
      lastVerdict: lastVerdict(db, options.project),
    };
  } catch {
    return null;
  }
}
