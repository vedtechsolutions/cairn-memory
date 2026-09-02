/**
 * Codex rollout tailer — zero-config capture fallback (parity Slice B, D5).
 *
 * When Codex hooks are untrusted or disabled, tool outcomes still land in
 * the rollout JSONL under ~/.codex/sessions. This tailer watches for newly
 * appended `item_completed` CommandExecution records and feeds them through
 * the SAME demux the hook path uses (handleCodexPostTool re-reads the
 * rollout for ground truth, so both paths route identically).
 *
 * Dedup/quiesce: the demux writes a seen-marker per tool_use_id into
 * maintenance_meta on every routed event; the tailer skips marked ids —
 * so while hooks are live (markers appear within ms), the tailer is
 * naturally quiescent. Markers are pruned after MARKER_TTL_MS each tick.
 *
 * Deliberately NOT covered (documented): historical backfill (first sight
 * of a file starts at EOF), subagent/guardian threads, code-mode
 * custom_tool_call failures (no item_completed exists — research addendum
 * 3), token-count enrichment (recorded follow-up), and event timestamps —
 * routed tool events are stamped at routing time, up to one tick late, so
 * toolChain recency heuristics are advisory-skewed for tailed records.
 */
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CachedHookContext } from '../hooks/shared/db-client.js';
import type { PostToolUseInput } from '../hooks/shared/hook-io.js';
import { handleCodexPostTool, isToolSeen } from '../hooks/handlers/codex-post-tool-handler.js';
import type { RolloutToolRecord } from '../hooks/shared/rollout-lookup.js';
import { CLIENT_CODEX } from '../constants/clients.js';
import { ROLLOUT_LOOKUP, ROLLOUT_TAILER } from '../constants/index.js';
import { ENV } from '../constants/env.js';
import { log } from '../utils/log.js';

interface FileState {
  offset: number;
  sessionId: string | null;
  cwd: string;
  /** Subagent/guardian threads are skipped entirely. */
  skip: boolean;
  /** False while the session_meta first line is not yet readable (torn or
   *  zero-length file at first sight) — re-evaluated each tick until it
   *  resolves, so an early-sighted session is never permanently skipped. */
  metaResolved: boolean;
  /** Version-canary warning emitted once per file. */
  versionWarned: boolean;
}

interface TailerHandle { stop(): void; tick(): Promise<number>; }

function sessionsRoot(): string {
  return process.env[ENV.CODEX_SESSIONS_DIR] ?? join(homedir(), '.codex', 'sessions');
}

/** Today's and yesterday's date dirs — covers the midnight straddle without
 *  walking the whole history tree. LOCAL dates: Codex names these dirs from
 *  local time (observed: rollout-2026-08-28T09-48-… under 2026/08/28 EST). */
function recentDateDirs(root: string): string[] {
  const dirs: string[] = [];
  for (const daysAgo of [0, 1]) {
    const d = new Date(Date.now() - daysAgo * 86_400_000);
    const y = String(d.getFullYear());
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    dirs.push(join(root, y, m, day));
  }
  return dirs.filter(existsSync);
}

