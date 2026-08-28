import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { projectId } from '../utils/project-id.js';
import { CLAUDE_ADAPTER_VERSION } from './types.js';
import type { ShadowStopWireInput } from './shadow-stop.js';

export const CLAUDE_GOVERNANCE_SETTINGS_SOURCE = 'claude-settings:governance-gate';
const GOVERNANCE_GATE_ASYNC_PAIR_MAX_AGE_MS = 5_000;

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value : null;
}

function identity(input: ShadowStopWireInput): {
  project: string; sessionId: string; installationId: string; clientName: string; clientVersion: string | null;
} {
  const metadata = record(input.client_metadata);
  const sessionId = text(input.session_id);
  const rootInput = text(input.cwd);
  if (sessionId === null || rootInput === null) throw new Error('invalid governance Stop identity');
  const root = realpathSync.native(resolve(rootInput));
  const explicitInstallation = text(input.client_installation_id) ?? text(metadata.installation_id);
  return {
    project: projectId(root), sessionId,
    installationId: explicitInstallation ??
      `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}`,
    clientName: text(input.client_name) ?? text(metadata.name) ?? 'claude-code',
    clientVersion: text(input.client_version) ?? text(metadata.version),
  };
}

/** A request on the sync-only route proves structured Stop registration and its settings source. */
export function observeGovernanceGate(
  db: Database.Database,
  input: ShadowStopWireInput,
  occurredAt: string,
): void {
  const current = identity(input);
  db.prepare(`
    INSERT INTO governance_client_state (
      project, client_installation_id, client_name, client_version,
      supports_structured_output, supports_stop, supports_blocking, adapter_version,
      settings_source, last_session_id, last_heartbeat_at, last_probe_result
    ) VALUES (?, ?, ?, ?, 1, 1, 1, ?, ?, ?, ?, 'governance-gate-observation')
    ON CONFLICT(project, client_installation_id) DO UPDATE SET
      client_name = excluded.client_name,
      client_version = COALESCE(excluded.client_version, governance_client_state.client_version),
      supports_structured_output = 1, supports_stop = 1, supports_blocking = 1,
      adapter_version = excluded.adapter_version, settings_source = excluded.settings_source,
      last_session_id = excluded.last_session_id, last_heartbeat_at = excluded.last_heartbeat_at,
      last_probe_result = excluded.last_probe_result
  `).run(
    current.project, current.installationId, current.clientName, current.clientVersion,
    CLAUDE_ADAPTER_VERSION, CLAUDE_GOVERNANCE_SETTINGS_SOURCE, current.sessionId, occurredAt,
  );
}

/** The following async Stop removes stale sync capability when no paired gate request was observed. */
export function reconcileAsyncStopGovernanceCapability(
  db: Database.Database,
  input: ShadowStopWireInput,
  occurredAt: string,
): void {
  const current = identity(input);
  const row = db.prepare(`
    SELECT settings_source, supports_blocking, last_session_id, last_heartbeat_at, last_probe_result
    FROM governance_client_state WHERE project = ? AND client_installation_id = ?
  `).get(current.project, current.installationId) as {
    settings_source: string | null; supports_blocking: number | null;
    last_session_id: string | null; last_heartbeat_at: string | null; last_probe_result: string | null;
  } | undefined;
  if (!row || (row.settings_source !== CLAUDE_GOVERNANCE_SETTINGS_SOURCE && row.supports_blocking !== 1)) return;
  const observedMs = Date.parse(row.last_heartbeat_at ?? '');
  const paired = row.last_probe_result === 'governance-gate-observation' &&
    row.last_session_id === current.sessionId && Number.isFinite(observedMs) &&
    Date.parse(occurredAt) - observedMs >= 0 &&
    Date.parse(occurredAt) - observedMs <= GOVERNANCE_GATE_ASYNC_PAIR_MAX_AGE_MS;
  if (paired) return;
  db.prepare(`
    UPDATE governance_client_state SET supports_structured_output = 0,
      supports_blocking = 0, settings_source = NULL,
      last_probe_result = 'governance-gate-not-observed'
    WHERE project = ? AND client_installation_id = ?
  `).run(current.project, current.installationId);
}
