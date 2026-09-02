/**
 * Shared learn-mode ingestion — the ONE path every importer and the MCP
 * cairn_ingest v1 branch ride. Untrusted markdown gets the same defenses
 * everywhere: neutralizeMemoryText (a forged "[WAYKEEP]" prefix in an
 * imported file must never impersonate the system voice), sanitize on
 * tags, and the repository gateway's dedup/merge. Extracted so the CLI
 * importer and the MCP tool cannot drift (the standalone-twin lesson,
 * three times over).
 */
import type { MemoryRepository } from '../db/memory-repository.js';
import { LIMITS, type LearnableKind, CONFIDENCE } from '../constants/index.js';
import { neutralizeMemoryText, sanitize } from '../utils/validation.js';
import { scrubSecrets } from '../utils/secret-scanner.js';

export interface LearnSection {
  kind: LearnableKind;
  content: string;
  tags: string[];
  /** Optional per-section project override (importers map source scopes;
   *  null = global, undefined = use the batch default). */
  project?: string | null;
  context?: { why?: string; how_to_apply?: string };
  /** Provenance: which agent ecosystem authored this content (schema
   *  v29 origin_client) — 'codex' for codex-memories imports. */
  originClient?: string;
}

/** Preview/diagnostic text must NEVER show raw source content — an
 *  imported bullet can begin with a credential, and dry-run output or an
 *  error message would print it verbatim (review). Scrub + clip. */
export function safeExcerpt(content: string, length = 90): string {
  const scrubbed = scrubSecrets(sanitize(content)).text;
  return scrubbed.length > length ? `${scrubbed.slice(0, length)}…` : scrubbed;
}

export interface LearnResult {
  ingested: number;
  /** IDENTICAL content already stored — a true no-op (idempotent path). */
  exactDuplicates: number;
  /** Distinct source content the gateway MERGED with a similar existing
   *  row (the store keeps the longer text). NOT a no-op — one of the two
   *  wordings is gone. `existing` is the pre-merge text of the row it
   *  merged with, captured BEFORE create overwrites it (a post-hoc read
   *  named the wrong victim; review round 2). */
  merged: Array<{ source: string; existing: string }>;
  errors: string[];
}

/** RULE (four bugs in one slice earned this line): every identity
 *  comparison happens in the CANONICAL domain — canonicalize once, then
 *  compare and store the SAME bytes. Raw-vs-stored mismatches (byte
 *  order, tag order, unscrubbed context) each produced endless-copy or
 *  false-reject behavior. If you add a compared field, canonicalize it
 *  here first. */
export interface LearnOptions {
  /** Exact repeats: false (default — bulk CLI imports) makes them TRUE
   *  no-ops (idempotent re-runs never inflate confidence or mutate
   *  tags); true (the MCP cairn_ingest path) keeps the gateway's
   *  reinforcement semantics its tool description promises. A source
   *  file gaining a keyword between CLI re-imports is deliberately not
   *  picked up — idempotency wins there (review R3, decided). */
  reinforceExact?: boolean;
  /** Insert-only (the repo-pack path): a NEAR-duplicate never reaches
   *  the gateway merge — it lands as its own row. The merge is correct
   *  for interactive learning where the user authors both sides; a pack
   *  is untrusted external data, and D12 forbids it any edit claim —
   *  the near-dup merge rewrote existing content, unioned foreign tags,
   *  and bumped confidence from one dropped file (pack review C1).
   *  Insert-only also restores the deterministic round-trip: imports
   *  never collapse near-dup pairs (C2). Convergent on re-import: the
   *  inserted row IS the pack bytes, so the next pass is an exact
   *  no-op. */
  insertOnly?: boolean;
}

/** Apply sections through the gateway. `defaultProject` scopes sections
 *  without their own; dryRun is decided by the CALLER (importers preview
 *  before calling; the MCP tool has its own dry-run rendering). */
