/**
 * Rule-based intent classifier for UserPromptSubmit hook.
 * Classifies user intent WITHOUT an LLM call — zero tokens, <1ms.
 */
import { type UserIntent } from '../constants/index.js';

// --- Positive Confirmation Detection ----------------------------------------

const CONFIRMATION_PATTERNS = [
  /^(perfect|exactly|that'?s?\s+(right|correct|it|exactly)|yes\s+(that\s+works|that'?s?\s+(right|correct|it)|exactly|perfect|right)|good\s+call|keep\s+doing\s+that|that\s+works|nailed\s+it|nice|great|spot\s+on)[.!\s]*$/i,
  /^(yes|yep|yeah|yup|correct|right)[.!\s]*$/i,
];

const CONFIRMATION_ANTI_PATTERNS = [
  /\b(but|however|except|although|instead|actually|wait)\b/i,
  /\b(fix|change|update|modify|also|and\s+also|can\s+you)\b/i,
];

/**
 * Detect positive confirmation in user messages.
 * Returns true for short, unambiguous confirmations like "perfect", "exactly", "yes".
 * Rejects messages with qualifiers ("yes but...") or action requests ("perfect, also fix...").
 */
export function isPositiveConfirmation(message: string): boolean {
  const trimmed = message.trim();

  // Confirmations are short — reject anything over 80 chars
  if (trimmed.length > 80) return false;

  // Check anti-patterns first (qualifiers, follow-up requests)
  if (CONFIRMATION_ANTI_PATTERNS.some(p => p.test(trimmed))) return false;

  // Check positive patterns
  return CONFIRMATION_PATTERNS.some(p => p.test(trimmed));
}

// --- User Profile Detection --------------------------------------------------

export interface UserProfileSignal {
  content: string;
  /** Structured dimensions extracted from the signal (Phase 4) */
  dimensions?: Array<{ dimension: string; key: string; value: string }>;
}

