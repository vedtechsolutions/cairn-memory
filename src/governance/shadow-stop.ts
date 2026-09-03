import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { projectId } from '../utils/project-id.js';
import { GovernanceRepository } from './repository.js';
import {
  evaluateShadowStop, type ShadowEvaluationDiagnostic, type ShadowStopEvaluatorInput,
} from './shadow-evaluator.js';
import { CLAUDE_ADAPTER_VERSION } from './types.js';
import { reconcileAsyncStopGovernanceCapability } from './governance-client-observation.js';
import { isPlainObject } from '../utils/plain-object.js';

export interface ShadowStopWireInput {
  session_id: unknown;
  cwd: unknown;
  stop_hook_active: unknown;
  client_name?: unknown;
  client_version?: unknown;
  client_installation_id?: unknown;
  client_metadata?: unknown;
}

export interface ShadowStopFailOpenOptions {
  nowMs?: () => number;
  evaluate?: (
    db: Database.Database, input: ShadowStopEvaluatorInput,
  ) => Promise<ShadowEvaluationDiagnostic>;
}

function record(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function installationId(sessionId: string, explicit: string | null): string {
  if (explicit !== null) return explicit;
  if (sessionId.length === 0) return '';
  return `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 16)}`;
}

/** Build only the fields the evaluator is authorized to receive. */
export function shadowStopEvaluatorInput(input: ShadowStopWireInput): ShadowStopEvaluatorInput {
  const metadata = record(input.client_metadata);
  const sessionId = text(input.session_id) ?? '';
  return {
    sessionId,
    projectRoot: text(input.cwd) ?? '',
    clientName: text(input.client_name) ?? text(metadata.name) ?? 'claude-code',
    clientInstallationId: installationId(
      sessionId, text(input.client_installation_id) ?? text(metadata.installation_id),
    ),
    stopHookActive: input.stop_hook_active === true,
  };
}

/** Stop-safe entry: observation/evaluation failures never affect hook behavior. */
export async function evaluateShadowStopFailOpen(
  db: Database.Database,
  wireInput: ShadowStopWireInput,
  options: ShadowStopFailOpenOptions = {},
): Promise<ShadowEvaluationDiagnostic | null> {
  const evaluatorInput = shadowStopEvaluatorInput(wireInput);
  const metadata = record(wireInput.client_metadata);
  const occurredAt = new Date((options.nowMs ?? Date.now)()).toISOString();
  try {
    const root = realpathSync.native(resolve(evaluatorInput.projectRoot));
    reconcileAsyncStopGovernanceCapability(db, wireInput, occurredAt);
    new GovernanceRepository(db).observeStop({
      project: projectId(root), clientInstallationId: evaluatorInput.clientInstallationId,
      clientName: evaluatorInput.clientName,
      clientVersion: text(wireInput.client_version) ?? text(metadata.version),
      adapterVersion: CLAUDE_ADAPTER_VERSION, sessionId: evaluatorInput.sessionId, occurredAt,
    });
  } catch { /* best-effort observation */ }
  try {
    return await (options.evaluate ?? evaluateShadowStop)(db, evaluatorInput);
  } catch {
    return null;
  }
}
