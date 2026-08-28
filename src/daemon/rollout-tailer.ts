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
 * 3), and token-count enrichment (recorded follow-up).
 */
import { readdirSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type Database from 'better-sqlite3';
import type { CachedHookContext } from '../hooks/shared/db-client.js';
import type { PostToolUseInput } from '../hooks/shared/hook-io.js';
import { handleCodexPostTool, isToolSeen } from '../hooks/handlers/codex-post-tool-handler.js';
import { CLIENT_CODEX } from '../constants/clients.js';
import { ROLLOUT_TAILER } from '../constants/index.js';

interface FileState {
  offset: number;
  sessionId: string | null;
  cwd: string;
  /** Subagent/guardian or unparseable-meta files are skipped entirely. */
  skip: boolean;
}

interface TailerHandle { stop(): void; tick(): Promise<number>; }

function sessionsRoot(): string {
  return process.env.CAIRN_CODEX_SESSIONS_DIR ?? join(homedir(), '.codex', 'sessions');
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

/** First line of a rollout is session_meta — id, cwd, source (subagent). */
function readSessionMeta(path: string): Pick<FileState, 'sessionId' | 'cwd' | 'skip'> {
  try {
    const head = readRange(path, 0, Math.min(statSync(path).size, ROLLOUT_TAILER.META_READ_BYTES));
    const firstLine = head.slice(0, head.indexOf('\n'));
    const meta = JSON.parse(firstLine) as {
      payload?: { session_id?: string; id?: string; cwd?: string; source?: unknown };
    };
    const p = meta.payload ?? {};
    const isSubagent = p.source !== undefined && p.source !== null &&
      typeof p.source === 'object' && 'subagent' in (p.source as Record<string, unknown>);
    return {
      sessionId: p.session_id ?? p.id ?? null,
      cwd: p.cwd ?? process.cwd(),
      skip: isSubagent,
    };
  } catch {
    return { sessionId: null, cwd: process.cwd(), skip: true };
  }
}

function pruneMarkers(db: Database.Database): void {
  try {
    const cutoff = new Date(Date.now() - ROLLOUT_TAILER.MARKER_TTL_MS).toISOString();
    db.prepare(
      "DELETE FROM maintenance_meta WHERE key LIKE 'codex_seen:%' AND value < ?",
    ).run(cutoff);
  } catch { /* best-effort */ }
}

/**
 * Start the tailer loop. Returns a handle with stop() and a directly
 * awaitable tick() (used by tests; the interval calls the same tick).
 */
export function startRolloutTailer(client: CachedHookContext): TailerHandle {
  const files = new Map<string, FileState>();

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
        try { size = statSync(path).size; } catch { continue; }

        let state = files.get(path);
        if (!state) {
          // First sight: no historical backfill — start at current EOF.
          state = { offset: size, ...readSessionMeta(path) };
          files.set(path, state);
          continue;
        }
        if (state.skip || size <= state.offset) continue;

        let chunk: string;
        try { chunk = readRange(path, state.offset, size); } catch { continue; }
        // Only consume complete lines; a torn tail line stays for next tick.
        const lastNewline = chunk.lastIndexOf('\n');
        if (lastNewline < 0) continue;
        state.offset += lastNewline + 1;

        for (const line of chunk.slice(0, lastNewline).split('\n')) {
          const input = commandInputFromLine(line, path, state);
          if (!input) continue;
          if (isToolSeen(client.db, input.tool_use_id!)) continue; // hook path handled it
          try {
            await handleCodexPostTool(input, client);
            processed++;
          } catch { /* per-record fail-open */ }
        }
      }
    }
    pruneMarkers(client.db);
    return processed;
  }

  const interval = setInterval(() => {
    tick().catch((err) => console.error('[cairn] rollout-tailer tick failed:', err));
  }, ROLLOUT_TAILER.INTERVAL_MS);
  interval.unref();

  return { stop: () => clearInterval(interval), tick };
}

/** Parse one rollout line into a synthetic PostToolUseInput for the demux,
 *  or null if it is not a completed CommandExecution. */
function commandInputFromLine(
  line: string,
  transcriptPath: string,
  state: FileState,
): PostToolUseInput | null {
  if (!line.includes('CommandExecution') || !line.includes('item_completed')) return null;
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
  if (!item || item.type !== 'CommandExecution' || typeof item.id !== 'string') return null;
  const command = Array.isArray(item.command) ? (item.command as string[]).join(' ') : String(item.command ?? '');
  return {
    session_id: state.sessionId ?? 'codex-tailer-unknown-session',
    transcript_path: transcriptPath,
    cwd: state.cwd,
    hook_event_name: 'PostToolUse',
    client_name: CLIENT_CODEX,
    tool_name: 'Bash',
    tool_input: { command },
    tool_use_id: item.id,
    tool_response: String(item.aggregated_output ?? item.stdout ?? ''),
  };
}
