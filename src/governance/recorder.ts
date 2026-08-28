import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import { adaptClaudeHook } from './claude-hook-adapter.js';
import { matchGateCommand, tokenizeSimpleCommand } from './command-match.js';
import { loadGateConfig, type LoadedGateConfig } from './gate-config.js';
import { classifyMutation } from './mutation-classifier.js';
import { parseGateResult } from './result-parser.js';
import { redactArgv } from './redaction.js';
import {
  GovernanceRepository, type GovernanceGateRunInsert, type GovernanceToolEventInsert,
} from './repository.js';
import {
  captureWorktreeDigestV2, WORKTREE_DIGEST_HARD_CEILING_MS,
  type WorktreeDigestV2Result,
} from './worktree-digest.js';
import { projectId } from '../utils/project-id.js';
import { GOVERNANCE } from '../constants/index.js';
import type {
  AdaptedClaudeEvent, NormalizedToolEvent, RecorderDiagnostic,
} from './types.js';

export interface RecordGovernanceOptions {
  nowMs?: number;
  environment?: NodeJS.ProcessEnv;
  /** Test-only transaction fault point. */
  failAfterEventInsert?: boolean;
}

const MAX_INTERNAL_REASON_CHARS = 240;

/**
 * Whether to persist the full, unredacted shell command line. Default OFF —
 * raw commands can carry inline secrets and the DB is a local unencrypted
 * file. The redacted form and SHA-256 are always stored for correlation; only
 * the plaintext is gated. Never affects sync/export, which exclude the column
 * unconditionally. Fail-safe parse: only an explicit "1"/"true" opts in.
 */
function shouldPersistRawCommand(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[GOVERNANCE.PERSIST_RAW_COMMAND_ENV];
  return value === '1' || value === 'true';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeReason(reason: string): string {
  return reason.replace(/[\r\n\t]+/gu, ' ').slice(0, MAX_INTERNAL_REASON_CHARS);
}

function findProjectRoot(cwd: string): string {
  let cursor = realpathSync.native(resolve(cwd));
  const filesystemRoot = parse(cursor).root;
  while (true) {
    if (existsSync(join(cursor, '.cairn', 'gates.json'))) return cursor;
    if (cursor === filesystemRoot) return realpathSync.native(resolve(cwd));
    cursor = dirname(cursor);
  }
}

function commandArgv(event: NormalizedToolEvent): string[] | null {
  if (event.command?.tokenizedArgv !== null && event.command?.tokenizedArgv !== undefined) {
    return [...event.command.tokenizedArgv];
  }
  if (event.command?.shellCommand === null || event.command?.shellCommand === undefined) return null;
  const parsed = tokenizeSimpleCommand(event.command.shellCommand);
  return parsed.ok ? parsed.argv : null;
}

function shellQuote(argument: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(argument)
    ? argument
    : `'${argument.replaceAll("'", "'\\''")}'`;
}

function observedEnvironment(event: NormalizedToolEvent): Record<string, string | undefined> | undefined {
  const raw = event.toolInput.environment ?? event.toolInput.env;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const environment: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string') environment[name] = value;
  }
  return environment;
}

function relevantPaths(config: LoadedGateConfig, gateId: string): string[] {
  const paths = config.config.pathRules
    .filter(rule => rule.require.includes(gateId))
    .flatMap(rule => rule.paths);
  return paths.length > 0 ? [...new Set(paths)].sort() : ['**'];
}

function installationId(event: AdaptedClaudeEvent): string {
  if (event.kind === 'adapter_error') {
    return event.clientInstallationId ?? `session-${sha256(event.sessionId ?? 'unknown').slice(0, 16)}`;
  }
  return event.client.installationId ?? `session-${sha256(event.sessionId).slice(0, 16)}`;
}

function eventTimes(nowMs: number, durationMs: number | null): {
  receivedAt: string; startedAt: string | null; endedAt: string;
} {
  return {
    receivedAt: new Date(nowMs).toISOString(),
    startedAt: durationMs === null ? null : new Date(Math.max(0, nowMs - durationMs)).toISOString(),
    endedAt: new Date(nowMs).toISOString(),
  };
}

function adapterErrorInsert(
  adapted: Extract<AdaptedClaudeEvent, { kind: 'adapter_error' }>,
  root: string,
  nowMs: number,
): GovernanceToolEventInsert | null {
  if (adapted.sessionId === null || adapted.hookEvent === null || adapted.cwd === null) return null;
  const timestamp = new Date(nowMs).toISOString();
  return {
    project: projectId(root), canonicalRoot: root, sessionId: adapted.sessionId,
    clientName: adapted.clientName ?? 'unknown', clientVersion: adapted.clientVersion,
    clientInstallationId: installationId(adapted), hookEvent: adapted.hookEvent,
    toolName: adapted.toolName, toolUseId: adapted.toolUseId, deliveryFingerprint: null,
    receivedAt: timestamp, startedAt: null, endedAt: timestamp, durationMs: null,
    rawCommand: null, redactedCommand: null, commandSha256: null, cwd: adapted.cwd,
    normalizedArgv: null, outcome: 'unknown_failure', exitCode: null, signal: null,
    interrupted: false, timedOut: false, outputSha256: null,
    redactedDiagnostic: safeReason(adapted.captureReason), mutationClass: 'unknown',
    affectedPaths: [], adapterName: adapted.adapterName, adapterVersion: adapted.adapterVersion,
    captureStatus: 'adapter_error', captureReason: safeReason(adapted.captureReason),
    observedStructuredOutput: null,
  };
}

