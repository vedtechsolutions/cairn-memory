import {
  MEMORY_KINDS,
  LEARNABLE_KINDS,
  MEMORY_SOURCES,
  PLAN_STATUSES,
  STEP_STATUSES,
  LIMITS,
  TOKEN_BUDGET,
  type MemoryKind,
  type LearnableKind,
  type MemorySource,
  type PlanStatus,
  type StepStatus,
} from '../constants/index.js';

// --- Type Guards ------------------------------------------------------------

export function isMemoryKind(v: string): v is MemoryKind {
  return (MEMORY_KINDS as readonly string[]).includes(v);
}

export function isLearnableKind(v: string): v is LearnableKind {
  return (LEARNABLE_KINDS as readonly string[]).includes(v);
}

export function isMemorySource(v: string): v is MemorySource {
  return (MEMORY_SOURCES as readonly string[]).includes(v);
}

export function isPlanStatus(v: string): v is PlanStatus {
  return (PLAN_STATUSES as readonly string[]).includes(v);
}

export function isStepStatus(v: string): v is StepStatus {
  return (STEP_STATUSES as readonly string[]).includes(v);
}

// --- Input Validation -------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  warnings: string[];
  errors: string[];
}

export function validateMemoryContent(content: string): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!content || content.trim().length === 0) {
    errors.push('Content must not be empty');
  }

  if (content.length > LIMITS.MAX_CONTENT_CHARS) {
    errors.push(`Content exceeds max ${LIMITS.MAX_CONTENT_CHARS} chars (got ${content.length})`);
  } else if (content.length > TOKEN_BUDGET.CONTENT_WARN_CHARS) {
    warnings.push(`Content is ${content.length} chars — distill further (target: <${TOKEN_BUDGET.CONTENT_WARN_CHARS})`);
  }

  // Reject XML/system content that leaked through from hook inputs
  if (isSystemContent(content)) {
    errors.push('Content appears to be system-generated XML or internal markup — not a distilled memory');
  }

  return { valid: errors.length === 0, warnings, errors };
}

/** Detect system-generated content that should never be stored as memories */
export function isSystemContent(content: string): boolean {
  const trimmed = content.trim();
  return trimmed.startsWith('<task-notification')
    || trimmed.startsWith('<system-reminder')
    || trimmed.startsWith('<system>')
    || trimmed.startsWith('<command-name>')
    || trimmed.startsWith('<local-command-')
    || trimmed.startsWith('<task-id>')
    || (trimmed.startsWith('<') && trimmed.includes('</') && trimmed.length > 100
        && /<\w+[-\w]*>/.test(trimmed) && /<\/\w+[-\w]*>/.test(trimmed));
}

export function validateTags(tags: string[]): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (tags.length > LIMITS.MAX_TAGS) {
    errors.push(`Max ${LIMITS.MAX_TAGS} tags allowed, got ${tags.length}`);
  }

  for (const tag of tags) {
    if (tag.trim().length === 0) {
      errors.push('Tags must not be empty strings');
      break;
    }
    if (tag.length > 50) {
      errors.push(`Tag "${tag.slice(0, 20)}..." exceeds 50 chars`);
    }
  }

  return { valid: errors.length === 0, warnings, errors };
}

export function validateNoteContent(note: string): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (!note || note.trim().length === 0) {
    errors.push('Note must not be empty');
  }

  if (note.length > TOKEN_BUDGET.NOTE_MAX_CHARS) {
    errors.push(`Note is ${note.length} chars — max ${TOKEN_BUDGET.NOTE_MAX_CHARS}`);
  }

  return { valid: errors.length === 0, warnings, errors };
}

export function validateStepCount(count: number): ValidationResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  if (count > LIMITS.MAX_STEPS_PER_PLAN) {
    warnings.push(`Plan has ${count} steps — max recommended is ${LIMITS.MAX_STEPS_PER_PLAN}`);
  }

  if (count === 0) {
    errors.push('Plan must have at least one step');
  }

  return { valid: errors.length === 0, warnings, errors };
}

// --- Content Quality Gates --------------------------------------------------

/**
 * Check content quality — warns on raw stack traces, code-only content,
 * file path listings, and very short content. Never rejects (warnings only).
 */
