/**
 * View-side rendering (W4 v3.1 §8): contract line numbering (6-wide,
 * right-aligned, tab, 1-indexed), the 999,999-line limit, 16,000-char
 * truncation at the last whole line with a paging marker, view_range
 * validation, directory listings with human-readable sizes, and the plan
 * read-only rendering. Thrown messages carry no `Error: ` prefix (§9).
 */
import type { PlanRepository } from '../db/plan-repository.js';
import { ERR } from './errors.js';

export const MAX_VIEW_CHARS = 16_000;
export const MAX_FILE_LINES = 999_999;

export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${Math.max(bytes, 0)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/** Contract file view: header + numbered lines, honoring view_range and
 *  the truncation/paging rules. */
export function renderFileView(path: string, lines: readonly string[], viewRange?: [number, number]): string {
  if (lines.length > MAX_FILE_LINES) {
    throw new Error(ERR.lineLimitExceeded(path));
  }
  let start = 1;
  let end = lines.length;
  if (viewRange !== undefined) {
    const [a, b] = viewRange;
    // Ends beyond EOF are errors, not clamps — the only open end is -1.
    const valid = Number.isSafeInteger(a) && Number.isSafeInteger(b)
      && a >= 1 && a <= Math.max(lines.length, 1)
      && (b === -1 || (b >= a && b <= lines.length));
    if (!valid) {
      throw new Error(ERR.invalidViewRange(a, b, lines.length));
    }
    start = a;
    end = b === -1 ? lines.length : b;
  }

  const numbered: string[] = [];
  for (let i = start; i <= end; i++) {
    numbered.push(`${String(i).padStart(6, ' ')}\t${lines[i - 1]}`);
  }

  const header = `Here's the content of ${path} with line numbers:`;
  let body = numbered.join('\n');
  if (body.length > MAX_VIEW_CHARS) {
    // Keep whole lines only — zero if even the first exceeds the cap.
    let cut = numbered.length;
    let length = body.length;
    while (cut > 0 && length > MAX_VIEW_CHARS) {
      length -= numbered[cut - 1].length + 1;
      cut--;
    }
    const kept = numbered.slice(0, cut);
    kept.push(cut === 0
      ? `[view truncated — line ${start} alone exceeds the 16,000-character view limit]`
      : `[view truncated at line ${start + cut - 1} of ${lines.length} — use view_range to page]`);
    body = kept.join('\n');
  }
  return `${header}\n${body}`;
}

export interface ListingEntry {
  path: string;
  bytes: number;
}

/** Contract directory listing: header + size\tpath lines (the directory
 *  itself first), two levels deep, hidden items excluded by construction
 *  (the router never produces them). */
export function renderDirectoryListing(path: string, entries: readonly ListingEntry[]): string {
  const total = entries.reduce((sum, e) => sum + e.bytes, 0);
  const lines = [
    `Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items and node_modules:`,
    `${humanSize(total)}\t${path}`,
    ...entries.map(e => `${humanSize(e.bytes)}\t${e.path}`),
  ];
  return lines.join('\n');
}

/** Read-only plan.md rendering (repo-backed — deliberately token-less:
 *  plan lines carry no CAS tokens because plan.md rejects every edit). */
export function renderPlanLines(planRepo: PlanRepository, project: string): string[] | null {
  const plan = planRepo.getActive(project);
  if (!plan) return null;
  const lines = [
    `# Plan: ${plan.name} [${plan.status}]`,
    '(read-only — manage via the cairn_plan tool)',
  ];
  for (const step of plan.steps) {
    const marker = step.status === 'done' ? 'x' : step.status === 'in_progress' ? '~' : step.status === 'blocked' ? '!' : ' ';
    lines.push(`- [${marker}] ${step.step_id}. ${step.description}`);
  }
  return lines;
}