function loadConfig(root: string): { loaded: LoadedGateConfig | null; error: string | null } {
  if (!existsSync(join(root, '.cairn', 'gates.json'))) return { loaded: null, error: null };
  try {
    return { loaded: loadGateConfig(root), error: null };
  } catch {
    return { loaded: null, error: 'gate_config_error' };
  }
}

async function matchingGateRuns(
  event: NormalizedToolEvent,
  root: string,
  config: LoadedGateConfig | null,
  environment: NodeJS.ProcessEnv,
): Promise<GovernanceGateRunInsert[]> {
  if (event.toolName !== 'Bash' || event.command === null || config === null) return [];
  const observedArgv = commandArgv(event);
  const observed = {
    ...(observedArgv === null ? { command: event.command.shellCommand ?? undefined } : { argv: observedArgv }),
    cwd: event.cwd,
    environment: observedEnvironment(event),
  };
  const expectedEnvironment: Record<string, string | undefined> = {};
  for (const name of new Set(Object.values(config.config.gates).flatMap(gate => gate.envNames))) {
    expectedEnvironment[name] = environment[name];
  }
  const candidates: Array<{
    gateId: string;
    parsed: ReturnType<typeof parseGateResult>;
    paths: string[];
  }> = [];
  for (const [gateId, gate] of Object.entries(config.config.gates)) {
    const matched = matchGateCommand(observed, gate, {
      projectRoot: root, expectedEnvironment,
    });
    if (!matched.matched) continue;
    const parsed = parseGateResult(event.result, {
      parser: gate.parser,
      gateKind: gate.parser === 'node-test' ? 'test' : 'command',
      skips: gate.skips,
    });
    const paths = relevantPaths(config, gateId);
    candidates.push({ gateId, parsed, paths });
  }
  const deadlineMs = performance.now() + WORKTREE_DIGEST_HARD_CEILING_MS;
  const digestCache = new Map<string, Promise<WorktreeDigestV2Result>>();
  for (const candidate of candidates) {
    const cacheKey = JSON.stringify(candidate.paths);
    if (!digestCache.has(cacheKey)) {
      digestCache.set(cacheKey, captureWorktreeDigestV2({
        projectRoot: root, relevantPaths: candidate.paths,
        configSha256: config.sha256, deadlineMs,
      }));
    }
  }
  return Promise.all(candidates.map(async ({ gateId, parsed, paths }) => {
    const digest = await digestCache.get(JSON.stringify(paths))!;
    const captureResult = digest.status === 'incomplete' ? 'incomplete' : parsed.captureResult;
    return {
      gateId, ruleId: null, ruleRevision: null,
      configVersion: config.config.version, configSha256: config.sha256,
      parserName: parsed.parserName, parserVersion: parsed.parserVersion,
      testTotal: parsed.total, testPass: parsed.passed, testFail: parsed.failed,
      testSkip: parsed.skipped, skipReasonsComplete: parsed.skipReasonsComplete,
      worktreeDigest: digest.digest, digestVersion: digest.version,
      relevantPathsSha256: digest.relevantPathsSha256, captureResult,
      incidentReason: captureResult === 'incomplete'
        ? safeReason(digest.reason ?? parsed.reason ?? 'incomplete gate capture') : null,
    } satisfies GovernanceGateRunInsert;
  }));
}

