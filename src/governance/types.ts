export const CLAUDE_ADAPTER_VERSION = 1;
export const NODE_TEST_PARSER_VERSION = 1;
export const EXIT_ONLY_PARSER_VERSION = 1;

export type GovernanceHookEvent = 'PostToolUse' | 'PostToolUseFailure' | 'FileChanged';
export type CaptureStatus = 'complete' | 'failed' | 'incomplete' | 'adapter_error';
export type ToolOutcome = 'success' | 'failure' | 'unknown_failure';
export type MutationClass = 'none' | 'scoped' | 'unknown';

export interface NormalizedClientMetadata {
  name: 'claude-code';
  version: string | null;
  installationId: string | null;
}

export interface NormalizedCommandInput {
  /** The observed shell string, when that was the client transport. */
  shellCommand: string | null;
  /** Preferred tokenized transport, when supplied by the client. */
  tokenizedArgv: string[] | null;
}

export interface NormalizedToolResult {
  outcome: ToolOutcome;
  exitCode: number | null;
  signal: string | null;
  interrupted: boolean;
  timedOut: boolean;
  durationMs: number | null;
  outputSha256: string;
  /** Ephemeral parser input. Gate 4 must never persist or log this field. */
  outputText: string;
}

interface NormalizedEventBase {
  adapterName: 'claude-code';
  adapterVersion: typeof CLAUDE_ADAPTER_VERSION;
  client: NormalizedClientMetadata;
  sessionId: string;
  cwd: string;
  toolUseId: string | null;
  captureStatus: Exclude<CaptureStatus, 'adapter_error'>;
  captureReason: string | null;
}

export interface NormalizedToolEvent extends NormalizedEventBase {
  kind: 'tool';
  hookEvent: 'PostToolUse' | 'PostToolUseFailure';
  toolName: string;
  /** Ephemeral classifier input. Recorder persistence must use normalized fields only. */
  toolInput: Record<string, unknown>;
  command: NormalizedCommandInput | null;
  result: NormalizedToolResult;
}

export interface NormalizedFileChangedEvent extends NormalizedEventBase {
  kind: 'file_changed';
  hookEvent: 'FileChanged';
  filePath: string;
  deliveryFingerprint: string | null;
}

export interface AdapterErrorEvent {
  kind: 'adapter_error';
  adapterName: 'claude-code';
  adapterVersion: typeof CLAUDE_ADAPTER_VERSION;
  clientName: string | null;
  clientVersion: string | null;
  clientInstallationId: string | null;
  sessionId: string | null;
  cwd: string | null;
  hookEvent: GovernanceHookEvent | null;
  toolName: string | null;
  toolUseId: string | null;
  captureStatus: 'adapter_error';
  captureReason: string;
}

export type AdaptedClaudeEvent =
  | NormalizedToolEvent
  | NormalizedFileChangedEvent
  | AdapterErrorEvent;

export interface ResultObservation {
  outcome: ToolOutcome;
  exitCode: number | null;
  signal: string | null;
  interrupted: boolean;
  timedOut: boolean;
  outputSha256: string;
  outputText: string;
}

export interface ParsedGateResult {
  parserName: 'node-test' | 'exit-only';
  parserVersion: number;
  captureResult: 'complete' | 'failed' | 'incomplete';
  reason: string | null;
  outputSha256: string;
  total: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  skipReasonsComplete: boolean | null;
}

export interface MutationClassification {
  mutationClass: MutationClass;
  affectedPaths: string[];
  allowlistVersion: number | null;
  reason: string;
}

export interface RecorderDiagnostic {
  status: 'recorded' | 'deduplicated' | 'ignored' | 'error';
  eventSeq: number | null;
  mutationSeq: number | null;
  gateRuns: number;
  /** Bounded internal reason code. Never contains hook output or tool input. */
  reason: string | null;
}