function readRange(path: string, start: number, end: number): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(end - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

/** First line of a rollout is session_meta — id, cwd, source (subagent).
 *  metaResolved:false means "not readable YET" (empty/torn first line);
 *  the tailer retries it every tick rather than skipping the session. */
function readSessionMeta(path: string): Pick<FileState, 'sessionId' | 'cwd' | 'skip' | 'metaResolved'> & { cliVersion: string | null } {
  const unresolved = { sessionId: null, cwd: process.cwd(), skip: false, metaResolved: false, cliVersion: null };
  try {
    const head = readRange(path, 0, Math.min(statSync(path).size, ROLLOUT_TAILER.META_READ_BYTES));
    const newlineAt = head.indexOf('\n');
    if (newlineAt < 0) return unresolved;
    const meta = JSON.parse(head.slice(0, newlineAt)) as {
      payload?: { session_id?: string; id?: string; cwd?: string; source?: unknown; cli_version?: string };
    };
    const p = meta.payload ?? {};
    const isSubagent = p.source !== undefined && p.source !== null &&
      typeof p.source === 'object' && 'subagent' in (p.source as Record<string, unknown>);
    return {
      sessionId: p.session_id ?? p.id ?? null,
      cwd: p.cwd ?? process.cwd(),
      skip: isSubagent,
      metaResolved: true,
      cliVersion: typeof p.cli_version === 'string' ? p.cli_version : null,
    };
  } catch {
    return unresolved;
  }
}

/** D5's version canary: unknown Codex versions still parse (item_completed
 *  pinning is the real guard) but say so once, so a format change after a
 *  Codex upgrade shows up in logs instead of as silent capture loss. */
function warnVersionOnce(state: FileState, cliVersion: string | null, path: string): void {
  if (state.versionWarned) return;
  // A MISSING version is as canary-worthy as an unfamiliar one — every
  // known rollout carries cli_version, so its absence implies a format
  // change too.
  if (cliVersion === null || !cliVersion.startsWith(ROLLOUT_TAILER.KNOWN_CLI_PREFIX)) {
    log.warn(`rollout-tailer: ${path} written by codex ${cliVersion ?? '(no cli_version)'} (validated against ${ROLLOUT_TAILER.KNOWN_CLI_PREFIX}x) — parsing continues; verify capture after codex upgrades`);
  }
  state.versionWarned = true;
}

/**
 * Start the tailer loop. Returns a handle with stop() and a directly
 * awaitable tick() (used by tests; the interval calls the same tick).
 */
export function startRolloutTailer(
  client: CachedHookContext,
  /** birthtimeSlackMs override is a TEST lever: birthtimes cannot be
   *  backdated, so a test simulating a pre-existing file passes a large
   *  negative slack to force the pre-start classification. */
  opts: { birthtimeSlackMs?: number } = {},
): TailerHandle {
  const files = new Map<string, FileState>();
  const startedAtMs = Date.now();
  const birthtimeSlackMs = opts.birthtimeSlackMs ?? ROLLOUT_TAILER.BIRTHTIME_SLACK_MS;

  async function tick(): Promise<number> {
    let processed = 0;
    const root = sessionsRoot();
    for (const dir of recentDateDirs(root)) {
      let names: string[];
      try {
        names = readdirSync(dir).filter((n) => n.startsWith('rollout-') && n.endsWith('.jsonl'));
      } catch { continue; }
      for (const name of names) {
        const path = join(dir, name);
        let size: number;
        let bornAfterStart = false;
        try {
          const st = statSync(path);
          size = st.size;
          // birthtime 0 (filesystem without it) safely reads as pre-start.
          // The slack absorbs the coarse-clock lag birthtimes carry.
          bornAfterStart = st.birthtimeMs >= startedAtMs - birthtimeSlackMs;
        } catch { continue; }

        let state = files.get(path);
        if (!state) {
          // First sight. No-backfill applies to files that PREDATE the
          // tailer (their history was another lifetime's business); a file
          // born after we started has no such history — begin at 0, so a
          // brand-new session's first commands are not lost to poll timing.
          const meta = readSessionMeta(path);
          state = { offset: bornAfterStart ? 0 : size, versionWarned: false, ...meta };
          files.set(path, state);
          warnVersionOnce(state, meta.cliVersion, path);
          if (!bornAfterStart) continue;
        }
        if (!state.metaResolved) {
          // Retry the meta read without advancing the offset — the session
          // must not be permanently skipped just because the tailer saw the
          // file before Codex flushed the first line.
          const meta = readSessionMeta(path);
          Object.assign(state, meta);
          if (!state.metaResolved) continue;
          warnVersionOnce(state, meta.cliVersion, path);
        }
        if (state.skip || size <= state.offset) continue;

        let chunk: string;
        try { chunk = readRange(path, state.offset, size); } catch { continue; }
        // Only consume complete lines; a torn tail line stays for next tick.
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline < 0) continue;
        state.offset += lastNewline + 1;

        for (const line of chunk.slice(0, lastNewline).split('\n')) {
          const parsedLine = toolEventFromLine(line, path, state);
          if (!parsedLine) continue;
          if (isToolSeen(client.db, parsedLine.input.tool_use_id!)) continue; // hook path handled it
          try {
            // Pass the record we ALREADY parsed — a fresh tail lookup at
            // current EOF could have been outrun by this very tick's data.
            await handleCodexPostTool(parsedLine.input, client, parsedLine.record);
            processed++;
          } catch { /* per-record fail-open */ }
        }
      }
    }
    return processed;
  }

  const interval = setInterval(() => {
    tick().catch((err) => log.error('rollout-tailer tick failed:', err));
  }, ROLLOUT_TAILER.INTERVAL_MS);
  interval.unref();

  return { stop: () => clearInterval(interval), tick };
}

/** Parse one rollout line into a demux-ready (input, record) pair, or null
 *  if it is not a completed CommandExecution/FileChange. The record carries
 *  the outcome truth so the demux never re-reads the file on this path. */
function toolEventFromLine(
  line: string,
  transcriptPath: string,
  state: FileState,
): { input: PostToolUseInput; record: RolloutToolRecord } | null {
  if (!line.includes('item_completed')) return null;
  const isCommand = line.includes('CommandExecution');
  if (!isCommand && !line.includes('FileChange')) return null;
  let parsed: {
    payload?: {
      type?: string;
      item?: { item?: Record<string, unknown> } & Record<string, unknown>;
    };
  };
  try { parsed = JSON.parse(line); } catch { return null; }
  const payload = parsed.payload;
  if (!payload || payload.type !== 'item_completed') return null;
  const item = (payload.item?.item ?? payload.item) as Record<string, unknown> | undefined;
  if (!item || typeof item.id !== 'string') return null;
  if (item.type !== 'CommandExecution' && item.type !== 'FileChange') return null;

  // Same cap the lookup path applies — oversized text would fail memory
  // validation downstream and silently drop the record.
  const outputText = String(item.aggregated_output ?? item.stdout ?? item.stderr ?? '')
    .slice(0, ROLLOUT_LOOKUP.OUTPUT_MAX_CHARS);
  const record: RolloutToolRecord = {
    kind: item.type === 'CommandExecution' ? 'command' : 'file_change',
    status: String(item.status ?? 'unknown'),
    exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
    outputText,
  };
  const command = Array.isArray(item.command) ? (item.command as string[]).join(' ') : String(item.command ?? '');
  return {
    record,
    input: {
      session_id: state.sessionId ?? 'codex-tailer-unknown-session',
      transcript_path: transcriptPath,
      cwd: state.cwd,
      hook_event_name: 'PostToolUse',
      client_name: CLIENT_CODEX,
      tool_name: record.kind === 'command' ? 'Bash' : 'apply_patch',
      tool_input: { command },
      tool_use_id: item.id,
      tool_response: outputText,
    },
  };
}
