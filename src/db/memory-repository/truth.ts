/**
 * Truth maintenance — contradiction/supersession detection and claim staleness.
 *
 * Prior-art-grounded (MemStrata / TOKI / HALO / AGM belief revision). Two design
 * commitments carried through every function here:
 *  - Detection is STRUCTURAL (shared subject tokens + a divergent value/polarity),
 *    never semantic-similarity alone — negation pairs sit at high cosine, so
 *    similarity would overfire. A scope-object mismatch VETOES a conflict.
 *  - Effects are NON-DESTRUCTIVE: supersession retires the loser (superseded_by
 *    pointer, excluded from active recall but kept queryable); standing
 *    contradiction only flags. Nothing is deleted or invalidated automatically.
 */
import type Database from 'better-sqlite3';
import type { Memory, MemoryRow } from './types.js';
import { rowToMemory } from './reads.js';
import { buildFtsQuery, now } from '../../utils/index.js';
import { SOURCE_AUTHORITY, TRUTH, type MemorySource } from '../../constants/index.js';
import { journalMutation, currentRevision } from './journal.js';

// --- Claim classification + staleness ---------------------------------------

export type ClaimType = 'version' | 'metric' | 'date' | 'volatile';

const VERSION_RE = /\bv?\d+\.\d+(?:\.\d+)?\b/;
const DATE_RE = /\b(?:19|20)\d{2}(?:-\d{2}-\d{2})?\b/;
const METRIC_RE = /\b\d{2,}(?:[./]\d+)?\b/; // 2+ digit numbers, counts, ratios like 1487/1487
const VOLATILE_RE = /\b(?:currently|right now|as of|latest|for now|temporarily|at the moment|these days|nowadays|at present)\b/i;
/** Completion cues — a finalized/historical record is not a live claim and does
 *  not decay ("migration COMPLETED, 580 partners" — the count never changes). */
const COMPLETION_RE = /\b(?:shipped|completed|complete|committed|migrated|finalized|finalised|final|delivered|released|deployed|done|resolved|closed|archived)\b/i;

/** Classify the most volatile time-sensitive claim in the content, if any.
 *  Order = fastest-decaying first so the tightest half-life wins. */
export function classifyClaim(content: string): ClaimType | null {
  if (VERSION_RE.test(content)) return 'version';
  if (VOLATILE_RE.test(content)) return 'volatile';
  if (DATE_RE.test(content)) return 'date';
  if (METRIC_RE.test(content)) return 'metric';
  return null;
}

export interface StalenessInfo {
  stale: boolean;
  reason: string;
  claimType: ClaimType;
  ageDays: number;
}

/** Read-time staleness verdict for a claim-bearing memory. Returns null for
 *  kinds/claims that never decay (durable facts, no volatile token). Pure —
 *  no DB writes; the returned reason is the observability payload. */
export function classifyClaimStaleness(memory: Memory, nowMs: number = Date.now()): StalenessInfo | null {
  if (!TRUTH.CLAIM_KINDS.includes(memory.kind)) return null;
  // Finalized/historical records are not live claims — their numbers are frozen
  // ("migration completed, 580 partners"), so they never go stale.
  if (COMPLETION_RE.test(memory.content)) return null;
  const claimType = classifyClaim(memory.content);
  if (!claimType) return null;
  const createdMs = Date.parse(memory.created_at);
  if (Number.isNaN(createdMs)) return null;
  const ageDays = (nowMs - createdMs) / 86_400_000;
  const halflife = TRUTH.HALFLIFE_DAYS[claimType];
  const stale = ageDays > halflife;
  return {
    stale,
    reason: `${claimType} claim, ${Math.round(ageDays)}d old (verify past ${halflife}d)`,
    claimType,
    ageDays,
  };
}

/** Terse "verify" suffix for a stale claim-bearing memory, or '' when fresh /
 *  non-claim. Rendered next to the memory so recall stays trustworthy without
 *  dropping possibly-still-true information (flag, don't delete). */
export function stalenessMarker(memory: Memory, nowMs: number = Date.now()): string {
  const s = classifyClaimStaleness(memory, nowMs);
  return s?.stale ? ` (verify — ${Math.round(s.ageDays)}d old ${s.claimType})` : '';
}

// --- Structural helpers -----------------------------------------------------

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'use', 'used', 'using',
  'via', 'not', 'but', 'are', 'was', 'were', 'has', 'have', 'had', 'can', 'will',
  'should', 'must', 'when', 'then', 'than', 'over', 'under', 'you', 'your', 'its',
]);

/** Significant subject tokens: lowercase words ≥3 chars, minus stopwords and
 *  minus anything that is (part of) a numeric/version value. */