/** Record one supported hook event. This function may throw; handlers use the fail-open wrapper. */
export async function recordGovernanceEvent(
  db: Database.Database,
  wireInput: unknown,
  options: RecordGovernanceOptions = {},
): Promise<RecorderDiagnostic> {
  const adapted = adaptClaudeHook(wireInput);
  const rawCwd = adapted.cwd;
  if (rawCwd === null) {
    return { status: 'ignored', eventSeq: null, mutationSeq: null, gateRuns: 0, reason: 'missing_cwd' };
  }
  const root = findProjectRoot(rawCwd);
  const nowMs = options.nowMs ?? Date.now();
  if (adapted.kind === 'adapter_error') {
    const event = adapterErrorInsert(adapted, root, nowMs);
    if (event === null) {
      return {
        status: 'ignored', eventSeq: null, mutationSeq: null, gateRuns: 0,
        reason: 'adapter_error_missing_identity',
      };
    }
    const result = new GovernanceRepository(db).record({
      event, gateRuns: [], evidenceDays: 30,
      failAfterEventInsert: options.failAfterEventInsert,
    });
    return { ...result, reason: event.captureReason };
  }

  const mutation = classifyMutation(adapted);
  const configResult = loadConfig(root);
  const durationMs = adapted.kind === 'tool' ? adapted.result.durationMs : null;
  const times = eventTimes(nowMs, durationMs);
  let rawCommand: string | null = null;
  let redactedCommand: string | null = null;
  let commandSha256: string | null = null;
  let normalizedArgv: string | null = null;
  if (adapted.kind === 'tool' && adapted.command !== null) {
    const argv = commandArgv(adapted);
    const fullCommand = adapted.command.shellCommand ??
      (adapted.command.tokenizedArgv === null ? null : JSON.stringify(adapted.command.tokenizedArgv));
    // Persist the plaintext only when explicitly opted in; the SHA-256 below
    // (derived from the full command) preserves correlation either way.
    rawCommand = shouldPersistRawCommand(options.environment ?? process.env) ? fullCommand : null;
    const commandIdentity = adapted.command.shellCommand ?? JSON.stringify(adapted.command.tokenizedArgv);
    commandSha256 = sha256(commandIdentity);
    if (argv !== null) {
      const redacted = redactArgv(argv);
      normalizedArgv = JSON.stringify(redacted);
      redactedCommand = redacted.map(shellQuote).join(' ');
    } else {
      redactedCommand = '[UNPARSEABLE COMMAND]';
    }
  }
  const captureReason = configResult.error ?? adapted.captureReason;
  const event: GovernanceToolEventInsert = adapted.kind === 'tool' ? {
    project: projectId(root), canonicalRoot: root, sessionId: adapted.sessionId,
    clientName: adapted.client.name, clientVersion: adapted.client.version,
    clientInstallationId: installationId(adapted), hookEvent: adapted.hookEvent,
    toolName: adapted.toolName, toolUseId: adapted.toolUseId, deliveryFingerprint: null,
    ...times, durationMs, rawCommand, redactedCommand, commandSha256,
    cwd: adapted.cwd, normalizedArgv, outcome: adapted.result.outcome,
    exitCode: adapted.result.exitCode, signal: adapted.result.signal,
    interrupted: adapted.result.interrupted, timedOut: adapted.result.timedOut,
    outputSha256: adapted.result.outputSha256,
    redactedDiagnostic: captureReason === null ? null : safeReason(captureReason),
    mutationClass: mutation.mutationClass, affectedPaths: mutation.affectedPaths,
    adapterName: adapted.adapterName, adapterVersion: adapted.adapterVersion,
    captureStatus: configResult.error === null ? adapted.captureStatus : 'incomplete',
    captureReason: captureReason === null ? null : safeReason(captureReason),
    observedStructuredOutput: adapted.hookEvent === 'PostToolUse'
      ? typeof (wireInput as { tool_response?: unknown }).tool_response === 'object' : null,
  } : {
    project: projectId(root), canonicalRoot: root, sessionId: adapted.sessionId,
    clientName: adapted.client.name, clientVersion: adapted.client.version,
    clientInstallationId: installationId(adapted), hookEvent: adapted.hookEvent,
    toolName: null, toolUseId: adapted.toolUseId,
    deliveryFingerprint: adapted.deliveryFingerprint ?? (adapted.toolUseId === null ? null : sha256(
      `${adapted.client.name}\0${adapted.sessionId}\0${adapted.toolUseId}\0${mutation.affectedPaths.join('\0')}`,
    )),
    ...times, durationMs: null, rawCommand: null, redactedCommand: null,
    commandSha256: null, cwd: adapted.cwd, normalizedArgv: null,
    outcome: 'success', exitCode: null, signal: null, interrupted: false, timedOut: false,
    outputSha256: null, redactedDiagnostic: captureReason === null ? null : safeReason(captureReason),
    mutationClass: mutation.mutationClass, affectedPaths: mutation.affectedPaths,
    adapterName: adapted.adapterName, adapterVersion: adapted.adapterVersion,
    captureStatus: configResult.error === null ? adapted.captureStatus : 'incomplete',
    captureReason: captureReason === null ? null : safeReason(captureReason),
    observedStructuredOutput: null,
  };
  const gateRuns = adapted.kind === 'tool'
    ? await matchingGateRuns(adapted, root, configResult.loaded, options.environment ?? process.env)
    : [];
  const result = new GovernanceRepository(db).record({
    event, gateRuns,
    evidenceDays: configResult.loaded?.config.defaults.retention.evidenceDays ?? 30,
    failAfterEventInsert: options.failAfterEventInsert,
  });
  return { ...result, reason: captureReason };
}

/** Hook-safe entry: never logs hook material and never changes business output. */
export async function recordGovernanceEventFailOpen(
  db: Database.Database,
  wireInput: unknown,
  options: RecordGovernanceOptions = {},
): Promise<RecorderDiagnostic> {
  try {
    return await recordGovernanceEvent(db, wireInput, options);
  } catch {
    return {
      status: 'error', eventSeq: null, mutationSeq: null, gateRuns: 0,
      reason: 'governance_recorder_error',
    };
  }
}