export function validateContentQuality(content: string): ValidationResult {
  const warnings: string[] = [];

  // 1. Raw stack traces
  const stackTracePattern = /^\s+at\s+.+\(.+:\d+:\d+\)/m;
  const multiLineErrorPattern = /\w+Error:.*\n\s+at\s+/;
  if (stackTracePattern.test(content) || multiLineErrorPattern.test(content)) {
    warnings.push('Content looks like a raw stack trace. Distill the lesson: what went wrong and how to fix it.');
  }

  // 2. Code-only content (no natural language)
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  if (lines.length > 1) {
    const codeIndicators = /^[\s]*(import |export |const |let |var |function |class |if\s*\(|for\s*\(|while\s*\(|return |def |from |async |await |[{}();]|=>)/;
    const codeLineCount = lines.filter(l => codeIndicators.test(l)).length;
    if (codeLineCount / lines.length > 0.7) {
      warnings.push('Content appears to be mostly code without explanation. Add a natural language lesson.');
    }
  }

  // 3. Pure file path listings
  if (lines.length > 1) {
    const pathPattern = /^[\s]*[\/\.][^\s]+[\s]*$/;
    const pathLineCount = lines.filter(l => pathPattern.test(l)).length;
    if (pathLineCount / lines.length > 0.6) {
      warnings.push('Content appears to be a file path listing. Add context about why these paths matter.');
    }
  }

  // 4. Very short content without context
  if (content.trim().length < 20 && !content.includes(':')) {
    warnings.push('Content is very short (<20 chars). Consider adding more context.');
  }

  return { valid: true, warnings, errors: [] };
}

// --- Date Normalization -----------------------------------------------------

/**
 * Detect relative date references and suggest absolute dates.
 * Returns warnings with suggested replacements — never auto-transforms.
 */
export function detectRelativeDates(content: string, referenceDate?: Date): ValidationResult {
  const warnings: string[] = [];
  const now = referenceDate ?? new Date();

  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

  const patterns: Array<{ regex: RegExp; resolver: (match: RegExpMatchArray) => string }> = [
    {
      regex: /\b(tomorrow)\b/i,
      resolver: () => {
        const d = new Date(now);
        d.setDate(d.getDate() + 1);
        return d.toISOString().split('T')[0];
      },
    },
    {
      regex: /\b(yesterday)\b/i,
      resolver: () => {
        const d = new Date(now);
        d.setDate(d.getDate() - 1);
        return d.toISOString().split('T')[0];
      },
    },
    {
      regex: /\bnext\s+(week)\b/i,
      resolver: () => {
        const d = new Date(now);
        d.setDate(d.getDate() + 7);
        return d.toISOString().split('T')[0];
      },
    },
    {
      regex: /\bnext\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
      resolver: (match) => {
        const targetDay = dayNames.indexOf(match[1].toLowerCase());
        const d = new Date(now);
        const currentDay = d.getDay();
        let daysUntil = targetDay - currentDay;
        if (daysUntil <= 0) daysUntil += 7;
        d.setDate(d.getDate() + daysUntil);
        return d.toISOString().split('T')[0];
      },
    },
    {
      regex: /\blast\s+(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i,
      resolver: (match) => {
        const targetDay = dayNames.indexOf(match[1].toLowerCase());
        const d = new Date(now);
        const currentDay = d.getDay();
        let daysSince = currentDay - targetDay;
        if (daysSince <= 0) daysSince += 7;
        d.setDate(d.getDate() - daysSince);
        return d.toISOString().split('T')[0];
      },
    },
  ];

  for (const { regex, resolver } of patterns) {
    const match = content.match(regex);
    if (match) {
      const absoluteDate = resolver(match);
      warnings.push(`Content contains relative date '${match[0]}'. Consider using absolute date '${absoluteDate}'.`);
    }
  }

  return { valid: true, warnings, errors: [] };
}

// --- Sanitization -----------------------------------------------------------

/** Escape SQL LIKE wildcards (% and _) and the escape char itself.
 *  Use with a `LIKE ? ESCAPE '\'` clause — underscores are common in file
 *  paths and silently act as single-char wildcards otherwise. */
export function escapeLikePattern(input: string): string {
  return input.replace(/[%_\\]/g, '\\$&');
}

/** Strip control characters and excessive whitespace */
export function sanitize(input: string): string {
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Neutralize stored memory text before it is rendered back into the model's
 * context. Memory content and its context fields originate from tool output,
 * transcripts, and imported files — all untrusted — and are later injected
 * into briefings and subagent prompts. Cairn's own injected lines are prefixed
 * `[CAIRN] `, so a memory whose text begins with that marker could impersonate
 * the system voice and read as a genuine directive. Strip any leading
 * `[CAIRN…]`-style prefix (repeatedly), and drop control characters as defense
 * in depth. Wording is otherwise preserved.
 */
export function neutralizeMemoryText(input: string): string {
  return input
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/^(?:\s*\[\s*cairn\b[^\]\n]*\]\s*)+/gi, '')
    .trim();
}