const USER_PROFILE_PATTERNS = [
  /\bi(?:'m| am) (?:a |an |the )?([\w\s]+?(?:developer|engineer|designer|manager|lead|architect|founder|cto|ceo|devops|sre|data scientist|analyst|consultant|intern|student|researcher))\b/i,
  /\bi(?:'ve| have) been ([\w\s]+?(?:for \d+|since)\b.{0,40}?)(?:\.|,|!|$)/i,
  /\bmy (?:background|expertise|experience|role|specialty|focus|stack) (?:is |in |involves )(.{5,60}?)(?:\.|,|$)/i,
  /\bi work (?:on|at|for|with|in) (.{5,60}?)(?:\.|,|$)/i,
  /\bi(?:'m| am) new to (.{3,50}?)(?:\.|,|$)/i,
  /\bfirst time (?:with|using|touching) (.{3,50}?)(?:\.|,|$)/i,
  /\bour (?:team|company|org|stack) (?:is|uses|runs|has) (.{5,60}?)(?:\.|,|$)/i,
];

/** Anti-patterns: skip if message is about current task, not identity */
const USER_PROFILE_ANTI_PATTERNS = [
  /\bi(?:'m| am) (?:getting|trying|looking|working|running|seeing|debugging|building|updating|fixing|testing|having)\b/i,
  /\b(?:error|bug|issue|problem|exception|failure|crash)\b/i,
];

/**
 * Detect user profile/identity signals in messages.
 * Returns the distilled profile content or null if no signal detected.
 * Conservative: requires role/expertise language, rejects task-oriented statements.
 */
export function detectUserProfile(message: string): UserProfileSignal | null {
  const trimmed = message.trim();
  if (trimmed.length > 200 || trimmed.length < 10) return null;

  // Anti-patterns: skip if about current task or errors
  if (USER_PROFILE_ANTI_PATTERNS.some(p => p.test(trimmed))) return null;

  for (const pattern of USER_PROFILE_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      const sentence = extractSentence(trimmed, match.index ?? 0, match[0].length, 150);
      const dimensions = extractProfileDimensions(trimmed);
      return { content: sentence, dimensions: dimensions.length > 0 ? dimensions : undefined };
    }
  }
  return null;
}

/** Extract structured dimensions from a profile-bearing message. */
function extractProfileDimensions(text: string): Array<{ dimension: string; key: string; value: string }> {
  const dims: Array<{ dimension: string; key: string; value: string }> = [];
  const lower = text.toLowerCase();

  // Role detection: "I'm a senior developer", "I'm the lead architect"
  const roleMatch = lower.match(/\bi(?:'m| am) (?:a |an |the )?((?:senior|junior|lead|staff|principal|chief|head) )?([\w\s]+?(?:developer|engineer|designer|manager|lead|architect|founder|cto|ceo|devops|sre|data scientist|analyst|consultant|intern|student|researcher))\b/);
  if (roleMatch) {
    const seniority = roleMatch[1]?.trim() ?? '';
    const role = roleMatch[2].trim();
    dims.push({ dimension: 'role', key: role, value: seniority || 'true' });
  }

  // Expertise detection: language/framework mentions in role context
  const expertisePatterns = [
    /\b(typescript|javascript|python|rust|go|java|c\+\+|ruby|swift|kotlin|php|scala|elixir|clojure)\b/gi,
    /\b(react|vue|angular|svelte|next\.?js|node\.?js|django|flask|spring|rails|express|fastapi)\b/gi,
  ];
  for (const pat of expertisePatterns) {
    let m;
    while ((m = pat.exec(lower)) !== null) {
      const tech = m[1].toLowerCase();
      if (!dims.some(d => d.dimension === 'expertise' && d.key === tech)) {
        dims.push({ dimension: 'expertise', key: tech, value: 'familiar' });
      }
    }
  }

  // Preference detection: "I prefer X", "I like X", "I prioritize X"
  const prefMatch = lower.match(/\bi (?:prefer|like|prioritize|value|want|need) (.{3,60}?)(?:\.|,|$)/);
  if (prefMatch) {
    const pref = prefMatch[1].trim().slice(0, 50);
    dims.push({ dimension: 'preference', key: normalizeKey(pref), value: 'true' });
  }

  // "New to X" → expertise with beginner value
  const newToMatch = lower.match(/\bi(?:'m| am) new to (.{3,50}?)(?:\.|,|$)/);
  if (newToMatch) {
    const tech = newToMatch[1].trim().slice(0, 30);
    dims.push({ dimension: 'expertise', key: normalizeKey(tech), value: 'beginner' });
  }

  // Team/org detection: "our team uses X", "I work at Y"
  const teamMatch = lower.match(/\b(?:our (?:team|company|org)|i work (?:at|for)) (.{3,50}?)(?:\.|,|$)/);
  if (teamMatch) {
    const team = teamMatch[1].trim().slice(0, 40);
    dims.push({ dimension: 'team', key: normalizeKey(team), value: 'true' });
  }

  return dims;
}

/** Normalize a phrase into a key: lowercase, replace spaces with underscores, strip noise */
function normalizeKey(phrase: string): string {
  return phrase.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '').slice(0, 40);
}

/** Extract the sentence around a regex match index from the source text. */
function extractSentence(text: string, matchIndex: number, matchLength: number, maxChars: number): string {
  let start = matchIndex;
  while (start > 0 && text[start - 1] !== '.' && text[start - 1] !== '\n') start--;
  let end = matchIndex + matchLength;
  while (end < text.length && text[end] !== '.' && text[end] !== '\n') end++;
  return text.slice(start, end).trim().slice(0, maxChars);
}

// --- External Reference Detection --------------------------------------------

export interface ReferenceSignal {
  content: string;
  tags: string[];
}

const EXTERNAL_SYSTEMS = [
  'linear', 'jira', 'asana', 'trello', 'notion', 'confluence',
  'grafana', 'datadog', 'sentry', 'pagerduty', 'newrelic',
  'slack', 'discord', 'teams',
  'github', 'gitlab', 'bitbucket',
  'figma', 'miro',
  'jenkins', 'circleci', 'vercel', 'netlify', 'railway', 'supabase',
];

const REFERENCE_CONTEXT_PATTERNS = [
  /\b(?:tracked|managed|logged|filed|stored|documented|maintained|found) (?:in|on|at) (\w+)/i,
  /\bcheck (?:the )?(\w+) (?:project|board|channel|dashboard|page|workspace|ticket|issue)/i,
  /\bthe (\w+) (?:project|board|channel|dashboard|page|workspace) (?:at|for|named|called|is) /i,
  /\b(\w+) (?:board|project|channel|dashboard|ticket) ["']?[\w-]+/i,
];

/**
 * Detect external system reference signals (URLs to known tools, or
 * "tracked in Linear project INGEST" style statements).
 * Returns the reference content and auto-tagged system, or null.
 */
export function detectReference(message: string): ReferenceSignal | null {
  const trimmed = message.trim();
  if (trimmed.length > 300 || trimmed.length < 15) return null;

  // Pattern 1: URLs to known systems
  const urlMatch = trimmed.match(/https?:\/\/[^\s)]+/);
  if (urlMatch) {
    const url = urlMatch[0].toLowerCase();
    const system = EXTERNAL_SYSTEMS.find(s => url.includes(s));
    if (system) {
      const sentence = extractSentence(trimmed, urlMatch.index ?? 0, urlMatch[0].length, 200);
      return { content: sentence, tags: [`ref:${system}`] };
    }
  }

  // Pattern 2: Contextual mentions ("tracked in Linear", "check the Grafana dashboard")
  for (const pattern of REFERENCE_CONTEXT_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match) {
      const possibleSystem = match[1].toLowerCase();
      if (EXTERNAL_SYSTEMS.includes(possibleSystem)) {
        const sentence = extractSentence(trimmed, match.index ?? 0, match[0].length, 200);
        return { content: sentence, tags: [`ref:${possibleSystem}`] };
      }
    }
  }

  return null;
}

// --- Structured "Why" Context Extraction -------------------------------------

/**
 * Extract a "why" rationale clause from text containing decision or fact language.
 * Returns the extracted reason or null if no rationale pattern found.
 */
export function extractWhyContext(text: string): string | null {
  const patterns = [
    /\bbecause\s+(.{10,150}?)(?:\.|;|,\s*(?:so|and|but)|$)/i,
    /\bsince\s+(.{10,150}?)(?:\.|;|,\s*(?:so|and|but)|$)/i,
    /\bdue to\s+(.{10,150}?)(?:\.|;|$)/i,
    /\bthe reason (?:is|was|being)\s+(.{10,150}?)(?:\.|;|$)/i,
    /\bthis (?:matters|is important) because\s+(.{10,150}?)(?:\.|;|$)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return match[1].trim().slice(0, 200);
    }
  }
  return null;
}

// --- Intent Classification ---------------------------------------------------

export function classifyIntent(message: string): UserIntent {
  const lower = message.toLowerCase().trim();

  // CORRECTION — highest priority, check first
  // "no" at start is ambiguous — "no, that's wrong" is a correction,
  // "no I just need X" is a task. Require "no" + correction follow-up.
  // Anti-patterns reject task instructions that coincidentally contain correction words
  // (e.g., "the question I asked earlier" or "lets discuss, so i need to ensure...")
  const correctionAntiPatterns = [
    /\b(question|thing|topic|issue|point)\s+i\s+(asked|said|told)\b/i,
    /\bi\s+asked\s+(about|earlier|before|you\s+earlier)\b/i,
    /\blet'?s\s+(discuss|talk|go|start|look|figure|think|try|work)\b/i,
    /\bi\s+(need|want)\s+to\s+(ensure|make sure|check|verify|discuss|understand)\b/i,
    /\bgo\s+back\s+to\b/i,
  ];
  if (!correctionAntiPatterns.some(p => p.test(lower))) {
    const correctionPatterns = [
      /^no[,.]?\s+(that|this|it|you|don|stop|never|wrong|not|i\s+(said|told|asked|already))/,
      /that'?s\s*(not|wrong)/,
      /don'?t\s+(do|use|add|make)/,
      /always\s+(use|do|make|add)/,
      // "I said/told/asked" — only at sentence start or after punctuation to avoid
      // false positives like "based on what I asked earlier"
      /(?:^|[,.;!]\s*)i\s+(said|told|asked)\s+(you|that|to)\b/,
      /stop\s+(doing|using)/,
      /never\s+(use|do)/,
    ];
    if (correctionPatterns.some(p => p.test(lower))) return 'correction';
  }

  // STATUS — check before question (overlapping words)
  const statusPatterns = [
    /where\s+are\s+we/,
    /what'?s\s+(the\s+)?(status|progress)/,
    /what\s+(step|phase)/,
    /show\s+(me\s+)?(the\s+)?plan/,
    /^status$/,
  ];
  if (statusPatterns.some(p => p.test(lower))) return 'status';

  // QUESTION — interrogative without action verbs
  const questionStarters = /^(how|what|why|where|when|which|can\s+you\s+explain|tell\s+me|is\s+(it|there)|does|do\s+we)/;
  const hasQuestionMark = message.includes('?');
  const actionVerbs = /\b(fix|implement|create|update|refactor|add|remove|change|build|write|delete|move|rename|deploy|install|upgrade|migrate)\b/;

  if ((questionStarters.test(lower) || hasQuestionMark) && !actionVerbs.test(lower)) {
    return 'question';
  }

  // TASK — everything else (action-oriented is the default)
  return 'task';
}