export function subjectTokens(content: string): Set<string> {
  const withoutValues = content.replace(VERSION_RE, ' ').replace(METRIC_RE, ' ');
  const words = withoutValues.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? [];
  return new Set(words.filter(w => !STOPWORDS.has(w)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** The scope object after a scope cue (e.g. "for X", "when Y"), lowercased.
 *  Used by the scope guard: differing scope objects veto a contradiction. */
function scopeObjects(content: string): Set<string> {
  const out = new Set<string>();
  const tokens = content.toLowerCase().split(/[^a-z0-9_-]+/).filter(Boolean);
  for (let i = 0; i < tokens.length - 1; i++) {
    if (TRUTH.SCOPE_CUES.includes(tokens[i]) && !STOPWORDS.has(tokens[i + 1]) && tokens[i + 1].length >= 3) {
      out.add(tokens[i + 1]);
    }
  }
  return out;
}

function negationCount(content: string): number {
  const tokens = content.toLowerCase().split(/[^a-z']+/).filter(Boolean);
  return tokens.filter(t => TRUTH.NEGATION_CUES.includes(t)).length;
}

interface ValueContext {
  value: string;
  type: 'version' | 'metric';
  /** Significant non-numeric tokens within ±2 of the value — the "subject key"
   *  that makes two values comparable (same metric measured, same component
   *  versioned). Guards unit mismatches: "30 seconds" and "30000 milliseconds"
   *  share no context token, so they are not a drift. */
  context: Set<string>;
}

/** Extract each version/metric value with the significant tokens around it. */
function valueContexts(content: string): ValueContext[] {
  const tokens = content.split(/(\s+)/).filter(t => t.trim().length > 0);
  const out: ValueContext[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i].replace(/[.,;:)]+$/, '');
    const isVersion = new RegExp(`^${VERSION_RE.source}$`).test(tok);
    const isMetric = !isVersion && new RegExp(`^${METRIC_RE.source}$`).test(tok);
    if (!isVersion && !isMetric) continue;
    const context = new Set<string>();
    for (let j = Math.max(0, i - 2); j <= Math.min(tokens.length - 1, i + 2); j++) {
      if (j === i) continue;
      const w = tokens[j].toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (w.length >= 3 && !STOPWORDS.has(w) && !/^\d/.test(w)) context.add(w);
    }
    out.push({ value: tok, type: isVersion ? 'version' : 'metric', context });
  }
  return out;
}

/** Unit words — a differing unit between two values means they are not
 *  comparable (e.g. "30 seconds" vs "30000 milliseconds" is the same value). */
const UNIT_WORDS = new Set([
  'seconds', 'second', 'secs', 'sec', 'milliseconds', 'millisecond', 'millis',
  'minutes', 'minute', 'mins', 'hours', 'hour', 'days', 'day', 'weeks', 'months',
  'bytes', 'byte', 'kilobytes', 'megabytes', 'gigabytes', 'kib', 'mib', 'gib',
  'percent', 'pct',
]);

function unitOf(context: Set<string>): string | null {
  for (const c of context) if (UNIT_WORDS.has(c)) return c;
  return null;
}

/** A value drift is a pair (one per content) of the SAME type whose contexts
 *  overlap (same subject) but whose values differ — AND whose units, if any,
 *  match. Returns the drift type or null. */
function valueDrift(a: string, b: string): 'version' | 'metric' | null {
  const av = valueContexts(a);
  const bv = valueContexts(b);
  for (const x of av) {
    for (const y of bv) {
      if (x.type !== y.type) continue;
      if (x.value === y.value) continue;
      // Require a shared non-unit context token — otherwise these measure
      // different subjects and aren't comparable.
      let shared = false;
      for (const c of x.context) if (!UNIT_WORDS.has(c) && y.context.has(c)) shared = true;
      if (!shared) continue;
      // Unit-mismatch veto: same subject but different units (s vs ms) is the
      // same value expressed differently, not a drift.
      const ux = unitOf(x.context), uy = unitOf(y.context);
      if (ux && uy && ux !== uy) continue;
      return x.type;
    }
  }
  return null;
}

/** True when two contents carry the same VALUE dimension (both have versions,
 *  or both have metrics) with no shared value — i.e. same subject, different
 *  value. Used by dedup to NOT merge such pairs (they are supersessions, not
 *  duplicates: merging would conflate "Postgres 15" and "Postgres 16"). */
export function valuesDiverge(a: string, b: string): boolean {
  return valueDrift(a, b) !== null;
}

function antonymFlip(aTokens: Set<string>, bTokens: Set<string>): boolean {
  for (const [x, y] of TRUTH.ANTONYM_PAIRS) {
    if ((aTokens.has(x) && bTokens.has(y)) || (aTokens.has(y) && bTokens.has(x))) return true;
  }
  return false;
}

/** True when two contents are OPPOSED (divergent value, odd negation parity, or
 *  antonym flip) rather than reinforcing duplicates. Used by dedup to NOT merge
 *  opposed pairs — merging "always enable X" with "never enable X" would silently
 *  erase the conflict. detectConflict (with its scope guard) decides the final
 *  disposition once both rows exist. */
export function contentsOppose(a: string, b: string): boolean {
  if (valuesDiverge(a, b)) return true;
  if ((negationCount(a) + negationCount(b)) % 2 === 1) return true;
  return antonymFlip(subjectTokens(a), subjectTokens(b));
}

// --- Conflict detection -----------------------------------------------------

export type ConflictType = 'supersession' | 'contradiction';

export interface ConflictResult {
  type: ConflictType;
  /** Human-readable signal that fired — observability. */
  signal: string;
  /** For supersession: the memory to retire. Absent for contradiction (both survive). */
  loserId?: string;
  winnerId?: string;
}

/** Decide whether two same-kind, same-scope memories conflict, and how.
 *  `existing` is already stored; `incoming` was just written (newer). Returns
 *  null when they are unrelated OR merely adjacent (scope guard vetoes). */
export function detectConflict(existing: Memory, incoming: Memory): ConflictResult | null {
  const aSubj = subjectTokens(existing.content);
  const bSubj = subjectTokens(incoming.content);

  // Gate 1: topical relatedness (structural, conservative).
  let shared = 0;
  for (const t of aSubj) if (bSubj.has(t)) shared++;
  if (shared < TRUTH.SUBJECT_MIN_SHARED_TOKENS) return null;
  if (jaccard(aSubj, bSubj) < TRUTH.SUBJECT_MIN_JACCARD) return null;

  // Gate 2: scope guard — differing scope objects mean different scope, not conflict.
  const aScope = scopeObjects(existing.content);
  const bScope = scopeObjects(incoming.content);
  if (aScope.size > 0 && bScope.size > 0) {
    let scopeShared = false;
    for (const s of aScope) if (bScope.has(s)) scopeShared = true;
    if (!scopeShared) return null; // both scoped, no overlap → coexist
  }

  // Gate 3a: value drift.
  //
  // Only a semver VERSION advance is unambiguous enough to auto-retire the old
  // claim (versions monotonically advance). A bare-number METRIC divergence is
  // ambiguous — the number may be a changed magnitude OR a distinct entity
  // labelled by a number (error code 42 vs 99, port 8080 vs 9090, 2048- vs
  // 4096-bit key). Since supersession is the only path that HIDES a memory,
  // metric drift only ever flags both sides (contradiction, non-destructive)
  // and lets the user resolve. (Calibration: metric-drift auto-supersede
  // false-fired ~50% on short high-overlap facts in the real-data simulation.)
  const drift = valueDrift(existing.content, incoming.content);
  if (drift === 'version') {
    // Claim-type-aware arbitration: a newer version from equal-or-higher
    // authority supersedes; a lower-authority observation only flags for review
    // (never silently retire a higher-authority claim).
    const incAuth = SOURCE_AUTHORITY[incoming.source as MemorySource] ?? 0;
    const exAuth = SOURCE_AUTHORITY[existing.source as MemorySource] ?? 0;
    if (incAuth >= exAuth) {
      return { type: 'supersession', signal: 'version drift, newer value supersedes', loserId: existing.id, winnerId: incoming.id };
    }
    return { type: 'contradiction', signal: 'version drift, lower-authority — flag for review', winnerId: incoming.id, loserId: existing.id };
  }
  if (drift === 'metric') {
    return { type: 'contradiction', signal: 'metric drift — flag both for review', winnerId: incoming.id, loserId: existing.id };
  }

  // Gate 3b: polarity conflict → standing contradiction (surface both, no retire).
  const negParityOdd = (negationCount(existing.content) + negationCount(incoming.content)) % 2 === 1;
  if (negParityOdd || antonymFlip(aSubj, bSubj)) {
    return { type: 'contradiction', signal: negParityOdd ? 'negation-parity flip' : 'antonym flip', winnerId: incoming.id, loserId: existing.id };
  }

  return null;
}

// --- Write-time application -------------------------------------------------

export interface ConflictApplication {
  supersededId: string | null;
  contradictionWith: string | null;
  signal: string | null;
}

/** After a new claim-bearing memory is inserted, scan active same-kind
 *  same-scope candidates for a conflict and apply the (non-destructive) effect:
 *  retire the superseded loser, or record a `contradicts` edge + return the pair
 *  for surfacing. Bounded by TRUTH.CONFLICT_CANDIDATE_LIMIT. */
export function applyConflictDetection(db: Database.Database, incoming: Memory): ConflictApplication {
  const empty: ConflictApplication = { supersededId: null, contradictionWith: null, signal: null };
  if (!TRUTH.CLAIM_KINDS.includes(incoming.kind)) return empty;

  const ftsQuery = buildFtsQuery(incoming.content);
  if (!ftsQuery) return empty;

  let candidates: MemoryRow[];
  try {
    candidates = db.prepare(`
      SELECT m.* FROM memories_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ?
        AND m.invalidated = 0
        AND m.superseded_by IS NULL
        AND m.kind = ?
        AND m.id != ?
        AND ((? IS NULL AND m.project IS NULL) OR m.project = ?)
      LIMIT ?
    `).all(ftsQuery, incoming.kind, incoming.id, incoming.project, incoming.project, TRUTH.CONFLICT_CANDIDATE_LIMIT) as MemoryRow[];
  } catch {
    return empty;
  }

  for (const row of candidates) {
    const existing = rowToMemory(row);
    const conflict = detectConflict(existing, incoming);
    if (!conflict) continue;

    if (conflict.type === 'supersession' && conflict.loserId) {
      const loser = conflict.loserId === existing.id ? existing : incoming;
      db.transaction(() => {
        db.prepare('UPDATE memories SET superseded_by = ?, superseded_at = ? WHERE id = ?')
          .run(conflict.winnerId ?? incoming.id, now(), conflict.loserId);
        // Supersession is a semantic RETIREMENT WITH A SUCCESSOR: it
        // journals as an upsert of the retired row's new state, never as
        // an ordinary tombstone (journal.ts retraction semantics).
        journalMutation(db, {
          memoryId: conflict.loserId!, project: loser.project, kind: loser.kind,
          op: 'upsert', revision: currentRevision(db, conflict.loserId!),
        });
      })();
      return { supersededId: conflict.loserId, contradictionWith: null, signal: conflict.signal };
    }

    // Standing contradiction: directional edge (loser→winner) records the pair
    // for surfacing; both memories keep surfacing until the user resolves it.
    db.prepare(`
      INSERT OR IGNORE INTO memory_edges (source_id, target_id, relation, weight, created_at)
      VALUES (?, ?, 'contradicts', 1.0, ?)
    `).run(conflict.loserId ?? existing.id, conflict.winnerId ?? incoming.id, now());
    return { supersededId: null, contradictionWith: existing.id, signal: conflict.signal };
  }

  return empty;
}

// --- Shared suppression policy (constraint: one source of truth) ------------

/** IDs among `ids` that have been retired by supersession. Excluded from active
 *  recall + briefings AND from graph-neighbor expansion (single policy). */
export function supersededLoserIds(db: Database.Database, ids: string[]): Set<string> {
  if (ids.length === 0) return new Set();
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id FROM memories WHERE id IN (${placeholders}) AND superseded_by IS NOT NULL`
  ).all(...ids) as Array<{ id: string }>;
  return new Set(rows.map(r => r.id));
}

export interface ContradictionPair {
  loser: Memory;
  winner: Memory;
  signal: string;
}

/** Active unresolved contradiction pairs for a project, for arbitration
 *  surfacing and tests. A pair resolves when either side is invalidated or
 *  superseded. */
export function getContradictions(db: Database.Database, project: string | null): ContradictionPair[] {
  const rows = db.prepare(`
    SELECT e.source_id AS loser_id, e.target_id AS winner_id
    FROM memory_edges e
    JOIN memories ls ON ls.id = e.source_id
    JOIN memories ws ON ws.id = e.target_id
    WHERE e.relation = 'contradicts'
      AND ls.invalidated = 0 AND ls.superseded_by IS NULL
      AND ws.invalidated = 0 AND ws.superseded_by IS NULL
      AND ((? IS NULL AND ls.project IS NULL) OR ls.project = ?)
  `).all(project, project) as Array<{ loser_id: string; winner_id: string }>;

  const pairs: ContradictionPair[] = [];
  for (const r of rows) {
    const loser = db.prepare('SELECT * FROM memories WHERE id = ?').get(r.loser_id) as MemoryRow | undefined;
    const winner = db.prepare('SELECT * FROM memories WHERE id = ?').get(r.winner_id) as MemoryRow | undefined;
    if (loser && winner) pairs.push({ loser: rowToMemory(loser), winner: rowToMemory(winner), signal: 'contradicts' });
  }
  return pairs;
}
