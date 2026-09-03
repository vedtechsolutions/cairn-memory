/**
 * Branch-goal synthesizer — derive a human-readable project goal from a git
 * branch name and (optionally) the latest commit subject.
 *
 * This is the last-resort fallback for populating `project_goal` when no
 * active plan exists, the transcript has no non-meta user message, and no
 * prior snapshot has a sticky project_goal to carry forward.
 *
 * Branch naming conventions covered:
 *   - feat/primary-memory-integration → "Primary memory integration"
 *   - fix/login-race-condition        → "Login race condition"
 *   - chore/deps-bump                 → null (chore is infra, not a goal)
 *   - main / master / dev             → null (base branches aren't goals)
 *   - feature/add-dark-mode-toggle    → "Add dark mode toggle"
 *
 * When a non-trivial commit subject is available, the result is enriched:
 *   synthesizeBranchGoal('feat/user-auth', 'Add login flow')
 *     → "User auth — Add login flow"
 *
 * Returns null whenever the result would be too short (under
 * LIMITS.BRANCH_GOAL_MIN_CHARS) to carry
 * meaningful signal, or when the branch is a chore/base branch that doesn't
 * describe a goal. Callers can rely on a null return to skip the branch
 * fallback without additional checks.
 */
import { LIMITS } from '../constants/index.js';

/** Branch prefixes stripped during synthesis. These describe kind-of-work,
 *  not the work itself. */
const GOAL_BEARING_PREFIXES = new Set([
  'feat', 'feature', 'fix', 'bugfix', 'refactor', 'perf', 'improvement',
]);

/** Branches that are inherently not a goal (infrastructure / base). */
const NON_GOAL_BRANCHES = new Set([
  'main', 'master', 'dev', 'develop', 'staging', 'production', 'prod',
  'release', 'hotfix',
]);

/** Prefixes that signal infra work — not a user-visible goal. */
const NON_GOAL_PREFIXES = new Set([
  'chore', 'ci', 'build', 'deps', 'docs', 'style', 'test', 'tests',
]);

/** Commit subject prefixes that signal non-goal commits — strip before enriching. */
const SKIP_COMMIT_PATTERNS = [
  /^chore[(:]/i,
  /^ci[(:]/i,
  /^build[(:]/i,
  /^docs[(:]/i,
  /^style[(:]/i,
  /^test[(:]/i,
  /^merge\s/i,
  /^revert\s/i,
  /^wip\b/i,
];

/** Title-case the first word only; lower-case the rest so the output reads
 *  like a natural sentence start rather than Capitalized-Case-Every-Word. */
function sentenceCase(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  return trimmed[0].toUpperCase() + trimmed.slice(1).toLowerCase();
}

/** Strip a conventional-commit prefix like "feat(scope):" or "fix:" from a
 *  subject, returning the bare description. */
function stripConventionalPrefix(subject: string): string {
  return subject.replace(/^(\w+)(\([^)]*\))?:\s*/i, '').trim();
}

export interface BranchGoalOptions {
  /** Latest commit subject (from `git log -1 --pretty=%s`). Optional. */
  commitSubject?: string | null;
}

/**
 * Synthesize a project goal from a branch name (and optional commit subject).
 * Returns null when the branch is a base/chore branch or when the result is
 * too short to carry meaningful signal.
 */
export function synthesizeBranchGoal(
  branch: string | null | undefined,
  options: BranchGoalOptions = {},
): string | null {
  if (!branch) return null;

  const normalized = branch.trim().toLowerCase();
  if (NON_GOAL_BRANCHES.has(normalized)) return null;

  const slashIdx = normalized.indexOf('/');
  const prefix = slashIdx >= 0 ? normalized.slice(0, slashIdx) : '';
  const rest = slashIdx >= 0 ? normalized.slice(slashIdx + 1) : normalized;

  if (prefix && NON_GOAL_PREFIXES.has(prefix)) return null;

  // Flatten slashes + dashes + underscores into spaces. Multi-slash branches
  // like feat/api/rate-limit become "api rate limit".
  const words = rest
    .replace(/[/\-_.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (words.length === 0) return null;

  // If the branch has a known goal-bearing prefix, we keep the rest as-is.
  // If the prefix is unknown (e.g. bare branches like "user-auth"), we still
  // treat the whole thing as the goal body — better signal than nothing.
  const body = sentenceCase(words);

  let enriched = body;
  const subject = options.commitSubject?.trim() ?? null;
  if (subject && subject.length > 0) {
    const bareSubject = stripConventionalPrefix(subject);
    if (bareSubject.length > 0 && !SKIP_COMMIT_PATTERNS.some(p => p.test(subject))) {
      // Only enrich if the commit adds new info beyond the branch words.
      // This avoids "User auth — User auth added" redundancy.
      const bodyTokens = new Set(body.toLowerCase().split(/\s+/));
      const subjectTokens = bareSubject.toLowerCase().split(/\s+/);
      const novelTokens = subjectTokens.filter(t => t.length > 3 && !bodyTokens.has(t));
      if (novelTokens.length >= 1) {
        enriched = `${body} — ${bareSubject}`;
      }
    }
  }

  if (enriched.length < LIMITS.BRANCH_GOAL_MIN_CHARS) return null;
  if (enriched.length > LIMITS.BRANCH_GOAL_MAX_CHARS) {
    enriched = enriched.slice(0, LIMITS.BRANCH_GOAL_MAX_CHARS - 1) + '…';
  }

  // Mark the goal-bearing prefix status for callers that want to distinguish
  // high-confidence (feat/*) from best-effort (bare) synthesis. Currently
  // we return a single string; callers that need the prefix metadata can
  // call this helper directly and re-parse.
  // Preserve the prefix distinction by tagging the caller-side source label.
  void GOAL_BEARING_PREFIXES; // referenced for future use; keeps the set documented

  return enriched;
}
