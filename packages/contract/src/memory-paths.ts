/**
 * Memory-tool path router (W4 v3.1 §3, §8 path rules) — PURE routing and
 * validation only: no database access, no rendering, no command behavior.
 *
 * Layout (frozen design):
 *   /memories                             root
 *   /memories/global/<category>.md        materialized, project IS NULL
 *   /memories/p-<base64url>/<category>.md materialized, exact project scope
 *   /memories/**                          free-form (memory_files)
 *
 * Project segments use unpadded UTF-8 base64url under the `p-` prefix: the
 * alphabet ([A-Za-z0-9_-]) contains no dots, slashes, or percent signs, so
 * hostile project names encode to segments the traversal protection
 * accepts, and the prefix makes the reserved `global` segment structurally
 * uncollidable. Decoding is canonical (re-encode must reproduce the
 * segment exactly) — a non-canonical `p-` segment owns nothing and routes
 * free-form.
 */
import type { MemoryKind } from './vocabulary.js';

/** The documented invalid-path message (no `Error: ` prefix — SDK wrappers
 *  own prefixing). Lives with the grammar it describes. */
export const invalidPathMessage = (path: string, root: string): string =>
  `invalid path ${path} — memory paths must stay within ${root}`;

export const MEMORY_ROOT = '/memories';
export const GLOBAL_SEGMENT = 'global';
export const PROJECT_PREFIX = 'p-';
/** §8 path rules: reject absurd lengths before any other processing. */
export const MAX_PATH_LENGTH = 1024;

export type Category =
  | 'pitfalls' | 'decisions' | 'facts' | 'corrections' | 'references'
  | 'patterns' | 'user-profile' | 'plan';

/** Which kinds a materialized category renders (plan is repo-backed, not
 *  kind-backed; task_state is deliberately unmapped — ephemeral). */
export const CATEGORY_KINDS: Readonly<Record<Category, readonly MemoryKind[]>> = {
  pitfalls: ['pitfall'],
  decisions: ['decision'],
  facts: ['fact'],
  corrections: ['correction'],
  references: ['reference'],
  patterns: ['pattern', 'goal'],
  'user-profile': ['user_profile'],
  plan: [],
} as const;

/** Categories present under a PROJECT directory. user-profile is global
 *  only (user_profile memories are always global scope). */
const PROJECT_CATEGORIES: readonly Category[] = [
  'pitfalls', 'decisions', 'facts', 'corrections', 'references', 'patterns', 'plan',
];
const GLOBAL_CATEGORIES: readonly Category[] = [...PROJECT_CATEGORIES, 'user-profile'];

/** Every kind the VFS OWNS in the given scope — the union of the scope's
 *  category kinds. Unmapped kinds (task_state is deliberately ephemeral)
 *  are invisible to the memory tool and MUST never be mutated by
 *  directory-level operations. */
export function vfsOwnedKinds(project: string | null): readonly MemoryKind[] {
  const categories = project === null ? GLOBAL_CATEGORIES : PROJECT_CATEGORIES;
  return categories.flatMap(c => [...CATEGORY_KINDS[c]]);
}

export type RoutedPath =
  | { type: 'root' }
  | { type: 'directory'; project: string | null }
  | { type: 'materialized'; project: string | null; category: Category; readOnly: boolean }
  | { type: 'free-form'; path: string };

// --- Project segment encoding -------------------------------------------------

/** UTF-8 base64url (unpadded) under the p- prefix. */
export function encodeProjectSegment(project: string): string {
  return PROJECT_PREFIX + Buffer.from(project, 'utf8').toString('base64url');
}

/** Exact inverse of encodeProjectSegment. Returns null for anything that
 *  is not a CANONICAL encoding (wrong prefix, alphabet violations, or a
 *  segment whose decode does not re-encode to itself) — a non-canonical
 *  segment must never claim materialized ownership. The bare prefix `p-`
 *  IS canonical: it encodes the empty project name, which current schemas
 *  permit as a distinct value from NULL/global — rejecting it would break
 *  the ownership inverse for those rows. */
export function decodeProjectSegment(segment: string): string | null {
  if (!segment.startsWith(PROJECT_PREFIX)) return null;
  const body = segment.slice(PROJECT_PREFIX.length);
  if (body.length === 0) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(body)) return null;
  const decoded = Buffer.from(body, 'base64url').toString('utf8');
  return encodeProjectSegment(decoded) === segment ? decoded : null;
}

// --- Path validation + normalization ------------------------------------------

const invalidPathError = (path: string): Error =>
  new Error(invalidPathMessage(path, MEMORY_ROOT));

/** Bounded iterative percent-decoding for traversal detection: harmless
 *  encodings (release%2enotes.md, discount%25.md) must PASS, while any
 *  decode round that reveals a separator, a `..` segment, or a control
 *  character is rejected — covering plain (%2e%2e%2f), mixed-case, and
 *  double-encoded (%252e) attacks. The RAW path is what gets stored;
 *  decoding here is detection only. */