export function learnSections(
  repo: MemoryRepository,
  sections: readonly LearnSection[],
  defaultProject: string | null,
  options: LearnOptions = {},
): LearnResult {
  let ingested = 0;
  let exactDuplicates = 0;
  const merged: LearnResult['merged'] = [];
  const errors: string[] = [];
  for (const section of sections) {
    try {
      // ONE canonical representation, computed exactly as the gateway
      // stores it: neutralize → sanitize → SCRUB → clip. Order matters
      // twice over: clipping BEFORE scrubbing can cut a credential so
      // the scrubber's pattern no longer matches (partial secret stored),
      // and probing a different representation than storage misreports
      // exact repeats as merges (review round 2, both executed).
      const content = scrubSecrets(sanitize(neutralizeMemoryText(section.content))).text
        .slice(0, LIMITS.MAX_CONTENT_CHARS);
      const project = section.project !== undefined ? section.project : defaultProject;
      // Probe with the gateway's OWN similarity match BEFORE create:
      // an exact repeat becomes a TRUE no-op (create on a duplicate
      // boosts confidence and unions tags — reinforcement is right for
      // interactive learning, but a bulk re-run must not inflate
      // confidence every pass), and a merge captures the pre-existing
      // text before create overwrites it with the longer version.
      const similar = repo.findSimilarTo(content, project, section.kind);
      // Exactness under insertOnly is the FULL observation identity —
      // content AND tags AND context (Codex pack #2a: content-only
      // exactness silently dropped a same-content/different-metadata
      // record, breaking the pack round-trip). Interactive paths keep
      // content-only exactness (metadata enrichment is their point).
      const cleanedTags = section.tags.map((t) => scrubSecrets(sanitize(t)).text.slice(0, LIMITS.MAX_TAG_CHARS)).slice(0, LIMITS.MAX_TAGS);
      // Context canonicalizes ONCE, exactly as the gateway stores it
      // (scrubSecrets∘sanitize — writes.ts sanitizeContext), and BOTH
      // the identity comparison and create() consume the canonical form
      // (Codex pack close: raw-context comparison never matched the
      // stored scrubbed bytes, so a secret-bearing `why` re-imported as
      // an endless-copy path).
      const cleanedContext = section.context === undefined ? undefined : {
        ...(section.context.why !== undefined ? { why: scrubSecrets(sanitize(section.context.why)).text } : {}),
        ...(section.context.how_to_apply !== undefined ? { how_to_apply: scrubSecrets(sanitize(section.context.how_to_apply)).text } : {}),
      };
      const contentExact = similar !== null && similar.content === content;
      let isExact = contentExact;
      if (options.insertOnly) {
        // Full-identity exactness must consult EVERY same-content row
        // (Codex pack delta Z2): the single similar row may be a
        // different metadata variant, and re-imports then inserted
        // endless copies. Tags compare SORTED — the same canonical
        // order the pack serializer writes.
        const sameContent = repo.findAllByExactContent(content, project, section.kind);
        const wantTags = JSON.stringify([...cleanedTags].sort());
        isExact = sameContent.some((full) =>
          JSON.stringify([...(full.tags ?? [])].sort()) === wantTags
          && (full.context?.why ?? null) === (cleanedContext?.why ?? null)
          && (full.context?.how_to_apply ?? null) === (cleanedContext?.how_to_apply ?? null));
      }
      if (isExact && !options.reinforceExact) {
        exactDuplicates++;
        continue;
      }
      const result = repo.create({
        // insertOnly is a FULL no-claims mode (Codex pack delta Z1):
        // skipDedup alone left conflict detection live, and an imported
        // near-claim SUPERSEDED the stored original — a retirement
        // claim through the back door. A pack observation may never
        // retire, merge into, or otherwise touch an existing row.
        ...(options.insertOnly ? { skipConflictDetection: true as const } : {}),
        ...(options.insertOnly && similar !== null && !isExact ? { skipDedup: true as const } : {}),
        content,
        kind: section.kind,
        // Tags get the SAME secret scrub as content, the count cap, and
        // the length cap — a credential or an essay can arrive as a
        // source keyword/concept (review).
        tags: cleanedTags,
        project,
        context: cleanedContext,
        // Step 6 carry-in (F4 class): imported pitfalls previously inherited
        // the LEARNED default 0.65 — EXACTLY the injection gate, eligible at
        // birth and gone at the first decay charge (the degenerate value the
        // remediation rejects). Imports are UNTRUSTED observations, so they
        // start honestly BELOW the gate like auto-mined pitfalls and earn
        // injectability through reinforcement — a foreign pack must not buy
        // proactive-warning rights on arrival. DELIBERATE POLICY (codex
        // step-6 review): repeated exact re-imports reinforce via the dedup
        // boost (0.55 → 0.60 → 0.65 → capped by the reinforcement ceiling) —
        // repetition of the same observation is corroboration; a pack that
        // wants injection on day one still cannot have it.
        ...(section.kind === 'pitfall' ? { confidence: CONFIDENCE.AUTO_DETECTED } : {}),
        ...(section.originClient ? { originClient: section.originClient } : {}),
      });
      if (!result.deduplicated) ingested++;
      else if (isExact) exactDuplicates++; // reinforced, still not a merge
      else {
        merged.push({
          source: safeExcerpt(section.content, 70),
          existing: safeExcerpt(similar?.content ?? '(unidentified row)', 70),
        });
      }
    } catch (err) {
      // Scrubbed excerpt only — never raw source content in diagnostics.
      errors.push(`"${safeExcerpt(section.content, 60)}": ${(err as Error).message}`);
    }
  }
  return { ingested, exactDuplicates, merged, errors };
}
