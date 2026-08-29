import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';
import {
  canonicalJson,
  CANONICALIZATION_VERSION,
  CONTENT_HASH_VERSION,
  PROJECTION_VERSION,
  type PortableRecord,
} from 'waykeep-contract';

import { neutralizeMemoryText } from '../../utils/validation.js';
import { scrubSecrets, sanitize } from '../../utils/index.js';

/**
 * The projection function P and the canonical row form (brief D2, R22).
 *
 * Two-rule equality discipline: every entity-vs-row comparison uses the
 * PROJECTION domain — H(P(canonical_payload)) vs H(canon(local_row)) —
 * and canonical-hash comparisons are allowed only canonical-to-canonical
 * for identity classification. No guard ever compares a canonical hash
 * to row or projection bytes.
 *
 * PROJECTION FIELD SET (v1 decision, slice review gates it): exactly the
 * semantic fields whose mutation journals — kind, project, content,
 * tags, context, anchor. Rationale: S5/S9's clean/diverged partition
 * must agree with what the semantic journal calls an edit (slice 3), so
 * "diverged" ⟺ "an unpushed semantic change exists". Volatile fields
 * (confidence, timestamps, source, fingerprint) are replicated data but
 * never divergence evidence — an unpushed confidence bump on
 * team-retired content is not worth fork-preserving. A false twin-MISS
 * (differing tags on the same lesson) coexists harmlessly as two rows;
 * a false MATCH would silently merge distinct content — the field set
 * errs toward misses.
 *
 * P's scrub IS the apply path's scrub, by construction (R22): the bytes
 * hashed are exactly the bytes stored.
 */

export { CANONICALIZATION_VERSION, CONTENT_HASH_VERSION, PROJECTION_VERSION };

export interface ProjectionFields {
  kind: string;
  project: string | null;
  content: string;
  tags: string[];
  context: { why?: string; how_to_apply?: string } | null;
  anchor: string | null;
}

const clean = (text: string): string => scrubSecrets(neutralizeMemoryText(sanitize(text))).text;

/** Recursive cleaner for structured free-text carriers (fingerprint
 *  facets): every string value is neutralized + scrubbed. */
export function cleanDeep(value: unknown): unknown {
  if (typeof value === 'string') return clean(value);
  if (Array.isArray(value)) return value.map(cleanDeep);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, cleanDeep(v)]));
  }
  return value;
}

/** P applied to an inbound payload: neutralize + scrub EVERY
 *  future-rendered free-text surface — content, context, tags, anchor
 *  (slice-4 Codex gate: tags/anchor were copied raw). The result is
 *  BOTH what gets stored and what gets hashed. */
export function projectPayload(record: PortableRecord): ProjectionFields {
  let context: ProjectionFields['context'] = null;
  if (record.context) {
    const ctx: { why?: string; how_to_apply?: string } = {};
    if (typeof record.context.why === 'string') ctx.why = clean(record.context.why);
    if (typeof record.context.how_to_apply === 'string') ctx.how_to_apply = clean(record.context.how_to_apply);
    if (ctx.why !== undefined || ctx.how_to_apply !== undefined) context = ctx;
  }
  return {
    kind: record.kind,
    project: record.project,
    content: clean(record.content),
    tags: record.tags.map((t) => clean(t)).sort(),
    context,
    anchor: record.anchor === null ? null : clean(record.anchor),
  };
}

/** Canonical byte form of the projection field set: stable-key canonical
 *  JSON, tags sorted (order is presentation, not semantics). */
export function canonicalRowBytes(f: ProjectionFields): string {
  return canonicalJson({
    anchor: f.anchor,
    content: f.content,
    context: f.context,
    kind: f.kind,
    project: f.project,
    tags: [...f.tags].sort(),
  });
}

export function hashCanonical(bytes: string): string {
  return createHash('sha256').update(bytes, 'utf8').digest('hex');
}

/** H(P(canonical_payload)) — the inbound side of every projection guard. */
export function projectionHashOfPayload(record: PortableRecord): string {
  return hashCanonical(canonicalRowBytes(projectPayload(record)));
}

/** A pending local retraction (invalidate or supersession) is an
 *  unpushed semantic change the projection hash cannot see — the
 *  clean/diverged guards test this alongside hash equality (slice-4
 *  review C3). The projection field set itself stays as documented:
 *  adding these flags to the hashed bytes would break S6's as-stored
 *  rule and twin matching. */
export function isLocallyRetracted(db: Database.Database, memoryId: string): boolean {
  const row = db.prepare('SELECT invalidated, superseded_by FROM memories WHERE id = ?').get(memoryId) as
    | { invalidated: number; superseded_by: string | null } | undefined;
  return row !== undefined && (row.invalidated === 1 || row.superseded_by !== null);
}

interface RowFieldsRow {
  kind: string; project: string | null; content: string;
  tags: string | null; context: string | null; anchor: string | null;
}

/** H(canon(local_row_bytes)) — the local side of every projection guard.
 *  Named for its DOMAIN: this is a projection-domain hash of the stored
 *  row, never comparable to a canonical_content_hash (review rename).
 *  Reads the row as stored; returns null when the row is absent. */
export function projectionHashOfRow(db: Database.Database, memoryId: string): string | null {
  const row = db.prepare(
    'SELECT kind, project, content, tags, context, anchor FROM memories WHERE id = ?',
  ).get(memoryId) as RowFieldsRow | undefined;
  if (!row) return null;
  let context: ProjectionFields['context'] = null;
  if (row.context) {
    try {
      const parsed = JSON.parse(row.context) as { why?: string; how_to_apply?: string };
      const ctx: { why?: string; how_to_apply?: string } = {};
      if (typeof parsed.why === 'string') ctx.why = parsed.why;
      if (typeof parsed.how_to_apply === 'string') ctx.how_to_apply = parsed.how_to_apply;
      if (ctx.why !== undefined || ctx.how_to_apply !== undefined) context = ctx;
    } catch { /* malformed context participates as null */ }
  }
  return hashCanonical(canonicalRowBytes({
    kind: row.kind,
    project: row.project,
    content: row.content,
    tags: row.tags ? (JSON.parse(row.tags) as string[]) : [],
    context,
    anchor: row.anchor,
  }));
}
