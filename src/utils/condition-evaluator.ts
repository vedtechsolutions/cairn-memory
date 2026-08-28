/**
 * Condition evaluator for conditional reminders.
 * Whitelist-based parser — no eval, no Function, no code execution.
 *
 * Two-tier syntax:
 *   Tier 1 (shorthand): tests_pass, branch:feature/*, file:auth.ts, step_done:3
 *   Tier 2 (composition): tests_pass AND file:auth.ts, branch:main OR branch:dev
 */

/** Runtime context assembled from hook inputs + session state */
export interface ConditionContext {
  branch: string | null;
  uncommitted_count: number;
  tool_name: string | null;
  file_path: string | null;
  command: string | null;
  tool_success: boolean | null;
  tests_pass: boolean;
  has_recent_errors: boolean;
  error_count: number;
  session_type: string | null;
  context_mode: string;
  plan_active: boolean;
  plan_complete: boolean;
  step_statuses: Record<number, string>;
}

/** Max condition length (safety bound) */
const MAX_CONDITION_LENGTH = 200;

// --- Shorthand evaluators (no parameters) -----------------------------------

const SHORTHANDS: Record<string, (ctx: ConditionContext) => boolean> = {
  tests_pass:    (ctx) => ctx.tests_pass,
  tests_fail:    (ctx) => ctx.has_recent_errors,
  build_ok:      (ctx) => ctx.tool_success === true,
  plan_active:   (ctx) => ctx.plan_active,
  plan_complete: (ctx) => ctx.plan_complete,
};

// --- Parameterized evaluators (prefix:value) --------------------------------

const PARAM_EVALUATORS: Record<string, (ctx: ConditionContext, value: string) => boolean> = {
  tool:        (ctx, v) => ctx.tool_name === v,
  file:        (ctx, v) => matchGlob(ctx.file_path, v),
  branch:      (ctx, v) => matchGlob(ctx.branch, v),
  step_done:   (ctx, v) => ctx.step_statuses[Number(v)] === 'done',
  step_active: (ctx, v) => ctx.step_statuses[Number(v)] === 'in_progress',
  mode:        (ctx, v) => ctx.context_mode === v,
  session:     (ctx, v) => ctx.session_type === v,
  error_count: (ctx, v) => {
    const match = v.match(/^(>=|>|==|=)?(\d+)$/);
    if (!match) return false;
    const op = match[1] ?? '>=';
    const threshold = Number(match[2]);
    if (op === '>' || op === '>=') return ctx.error_count >= threshold;
    return ctx.error_count === threshold;
  },
};

/** Evaluate a single atomic condition token */
function evalAtom(token: string, ctx: ConditionContext): boolean {
  const trimmed = token.trim().toLowerCase();

  // Check shorthand
  if (trimmed in SHORTHANDS) {
    return SHORTHANDS[trimmed](ctx);
  }

  // Check parameterized (prefix:value)
  const colonIdx = trimmed.indexOf(':');
  if (colonIdx > 0) {
    const prefix = trimmed.slice(0, colonIdx);
    const value = token.trim().slice(colonIdx + 1); // preserve original case for value
    if (Object.prototype.hasOwnProperty.call(PARAM_EVALUATORS, prefix)) {
      return PARAM_EVALUATORS[prefix](ctx, value);
    }
  }

  return false; // Unknown condition — fail closed
}

/**
 * Evaluate a condition expression.
 * Supports flat AND/OR/NOT composition (no parentheses).
 * Returns false for empty, invalid, or too-long expressions.
 */
export function evaluateCondition(expr: string, ctx: ConditionContext): boolean {
  if (!expr || expr.length > MAX_CONDITION_LENGTH) return false;

  // Split on AND/OR while preserving operators
  const parts = expr.split(/\s+(AND|OR)\s+/i);
  if (parts.length === 0) return false;

  let result = false;
  let op: 'AND' | 'OR' = 'OR';
  let first = true;

  for (const part of parts) {
    const upper = part.trim().toUpperCase();
    if (upper === 'AND' || upper === 'OR') {
      op = upper as 'AND' | 'OR';
      continue;
    }

    // Handle NOT prefix
    let negate = false;
    let atom = part.trim();
    if (atom.toUpperCase().startsWith('NOT ')) {
      negate = true;
      atom = atom.slice(4).trim();
    }

    let value = evalAtom(atom, ctx);
    if (negate) value = !value;

    if (first) {
      result = value;
      first = false;
    } else if (op === 'AND') {
      result = result && value;
    } else {
      result = result || value;
    }
  }

  return result;
}

/** Simple glob match: supports * wildcard */
function matchGlob(input: string | null, pattern: string): boolean {
  if (!input) return false;
  if (!pattern.includes('*')) {
    // Exact match or basename match
    return input === pattern || input.endsWith('/' + pattern) || input.endsWith(pattern);
  }
  // Convert glob to regex (only * is supported)
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$').test(input);
}

/** Build a default ConditionContext with empty/false values */
export function emptyConditionContext(): ConditionContext {
  return {
    branch: null,
    uncommitted_count: 0,
    tool_name: null,
    file_path: null,
    command: null,
    tool_success: null,
    tests_pass: false,
    has_recent_errors: false,
    error_count: 0,
    session_type: null,
    context_mode: 'normal',
    plan_active: false,
    plan_complete: false,
    step_statuses: {},
  };
}