const DECODE_ROUNDS = 3;
const decodeOnce = (s: string): string =>
  s.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));

function segmentHidesTraversal(segment: string): boolean {
  let cur = segment;
  for (let round = 0; round < DECODE_ROUNDS; round++) {
    const next = decodeOnce(cur);
    if (next === cur) return false; // fixed point within budget — safe
    cur = next;
    // eslint-disable-next-line no-control-regex
    if (cur.includes('/') || cur.includes('\\') || cur === '..' || cur.includes('../') || cur.includes('..\\') || /[\x00-\x1f\x7f]/.test(cur)) {
      return true;
    }
  }
  // Budget exhausted WITHOUT convergence — fail closed. Returning false
  // here made the bound bypassable: traversal encoded four or more times
  // survives three decode rounds still wearing a percent-coat. Nothing
  // innocent needs more than three encoding layers.
  return decodeOnce(cur) !== cur;
}

/** Validate and normalize a raw memory path (§8 path rules, exact order):
 *  length bound → control/NUL rejection → raw traversal sequences →
 *  URL-encoded traversal → /memories prefix → lexical POSIX normalization
 *  → containment re-check. Throws the documented message (no `Error: `
 *  prefix — the SDK wrapper owns prefixing, §9). */
export function normalizeMemoryPath(raw: string): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_LENGTH) {
    throw invalidPathError(raw);
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) throw invalidPathError(raw);
  if (raw.includes('../') || raw.includes('..\\') || raw === '..' || raw.endsWith('/..')) {
    throw invalidPathError(raw);
  }
  if (raw.includes('\\')) throw invalidPathError(raw);
  for (const seg of raw.split('/')) {
    if (segmentHidesTraversal(seg)) throw invalidPathError(raw);
  }
  if (raw !== MEMORY_ROOT && !raw.startsWith(MEMORY_ROOT + '/')) {
    throw invalidPathError(raw);
  }

  // Lexical POSIX normalization: collapse //, resolve '.' and '..'
  const segments: string[] = [];
  for (const seg of raw.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segments.length === 0) throw invalidPathError(raw);
      segments.pop();
    } else {
      segments.push(seg);
    }
  }
  const normalized = '/' + segments.join('/');
  if (normalized !== MEMORY_ROOT && !normalized.startsWith(MEMORY_ROOT + '/')) {
    throw invalidPathError(raw);
  }
  return normalized;
}

// --- Routing -------------------------------------------------------------------

function categoryOf(fileName: string, scope: 'global' | 'project'): Category | null {
  if (!fileName.endsWith('.md')) return null;
  const stem = fileName.slice(0, -3) as Category;
  const allowed = scope === 'global' ? GLOBAL_CATEGORIES : PROJECT_CATEGORIES;
  return allowed.includes(stem) ? stem : null;
}

/** Classify a raw path. Throws (via normalizeMemoryPath) on invalid paths;
 *  everything valid routes to exactly one of root / directory /
 *  materialized / free-form. plan.md is read-only in v1 (decided). */
export function routeMemoryPath(raw: string): RoutedPath {
  const path = normalizeMemoryPath(raw);
  if (path === MEMORY_ROOT) return { type: 'root' };

  const segments = path.slice(MEMORY_ROOT.length + 1).split('/');

  if (segments.length === 1) {
    const [seg] = segments;
    if (seg === GLOBAL_SEGMENT) return { type: 'directory', project: null };
    const project = decodeProjectSegment(seg);
    if (project !== null) return { type: 'directory', project };
    return { type: 'free-form', path };
  }

  if (segments.length === 2) {
    const [dir, file] = segments;
    if (dir === GLOBAL_SEGMENT) {
      const category = categoryOf(file, 'global');
      if (category !== null) {
        return { type: 'materialized', project: null, category, readOnly: category === 'plan' };
      }
      return { type: 'free-form', path };
    }
    const project = decodeProjectSegment(dir);
    if (project !== null) {
      const category = categoryOf(file, 'project');
      if (category !== null) {
        return { type: 'materialized', project, category, readOnly: category === 'plan' };
      }
    }
    return { type: 'free-form', path };
  }

  return { type: 'free-form', path };
}

/** Ownership inverse (§3): the ONE canonical file for a memory, or null
 *  for unmapped kinds (task_state — ephemeral by design). */
export function canonicalPathFor(kind: MemoryKind, project: string | null): string | null {
  const category = (Object.entries(CATEGORY_KINDS) as Array<[Category, readonly MemoryKind[]]>)
    .find(([, kinds]) => kinds.includes(kind))?.[0];
  if (category === undefined) return null;
  if (category === 'user-profile' || kind === 'user_profile') {
    return `${MEMORY_ROOT}/${GLOBAL_SEGMENT}/user-profile.md`;
  }
  const dir = project === null ? GLOBAL_SEGMENT : encodeProjectSegment(project);
  return `${MEMORY_ROOT}/${dir}/${category}.md`;
}
