import type { CapabilityDegradationReason } from './verdict-types.js';

export const CAPABILITY_HEARTBEAT_MAX_AGE_MS = 30 * 60 * 1_000;
export const CAPABILITY_HEARTBEAT_FUTURE_SKEW_MS = 60 * 1_000;

export type CapabilityObservation =
  | 'observed'
  | 'unsupported'
  | 'not_observed'
  | 'available'
  | 'unavailable'
  | 'current'
  | 'stale';

export interface GovernanceClientCapabilityRow {
  project: string;
  clientInstallationId: string;
  clientName: string;
  clientVersion: string | null;
  supportsPostToolUse: boolean | null;
  supportsPostToolFailure: boolean | null;
  supportsFileChanged: boolean | null;
  supportsStructuredOutput: boolean | null;
  supportsStop: boolean | null;
  supportsBlocking: boolean | null;
  adapterVersion: number;
  settingsSource: string | null;
  lastSessionId: string | null;
  lastHeartbeatAt: string | null;
  lastProbeResult: string | null;
}

export interface CapabilityStatus {
  supportedClient: boolean;
  degraded: boolean;
  reasons: CapabilityDegradationReason[];
  observations: {
    postToolUse: CapabilityObservation;
    postToolFailure: CapabilityObservation;
    fileChanged: CapabilityObservation;
    structuredOutput: CapabilityObservation;
    stop: CapabilityObservation;
    blocking: CapabilityObservation;
    heartbeat: CapabilityObservation;
    settingsSource: CapabilityObservation;
  };
}

const REASON_PRIORITY: readonly CapabilityDegradationReason[] = [
  'unsupported_client',
  'stale_heartbeat',
  'missing_post_tool_use',
  'missing_post_tool_failure',
  'missing_file_changed',
  'missing_stop',
  'async_only_stop',
  'blocking_unavailable',
  'missing_settings_source',
];

function observation(value: boolean | null): CapabilityObservation {
  return value === true ? 'observed' : value === false ? 'unsupported' : 'not_observed';
}

function currentHeartbeat(options: {
  row: GovernanceClientCapabilityRow | null;
  sessionId: string;
  nowMs: number;
  currentStopObserved: boolean;
}): boolean {
  if (options.currentStopObserved) return true;
  if (options.row?.lastSessionId !== options.sessionId || options.row.lastHeartbeatAt === null) return false;
  const heartbeatMs = Date.parse(options.row.lastHeartbeatAt);
  if (!Number.isFinite(heartbeatMs)) return false;
  const age = options.nowMs - heartbeatMs;
  return age >= -CAPABILITY_HEARTBEAT_FUTURE_SKEW_MS &&
    age <= CAPABILITY_HEARTBEAT_MAX_AGE_MS;
}

/** Pure capability/degradation resolver. It never reads hook settings or infers unknown support. */
export function resolveCapabilityStatus(options: {
  row: GovernanceClientCapabilityRow | null;
  clientName: string;
  sessionId: string;
  nowMs?: number;
  currentStopObserved?: boolean;
}): CapabilityStatus {
  const nowMs = options.nowMs ?? Date.now();
  const currentStopObserved = options.currentStopObserved ?? false;
  const row = options.row;
  const supportedClient = options.clientName === 'claude-code' &&
    (row === null || row.clientName === 'claude-code');
  const heartbeatCurrent = currentHeartbeat({ row, sessionId: options.sessionId, nowMs, currentStopObserved });
  const stopObserved = currentStopObserved || row?.supportsStop === true;
  const reasons = new Set<CapabilityDegradationReason>();
  if (!supportedClient) reasons.add('unsupported_client');
  if (!heartbeatCurrent) reasons.add('stale_heartbeat');
  if (row?.supportsPostToolUse !== true) reasons.add('missing_post_tool_use');
  if (row?.supportsPostToolFailure !== true) reasons.add('missing_post_tool_failure');
  if (row?.supportsFileChanged !== true) reasons.add('missing_file_changed');
  if (!stopObserved) reasons.add('missing_stop');
  if (stopObserved && row?.supportsBlocking === false) reasons.add('async_only_stop');
  if (row?.supportsBlocking !== true) reasons.add('blocking_unavailable');
  if (row?.lastProbeResult === 'settings-source-missing') reasons.add('missing_settings_source');

  const orderedReasons = REASON_PRIORITY.filter(reason => reasons.has(reason));
  return {
    supportedClient,
    degraded: orderedReasons.length > 0,
    reasons: orderedReasons,
    observations: {
      postToolUse: observation(row?.supportsPostToolUse ?? null),
      postToolFailure: observation(row?.supportsPostToolFailure ?? null),
      fileChanged: observation(row?.supportsFileChanged ?? null),
      structuredOutput: observation(row?.supportsStructuredOutput ?? null),
      stop: currentStopObserved ? 'observed' : observation(row?.supportsStop ?? null),
      blocking: row?.supportsBlocking === true ? 'available' : 'unavailable',
      heartbeat: heartbeatCurrent ? 'current' : row?.lastHeartbeatAt === null || row === null
        ? 'not_observed' : 'stale',
      settingsSource: row?.settingsSource === null || row === null ? 'not_observed' : 'observed',
    },
  };
}
