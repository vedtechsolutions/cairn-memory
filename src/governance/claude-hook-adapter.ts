import { createHash } from 'node:crypto';
import {
  CLAUDE_ADAPTER_VERSION,
  type AdaptedClaudeEvent,
  type AdapterErrorEvent,
  type GovernanceHookEvent,
  type NormalizedClientMetadata,
  type NormalizedCommandInput,
  type NormalizedToolResult,
} from './types.js';

const SUPPORTED_TOOLS = new Set(['Bash', 'Write', 'Edit', 'MultiEdit']);
const HOOK_EVENTS = new Set<GovernanceHookEvent>([
  'PostToolUse', 'PostToolUseFailure', 'FileChanged',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  return typeof record[key] === 'string' ? record[key] : null;
}

function optionalString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === 'string' ? value : null;
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | null | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === 'boolean' ? value : null;
}

function optionalBooleanAny(
  record: Record<string, unknown>,
  ...keys: string[]
): boolean | null | undefined {
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue;
    return optionalBoolean(record, key);
  }
  return undefined;
}

function optionalInteger(record: Record<string, unknown>, ...keys: string[]): number | null | undefined {
  for (const key of keys) {
    const value = record[key];
    if (value === undefined) continue;
    return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
  }
  return undefined;
}

function normalizeText(text: string): string {
  return text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
}

function hashOutput(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('non-JSON hook value');
  return encoded;
}

function adapterError(
  reason: string,
  input?: Record<string, unknown>,
  hookEvent: GovernanceHookEvent | null = null,
): AdapterErrorEvent {
  const metadata = input !== undefined && isRecord(input.client_metadata)
    ? input.client_metadata : {};
  return {
    kind: 'adapter_error',
    adapterName: 'claude-code',
    adapterVersion: CLAUDE_ADAPTER_VERSION,
    clientName: input === undefined ? null : detectedClientName(input),
    clientVersion: input === undefined ? null
      : stringField(input, 'client_version') ?? stringField(metadata, 'version'),
    clientInstallationId: input === undefined ? null
      : stringField(input, 'client_installation_id') ?? stringField(metadata, 'installation_id'),
    sessionId: input === undefined ? null : stringField(input, 'session_id'),
    cwd: input === undefined ? null : stringField(input, 'cwd'),
    hookEvent,
    toolName: input === undefined ? null : stringField(input, 'tool_name'),
    toolUseId: input === undefined ? null : stringField(input, 'tool_use_id'),
    captureStatus: 'adapter_error',
    captureReason: reason,
  };
}

function detectedClientName(input: Record<string, unknown>): string | null {
  const flat = stringField(input, 'client_name');
  if (flat !== null) return flat;
  const metadata = input.client_metadata;
  return isRecord(metadata) ? stringField(metadata, 'name') : null;
}

function clientMetadata(input: Record<string, unknown>): NormalizedClientMetadata | null {
  const metadata = isRecord(input.client_metadata) ? input.client_metadata : {};
  const name = detectedClientName(input);
  if (name !== null && name !== 'claude-code') return null;
  const version = stringField(input, 'client_version') ?? stringField(metadata, 'version');
  const installationId = stringField(input, 'client_installation_id') ??
    stringField(metadata, 'installation_id');
  return { name: 'claude-code', version, installationId };
}

function hookEvent(input: Record<string, unknown>): GovernanceHookEvent | null {
  const explicit = input.hook_event_name;
  if (typeof explicit === 'string') {
    return HOOK_EVENTS.has(explicit as GovernanceHookEvent)
      ? explicit as GovernanceHookEvent
      : null;
  }
  if (Object.hasOwn(input, 'tool_response')) return 'PostToolUse';
  if (Object.hasOwn(input, 'error')) return 'PostToolUseFailure';
  if (Object.hasOwn(input, 'file_path') && !Object.hasOwn(input, 'tool_name')) return 'FileChanged';
  return null;
}

