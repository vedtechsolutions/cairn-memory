/**
 * Codex rollout lookup — ground-truth tool outcomes for the PostToolUse demux.
 *
 * Codex hook payloads carry NO failure signal for shell commands (verified
 * live: a failed `exit 3` run produces plain output text). The rollout JSONL
 * that `transcript_path` points at DOES: `item_completed` items of type
 * CommandExecution / FileChange carry status, exit_code, and merged output,
 * land before the hook fires (102 ms in the live sample), and join exactly
 * on rollout item id === hook tool_use_id. Ordering is observed, not
 * contractual — hence the bounded retry.
 */
import { existsSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { ROLLOUT_LOOKUP } from '../../constants/index.js';

export interface RolloutToolRecord {
  kind: 'command' | 'file_change';
  status: string;
  exitCode: number | null;
  /** Merged output text (Codex merges streams; stderr is usually empty and
   *  the text lands in aggregated_output/stdout). */
  outputText: string;
}

interface RolloutItem {
  id?: string;
  type?: string;
  status?: string;
  exit_code?: number;
  aggregated_output?: string;
  stdout?: string;
  stderr?: string;
}

/** Read the tail of a rollout file (items append; the record for a
 *  just-completed tool call is near the end). */
function readTail(path: string): string {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - ROLLOUT_LOOKUP.TAIL_BYTES);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf-8');
  } finally {
    closeSync(fd);
  }
}

function scanForRecord(text: string, toolUseId: string): RolloutToolRecord | null {
  const lines = text.split('\n');
  // Newest last — scan backwards, cheap substring pre-filter before JSON.parse.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes(toolUseId)) continue;
    let parsed: { payload?: { type?: string; item?: { item?: RolloutItem } & RolloutItem } };
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // torn tail line mid-write, or the truncated first line of the tail window
    }
    const payload = parsed.payload;
    if (!payload || payload.type !== 'item_completed') continue;
    // item_completed nests the record as payload.item.item in current
    // rollouts; tolerate the unnested shape too.
    const item: RolloutItem | undefined = payload.item?.item ?? payload.item;
    if (!item || item.id !== toolUseId) continue;
    if (item.type === 'CommandExecution' || item.type === 'FileChange') {
      return {
        kind: item.type === 'CommandExecution' ? 'command' : 'file_change',
        status: item.status ?? 'unknown',
        exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
        outputText: (item.aggregated_output || item.stdout || item.stderr || '').slice(0, ROLLOUT_LOOKUP.OUTPUT_MAX_CHARS),
      };
    }
  }
  return null;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Find the rollout record for a tool call, retrying briefly in case the
 * hook fired before the rollout writer flushed. Null on any failure —
 * callers must treat null as OUTCOME UNKNOWN, never as success.
 */
export async function findRolloutToolRecord(
  transcriptPath: string | null | undefined,
  toolUseId: string | undefined,
): Promise<RolloutToolRecord | null> {
  if (!transcriptPath || !toolUseId) return null;
  for (let attempt = 0; attempt < ROLLOUT_LOOKUP.MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(ROLLOUT_LOOKUP.RETRY_DELAY_MS);
    try {
      if (!existsSync(transcriptPath)) continue;
      const record = scanForRecord(readTail(transcriptPath), toolUseId);
      if (record) return record;
    } catch {
      // unreadable file this attempt — retry, then give up as unknown
    }
  }
  return null;
}