function commandInput(toolInput: Record<string, unknown>): NormalizedCommandInput | null | 'invalid' {
  const rawCommand = toolInput.command;
  if (rawCommand !== undefined && typeof rawCommand !== 'string') return 'invalid';
  const rawArgv = toolInput.argv;
  if (rawArgv !== undefined && (!Array.isArray(rawArgv) || rawArgv.length === 0 ||
      rawArgv.some(item => typeof item !== 'string' || item.includes('\0')))) {
    return 'invalid';
  }
  if (rawCommand === undefined && rawArgv === undefined) return null;
  if (typeof rawCommand === 'string' && rawCommand.includes('\0')) return 'invalid';
  return {
    shellCommand: typeof rawCommand === 'string' ? rawCommand : null,
    tokenizedArgv: Array.isArray(rawArgv) ? [...rawArgv] as string[] : null,
  };
}

function duration(input: Record<string, unknown>): number | null | 'invalid' {
  const value = optionalInteger(input, 'duration_ms');
  if (value === null || (typeof value === 'number' && value < 0)) return 'invalid';
  return value ?? null;
}

function structuredBashResult(
  response: Record<string, unknown>,
  durationMs: number | null,
): NormalizedToolResult | null {
  const hasStdout = Object.hasOwn(response, 'stdout');
  const hasStderr = Object.hasOwn(response, 'stderr');
  if (!hasStdout && !hasStderr) return null;
  if ((hasStdout && typeof response.stdout !== 'string') ||
      (hasStderr && typeof response.stderr !== 'string')) return null;
  const interrupted = optionalBoolean(response, 'interrupted');
  const timedOut = optionalBooleanAny(response, 'timed_out', 'timedOut');
  const exitCode = optionalInteger(response, 'exit_code', 'exitCode');
  const rawSignal = optionalString(response, 'signal');
  if (interrupted === null || interrupted === undefined || timedOut === null || exitCode === null ||
      rawSignal === null) return null;
  const stdout = normalizeText(typeof response.stdout === 'string' ? response.stdout : '');
  const stderr = normalizeText(typeof response.stderr === 'string' ? response.stderr : '');
  const outputText = stdout && stderr ? `${stdout}${stdout.endsWith('\n') ? '' : '\n'}${stderr}` : stdout || stderr;
  const isInterrupted = interrupted;
  const isTimedOut = timedOut ?? false;
  const signal = rawSignal ?? null;
  const normalizedExit = exitCode ?? (isInterrupted || isTimedOut || signal !== null ? null : 0);
  const outcome = isInterrupted || isTimedOut || signal !== null ||
    (normalizedExit !== null && normalizedExit !== 0)
    ? 'failure' as const
    : 'success' as const;
  return {
    outcome,
    exitCode: normalizedExit,
    signal,
    interrupted: isInterrupted,
    timedOut: isTimedOut,
    durationMs,
    outputSha256: hashOutput(outputText),
    outputText,
  };
}

function successResult(
  toolName: string,
  response: unknown,
  durationMs: number | null,
): NormalizedToolResult | null {
  if (typeof response === 'string') {
    const normalized = normalizeText(response);
    return {
      outcome: 'success', exitCode: toolName === 'Bash' ? 0 : null,
      signal: null, interrupted: false, timedOut: false, durationMs,
      outputSha256: hashOutput(normalized),
      outputText: toolName === 'Bash' ? normalized : '',
    };
  }
  if (!isRecord(response)) return null;
  if (toolName === 'Bash') return structuredBashResult(response, durationMs);
  const recognizedEditResponse = response.success === true ||
    typeof response.filePath === 'string' || typeof response.file_path === 'string' ||
    Array.isArray(response.structuredPatch);
  if (!recognizedEditResponse || response.success === false) return null;
  const normalized = canonicalJson(response);
  return {
    outcome: 'success', exitCode: null, signal: null, interrupted: false,
    timedOut: false, durationMs, outputSha256: hashOutput(normalized), outputText: '',
  };
}

function failureResult(
  input: Record<string, unknown>,
  durationMs: number | null,
): NormalizedToolResult | null {
  const error = optionalString(input, 'error');
  const exitCode = optionalInteger(input, 'exit_code', 'exitCode', 'exit_status');
  const interrupted = optionalBooleanAny(input, 'is_interrupt', 'interrupted');
  const timedOut = optionalBooleanAny(input, 'timed_out', 'timedOut');
  const signal = optionalString(input, 'signal');
  if (error === undefined || error === null || exitCode === null || interrupted === null ||
      timedOut === null || signal === null) return null;
  const outputText = normalizeText(error);
  return {
    outcome: exitCode === undefined ? 'unknown_failure' : 'failure',
    exitCode: exitCode ?? null,
    signal: signal ?? null,
    interrupted: interrupted ?? false,
    timedOut: timedOut ?? false,
    durationMs,
    outputSha256: hashOutput(outputText),
    outputText,
  };
}

/** Claude Code wire-shape boundary. It never throws and never infers unknown data. */
export function adaptClaudeHook(inputValue: unknown): AdaptedClaudeEvent {
  try {
    if (!isRecord(inputValue)) return adapterError('hook input must be an object');
    const event = hookEvent(inputValue);
    if (event === null) return adapterError('unsupported or missing hook event', inputValue);
    const client = clientMetadata(inputValue);
    if (client === null) return adapterError('unsupported client', inputValue, event);
    const sessionId = stringField(inputValue, 'session_id');
    const cwd = stringField(inputValue, 'cwd');
    if (!sessionId || !cwd || sessionId.includes('\0') || cwd.includes('\0')) {
      return adapterError('missing or invalid session_id/cwd', inputValue, event);
    }
    const rawToolUseId = optionalString(inputValue, 'tool_use_id');
    if (rawToolUseId === null) return adapterError('invalid tool_use_id', inputValue, event);
    if (rawToolUseId === '' || rawToolUseId?.includes('\0')) {
      return adapterError('invalid tool_use_id', inputValue, event);
    }
    const toolUseId = rawToolUseId ?? null;

    if (event === 'FileChanged') {
      const filePath = stringField(inputValue, 'file_path');
      if (!filePath || filePath.includes('\0')) {
        return adapterError('FileChanged requires a valid file_path', inputValue, event);
      }
      const fingerprint = optionalString(inputValue, 'delivery_fingerprint');
      if (fingerprint === null || fingerprint === '' || fingerprint?.includes('\0')) {
        return adapterError('invalid delivery_fingerprint', inputValue, event);
      }
      return {
        kind: 'file_changed', hookEvent: event,
        adapterName: 'claude-code', adapterVersion: CLAUDE_ADAPTER_VERSION,
        client, sessionId, cwd, toolUseId, filePath,
        deliveryFingerprint: fingerprint ?? null,
        captureStatus: 'complete', captureReason: null,
      };
    }

    const toolName = stringField(inputValue, 'tool_name');
    const toolInput = inputValue.tool_input;
    if (!toolName || !SUPPORTED_TOOLS.has(toolName) || !isRecord(toolInput)) {
      return adapterError('unsupported tool or invalid tool_input', inputValue, event);
    }
    const observedCommand = toolName === 'Bash' ? commandInput(toolInput) : null;
    if (observedCommand === 'invalid' || (toolName === 'Bash' && observedCommand === null)) {
      return adapterError('Bash requires a valid command or tokenized argv', inputValue, event);
    }
    const durationMs = duration(inputValue);
    if (durationMs === 'invalid') return adapterError('invalid duration_ms', inputValue, event);

    const result = event === 'PostToolUse'
      ? successResult(toolName, inputValue.tool_response, durationMs)
      : failureResult(inputValue, durationMs);
    if (result === null) return adapterError('unsupported tool result shape', inputValue, event);
    const incomplete = result.outcome === 'unknown_failure';
    return {
      kind: 'tool', hookEvent: event,
      adapterName: 'claude-code', adapterVersion: CLAUDE_ADAPTER_VERSION,
      client, sessionId, cwd, toolUseId, toolName, toolInput,
      command: observedCommand,
      result,
      captureStatus: incomplete ? 'incomplete' : 'complete',
      captureReason: incomplete ? 'failure omitted numeric exit status' : null,
    };
  } catch {
    return adapterError('unparseable hook input');
  }
}
