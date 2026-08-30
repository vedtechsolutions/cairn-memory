import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { formatMemoryContent } from '../../utils/memory-injection.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import * as z from 'zod/v4';
import type { MemoryRepository } from '../../db/memory-repository.js';
import type { EdgeRepository } from '../../db/edge-repository.js';
import type { SessionCache } from '../../hooks/shared/session-cache.js';
import { deriveOriginClient } from '../../hooks/shared/client-adapter.js';
import { LEARNABLE_KINDS, LIMITS, BRIEFING_MODE, RELEVANCE, FINGERPRINT, type ContextMode } from '../../constants/index.js';
import { RERANK } from '../../constants/reranker-models.js';
import { generateFingerprint } from '../../utils/fingerprint.js';
import { surfacesInScopedRecall } from '../../utils/cross-project-guard.js';
import { canReadPrivate } from '../../config/cairn-config.js';
import { sessionProjectId } from '../../utils/session-project.js';
import { projectId } from '../../utils/project-id.js';
import type { ContextRepository } from '../../db/context-repository.js';
import { isRerankEnabled, rerank } from '../../utils/reranker.js';
import { isCritical } from './helpers.js';
import { sanitize } from '../../utils/validation.js';
import { scrubSecrets } from '../../utils/secret-scanner.js';
import {
  validateMemoryContent,
  validateTags,
  validateContentQuality,
  detectRelativeDates,
  isLearnableKind,
} from '../../utils/validation.js';
import { embed, embedQuery, embeddingToBuffer, isEmbeddingReady, bufferToEmbedding } from '../../utils/embeddings.js';
import { extractAnchor, anchorToJson } from '../../utils/anchor.js';
import { cosineSimilarity } from '../../utils/similarity.js';

type ContextModeFn = () => ContextMode;


/**
 * Bump the session cache memory version if one is provided. Called after any
 * successful write path (create, update, invalidate, delete, strengthen, weaken,
 * cleanup). The bump invalidates every skip-gate entry so the next hook call
 * sees the new memory state — giving corrections a staleness bound of zero.
 * No-op when the cache is absent (e.g. in standalone tests).
 */
function bumpCache(cache: SessionCache | undefined): void {
  cache?.bumpMemoryVersion();
}

/** Injectable rerank seam — production uses the real reranker module;
 *  MCP-level tests inject fakes to prove reorder, fallback labeling, and
 *  recall-count semantics without model downloads. */
export interface RerankerImpl {
  isEnabled: () => boolean;
  rerank: typeof rerank;
}

export function registerMemoryTools(
  server: McpServer,
  repo: MemoryRepository,
  getMode: ContextModeFn,
  innerServer?: Server,
  edgeRepo?: EdgeRepository,
  sessionCache?: SessionCache,
  rerankerImpl: RerankerImpl = { isEnabled: isRerankEnabled, rerank },
  contextRepo?: ContextRepository,
): void {
  // --- cairn_recall ----------------------------------------------------------

  server.registerTool(
    'cairn_recall',
    {
      title: 'Recall Memories',
      description: 'Retrieve relevant memories for a topic or task. Returns pitfalls, decisions, corrections, and facts ranked by relevance.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        query: z.string().max(LIMITS.MAX_STRING_PARAM).describe('What you are about to do — used to find relevant memories'),
        project: z.string().max(LIMITS.MAX_STRING_PARAM).optional().describe('Scope to a specific project ID'),
        max_results: z.number().int().positive().optional().describe('Max results (default: 5)'),
        scope: z.enum(['all', 'project']).optional().describe("Result scope: 'all' (default) includes relevant globals; 'project' returns ONLY the given project's own memories"),
      }),
    },
    async ({ query, project, max_results: maxResults, scope }) => {
      const mode = getMode();
      const critical = isCritical(mode);
      if (critical) return critical;

      // Resolve a bare project name (e.g. "cairn") to its full id for scoping.
      const resolvedProject = repo.resolveProject(project) ?? null;
      if (scope === 'project' && !resolvedProject) {
        return { content: [{ type: 'text' as const, text: "error: scope: 'project' requires a resolvable `project` argument" }], isError: true };
      }

      const limit = modeAdjustedLimit(mode, maxResults);

      // Generate query embedding if model is ready (non-blocking fallback to FTS)
      let queryEmbedding: Buffer | null = null;
      if (isEmbeddingReady()) {
        try {
          const emb = await embedQuery(query);
          queryEmbedding = embeddingToBuffer(emb);
        } catch { /* fall back to FTS-only */ }
      }

      // Rerank stage (opt-in, W2): fetch the RRF top-RERANK.CANDIDATES
      // read-only, cross-encode, keep the top `limit`, then apply recall
      // side effects to exactly the top-k ids returned by this stage.
      // Supplemental graph neighbors added later by enrichment are NOT
      // marked — matching the non-rerank path, where only directly
      // retrieved results carry recall side effects.
      const rerankActive = rerankerImpl.isEnabled();
      const recallOptions = {
        project: resolvedProject,
        // Overfetch so the cross-project filter has headroom; always read-only
        // so recall stats aren't bumped on candidates we may then drop.
        maxResults: rerankActive ? Math.max(RERANK.CANDIDATES, limit) : limit * FINGERPRINT.CANDIDATE_MULTIPLIER,
        readOnly: true,
      };
      let results = queryEmbedding
        ? repo.recallHybrid(query, queryEmbedding, recallOptions)
        : repo.recall(query, recallOptions);

      // Scope policy, applied UNCONDITIONALLY (unlike the fingerprint
      // guard below, which needs a project context): a private project's
      // rows are readable only when THIS SESSION runs inside that project
      // — naming the project from elsewhere, or a bare recall, gets
      // nothing. The `project` argument selects scope; it is not consent.
      const sessionPid = sessionProjectId();
      results = results.filter(r => canReadPrivate(r.memory.project, sessionPid));
      // scope: 'project' — only the project's own rows, no globals.
      if (scope === 'project') {
        results = results.filter(r => r.memory.project === resolvedProject);
      }

      // Cross-project guard (same filter the hook/briefing paths apply): a
      // global memory surfaces in a project-scoped recall only when its
      // fingerprint overlaps the project's — blocking mis-scoped globals such
      // as an Odoo pitfall stored global. The query fingerprint comes from the
      // project's stored context, exactly as on the UserPromptSubmit path;
      // absent context yields an empty fp → fail closed (block, never leak).
      const queryFp = resolvedProject
        ? generateFingerprint({ projectContext: contextRepo?.getLatest(resolvedProject) ?? null })
        : null;
      if (queryFp) {
        results = results.filter(r => surfacesInScopedRecall(r.memory, resolvedProject, queryFp));
      }

      let rerankFallback = false;
      if (rerankActive && results.length > 1) {
        const reordered = await rerankerImpl.rerank(query, results.map((r, i) => ({ id: r.memory.id, text: r.memory.content, rank: i })));
        if (reordered === null) {
          // Transient unavailability — degrade EXPLICITLY, never silently
          rerankFallback = true;
          console.error('[cairn] rerank unavailable — returning RRF order (labeled)');
        } else {
          const byId = new Map(results.map(r => [r.memory.id, r]));
          results = reordered.map(c => byId.get(c.id)).filter((r): r is NonNullable<typeof r> => r !== undefined);
        }
      }
      // Slice to the requested limit AFTER filtering/reranking, then mark
      // exactly the surfaced set as recalled — once, for both branches, so a
      // dropped candidate never gets a spurious recall bump.
      results = results.slice(0, limit);
      repo.markRecalled(results.map(r => r.memory.id));

      // Track co-recall for prediction
      if (results.length >= 2) {
        try {
          repo.trackCoRecall('mcp-recall', results.map(r => r.memory.id));
        } catch { /* best-effort */ }
      }

      // Direct top-k ids BEFORE enrichment — supplemental graph neighbors
      // carry a synthetic graph score, never an RRF fusion score, so the
      // rrf_score label must apply only to directly retrieved results.
      const directIds = new Set(results.map(r => r.memory.id));

      // Enrich with 1-hop graph neighbors (supplemental related memories)
      if (results.length > 0 && mode === 'normal') {
        results = repo.enrichWithGraphNeighbors(results, 2);
        // Guard the supplemental neighbors too — a 1-hop edge must not smuggle
        // a mis-scoped global (or a private project's memory, or an
        // out-of-scope row under scope:'project') past the filters above.
        results = results.filter(r => directIds.has(r.memory.id) || canReadPrivate(r.memory.project, sessionPid));
        if (scope === 'project') {
          results = results.filter(r => directIds.has(r.memory.id) || r.memory.project === resolvedProject);
        }
        if (queryFp) {
          results = results.filter(r => directIds.has(r.memory.id) || surfacesInScopedRecall(r.memory, resolvedProject, queryFp));
        }
      }

      if (results.length === 0) {
        return { content: [{ type: 'text', text: 'No relevant memories found.' }] };
      }

      const header = rerankFallback ? ['[rerank unavailable — results in RRF order]'] : [];
      // After a successful rerank the ORDER is the cross-encoder's but the
      // numeric score is still the RRF fusion score — label it honestly so
      // a reader never mistakes it for the reranker's relevance score.
      // Graph neighbors get their own label; without reranking the generic
      // 'score' stays for all rows (pre-existing output format).
      const labelFor = (id: string): string => {
        if (!(rerankActive && !rerankFallback)) return 'score';
        return directIds.has(id) ? 'rrf_score' : 'graph_score';
      };
      const lines = results.map(({ memory: m, score }) => {
        const scope = m.project ? `[${m.project}]` : '[global]';
        const tags = m.tags.length > 0 ? ` (${m.tags.join(', ')})` : '';
        const why = m.context?.why ? ` (Why: ${m.context.why})` : '';

        if (mode === 'minimal') {
          return `• ${formatMemoryContent(m)}${why}`;
        }
        return `• [${m.kind}] ${formatMemoryContent(m)}${why} ${scope}${tags} — conf: ${m.confidence.toFixed(2)}, ${labelFor(m.id)}: ${score.toFixed(2)}`;
      });

      return { content: [{ type: 'text', text: [...header, ...lines].join('\n') }] };
    },
  );

  // --- cairn_learn -----------------------------------------------------------

  server.registerTool(
    'cairn_learn',
    {
      title: 'Learn Memory',
      description: 'Store a distilled lesson. One sentence preferred. Deduplicates automatically.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        content: z.string().max(LIMITS.MAX_CONTENT_CHARS).describe('The distilled lesson — one sentence preferred'),
        kind: z.enum(LEARNABLE_KINDS).describe('Memory kind: pitfall, decision, correction, fact, user_profile, or reference'),
        tags: z.array(z.string().max(50)).max(LIMITS.MAX_TAGS).optional().describe('Free-form tags for retrieval (max 5)'),
        project: z.string().max(LIMITS.MAX_STRING_PARAM).nullable().optional().describe('Project ID, or null for global scope'),
        expires_at: z.string().optional().describe('ISO date when this memory should auto-expire (optional)'),
        why: z.string().max(200).optional().describe('Why this matters (optional structured context)'),
        how_to_apply: z.string().max(200).optional().describe('How to apply this lesson (optional structured context)'),
      }),
    },
    async ({ content, kind, tags, project, expires_at: expiresAt, why, how_to_apply: howToApply }) => {
      if (!isLearnableKind(kind)) {
        return { content: [{ type: 'text', text: `error: invalid kind "${kind}"` }], isError: true };
      }

      const contentCheck = validateMemoryContent(content);
      if (!contentCheck.valid) {
        return { content: [{ type: 'text', text: `error: ${contentCheck.errors.join('; ')}` }], isError: true };
      }

      // Redact secrets once, up front, so the embedding, anchor extraction,
      // quality gates, cross-kind edges, and stored content all operate on the
      // same scrubbed text. The write gateway re-scrubs idempotently as
      // defense-in-depth; without this the vector would encode the raw secret.
      content = scrubSecrets(sanitize(content)).text;

      // Kind-specific tag processing
      let effectiveTags = (tags ?? []).map(t => sanitize(t));
      if (kind === 'reference') {
        effectiveTags = effectiveTags.map(t => t.startsWith('ref:') ? t : `ref:${t}`);
      }

      if (effectiveTags.length > 0) {
        const tagCheck = validateTags(effectiveTags);
        if (!tagCheck.valid) {
          return { content: [{ type: 'text', text: `error: ${tagCheck.errors.join('; ')}` }], isError: true };
        }
      }

      // Validate expires_at if provided
      if (expiresAt) {
        const expDate = new Date(expiresAt);
        if (isNaN(expDate.getTime()) || expDate <= new Date()) {
          return { content: [{ type: 'text', text: 'error: expires_at must be a valid future ISO date' }], isError: true };
        }
      }

      // Content quality gates + date normalization warnings
      const qualityCheck = validateContentQuality(content);
      const dateCheck = detectRelativeDates(content);

      // Kind-specific scope: user_profile is always global
      // Default scope: user_profile is always global; corrections default
      // global (per the memory-scoping rules); everything else defaults to the
      // CURRENT project — this MCP server runs in the project's cwd — so a
      // project-specific pitfall/fact never silently lands in global scope (the
      // cross-project leak Codex hit). An explicit project (including null for
      // global) is always respected.
      const effectiveProject = kind === 'user_profile'
        ? null
        : project !== undefined
          ? project
          : (kind === 'correction' ? null : projectId(process.cwd()));

      // Build structured context if provided
      const context = (why || howToApply) ? { why, how_to_apply: howToApply } : undefined;

      // Generate embedding if model is ready (non-blocking — memory stored without embedding otherwise)
      let embeddingBuf: Buffer | undefined;
      if (isEmbeddingReady()) {
        try {
          const emb = await embed(content);
          embeddingBuf = embeddingToBuffer(emb);
        } catch { /* store without embedding */ }
      }

      // Extract code-location anchor from content
      const anchor = extractAnchor(content);
      const anchorStr = anchor ? anchorToJson(anchor) : undefined;

      // Provenance: which agent authored this write (schema v29). The MCP
      // path has no relay flag, so derive from the initialize clientInfo.
      const originClient = deriveOriginClient(innerServer?.getClientVersion()?.name);

      // Decisions and pitfalls use unified gateways for smart dedup
      const result = kind === 'decision'
        ? repo.storeDecision({
            content,
            project: effectiveProject,
            tags: effectiveTags,
            context,
            embedding: embeddingBuf,
            originClient,
          })
        : kind === 'pitfall'
        ? repo.storePitfall({
            content,
            project: effectiveProject,
            tags: effectiveTags,
            context,
            embedding: embeddingBuf,
            anchor: anchorStr,
            originClient,
          })
        : repo.create({
            content,
            kind,
            tags: effectiveTags,
            project: effectiveProject,
            expiresAt: expiresAt ?? undefined,
            context,
            embedding: embeddingBuf,
            anchor: anchorStr,
            originClient,
          });

      // Auto-create cross-kind 'informs' edges for new (non-dedup) memories
      if (!result.deduplicated && edgeRepo && embeddingBuf) {
        try {
          createCrossKindEdges(repo, edgeRepo, result.id, content, kind, effectiveProject, embeddingBuf);
        } catch { /* best-effort — never fail the learn */ }
      }

      // New content lands — invalidate hot-path skip gates so the next hook
      // call sees it. Dedup path still bumps: even a merge can shift rankings.
      bumpCache(sessionCache);

      // Terse response with merged warnings
      const warnings = [...contentCheck.warnings, ...qualityCheck.warnings, ...dateCheck.warnings];
      const msg = result.deduplicated ? 'dedup' : 'ok';
      const extra = warnings.length > 0 ? ` (warn: ${warnings.join('; ')})` : '';
      return { content: [{ type: 'text', text: `${msg}${extra}` }] };
    },
  );

  /** N5 decision: mutation follows readability — a session can neither
   *  read nor MODIFY another project's private memories (integrity and
   *  availability protected alongside confidentiality). Applied to every
   *  by-id mutation; 'not found' is deliberately NOT the answer here —
   *  an honest refusal beats pretending the row does not exist, since
   *  ids are no longer obtainable cross-project anyway. */
  const privateMutationBlock = (id: string): { content: [{ type: 'text'; text: string }]; isError: true } | null => {
    const memory = repo.findById(id);
    if (!memory || canReadPrivate(memory.project, sessionProjectId())) return null;
    return { content: [{ type: 'text', text: 'error: this memory belongs to a private project — modify it from a session inside that project' }], isError: true };
  };

  // --- cairn_correct ---------------------------------------------------------

  server.registerTool(
    'cairn_correct',
    {
      title: 'Correct Memory',
      description: 'Fix or invalidate a stored memory.',
      inputSchema: z.object({
        id: z.string().describe('Memory ID to correct'),
        action: z.enum(['update', 'invalidate']).describe('"update" to fix content, "invalidate" to soft-delete'),
        new_content: z.string().optional().describe('New content (required for "update")'),
      }),
    },
    async ({ id, action, new_content: newContent }) => {
      const blocked = privateMutationBlock(id);
      if (blocked) return blocked;
      if (action === 'update') {
        if (!newContent) {
          return { content: [{ type: 'text', text: 'error: new_content required for update' }], isError: true };
        }
        const ok = repo.update(id, newContent);
        if (ok) {
          // Update embedding for corrected content. update() stores the
          // scrubbed form, so embed the same scrubbed text (never the raw
          // newContent) to keep the vector free of the secret's tokens.
          if (isEmbeddingReady()) {
            try {
              const emb = await embed(scrubSecrets(sanitize(newContent)).text);
              repo.storeEmbedding(id, embeddingToBuffer(emb));
            } catch { /* non-critical */ }
          }
          // Corrections must be visible on the next inject — invalidate skip gates.
          bumpCache(sessionCache);
        }
        return { content: [{ type: 'text', text: ok ? 'ok' : 'not found' }] };
      }

      const ok = repo.invalidate(id);
      if (ok) bumpCache(sessionCache);
      return { content: [{ type: 'text', text: ok ? 'ok' : 'not found' }] };
    },
  );

  // --- cairn_forget ----------------------------------------------------------

  server.registerTool(
    'cairn_forget',
    {
      title: 'Forget Memory',
      description: 'Permanently delete a memory.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: z.object({
        id: z.string().describe('Memory ID to delete'),
      }),
    },
    async ({ id }) => {
      const blocked = privateMutationBlock(id);
      if (blocked) return blocked;
      const ok = repo.delete(id);
      if (ok) bumpCache(sessionCache);
      return { content: [{ type: 'text', text: ok ? 'ok' : 'not found' }] };
    },
  );

  // --- cairn_strengthen ------------------------------------------------------

  server.registerTool(
    'cairn_strengthen',
    {
      title: 'Strengthen Memory',
      description: 'Increase trust in a memory that proved accurate or useful.',
      inputSchema: z.object({
        id: z.string().describe('Memory ID to strengthen'),
      }),
    },
    async ({ id }) => {
      const blocked = privateMutationBlock(id);
      if (blocked) return blocked;
      const ok = repo.strengthenConfidence(id);
      if (ok) bumpCache(sessionCache);
      return { content: [{ type: 'text', text: ok ? 'ok' : 'not found' }] };
    },
  );

  // --- cairn_weaken ----------------------------------------------------------

  server.registerTool(
    'cairn_weaken',
    {
      title: 'Weaken Memory',
      description: 'Decrease trust in a memory that was inaccurate or unhelpful. Auto-invalidates if confidence drops below threshold.',
      inputSchema: z.object({
        id: z.string().describe('Memory ID to weaken'),
      }),
    },
    async ({ id }) => {
      const blocked = privateMutationBlock(id);
      if (blocked) return blocked;
      const result = repo.weakenConfidence(id);
      if (!result.weakened) {
        return { content: [{ type: 'text', text: 'not found' }] };
      }
      bumpCache(sessionCache);
      return { content: [{ type: 'text', text: result.invalidated ? 'invalidated' : 'ok' }] };
    },
  );
  // --- cairn_expand ----------------------------------------------------------
  // Progressive-disclosure companion to the index briefing. The index emits
  // short lines prefixed with stable type-coded IDs (dec:xxxxxxxx,
  // pit:xxxxxxxx, cor:xxxxxxxx); Claude passes a subset of those IDs here
  // to pull full content, why, how_to_apply, confidence, and effectiveness
  // when it actually needs the detail. SNR gates match cairn_recall:
  // invalidated memories are skipped, low-confidence probation items are
  // suppressed.

  server.registerTool(
    'cairn_expand',
    {
      title: 'Expand Memory IDs',
      description: 'Fetch full content, why, how_to_apply, and confidence for a list of memory IDs from the index briefing. Pass IDs like "dec:a1b2c3d4" or "pit:f5e6d7c8" (type prefix + first 8 chars of UUID).',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        ids: z.array(z.string().max(32)).min(1).max(BRIEFING_MODE.EXPAND_MAX_IDS).describe('Memory IDs from the index briefing (max 10)'),
      }),
    },
    async ({ ids }) => {
      const mode = getMode();
      const critical = isCritical(mode);
      if (critical) return critical;

      const expandPid = sessionProjectId();
      const lines: string[] = [];
      for (const rawId of ids) {
        // Parse the type prefix: "pit:xxxxxxxx" → kind=pitfall, shortId=xxxxxxxx
        const match = /^(dec|pit|cor|fact|inv):([a-z0-9-]+)$/.exec(rawId.trim());
        if (!match) {
          lines.push(`[skip] "${rawId}": expected format <kind>:<short-id>`);
          continue;
        }
        const [, , shortId] = match;

        // Find memory whose id starts with shortId (the briefing uses first 8 chars)
        const memory = repo.findByShortId(shortId);
        if (!memory || memory.invalidated) {
          lines.push(`[not found] ${rawId}`);
          continue;
        }
        // Session-bound private reads: expand is the progressive-disclosure
        // continuation of the briefing, and findByShortId accepts any
        // unique prefix — without this check a 4-char prefix walk reads
        // every private row's content from anywhere.
        if (!canReadPrivate(memory.project, expandPid)) {
          lines.push(`[private] ${rawId}: belongs to a private project — open it from within that project`);
          continue;
        }

        const tags = memory.tags.length > 0 ? ` [${memory.tags.join(', ')}]` : '';
        const scope = memory.project ? `project=${memory.project}` : 'global';
        lines.push(`[${memory.kind}:${memory.id.slice(0, 8)}] ${formatMemoryContent(memory)}`);
        if (memory.context?.why) lines.push(`  why: ${memory.context.why}`);
        if (memory.context?.how_to_apply) lines.push(`  how: ${memory.context.how_to_apply}`);
        lines.push(`  conf=${memory.confidence.toFixed(2)} surface=${memory.surface_count} impact=${memory.impact_count} ${scope}${tags}`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // --- cairn_cleanup ---------------------------------------------------------

  server.registerTool(
    'cairn_cleanup',
    {
      title: 'Cleanup Memories',
      description: 'Bulk delete memories by filter. Use "preview" first to see what would be deleted, then "execute" to delete.',
      annotations: { readOnlyHint: false, destructiveHint: true },
      inputSchema: z.object({
        action: z.enum(['preview', 'execute']).describe('"preview" to see matches, "execute" to delete'),
        filter: z.object({
          project: z.string().optional().describe('Filter by project ID'),
          kind: z.enum(LEARNABLE_KINDS).optional().describe('Filter by memory kind'),
          max_confidence: z.number().optional().describe('Delete below this confidence threshold'),
          older_than_days: z.number().int().positive().optional().describe('Delete older than N days'),
          never_recalled: z.boolean().optional().describe('Only delete memories with 0 recalls'),
        }).describe('Filter criteria for cleanup'),
      }),
    },
    async ({ action, filter }) => {
      const critical = isCritical(getMode());
      if (critical) return critical;

      const cleanupFilter = {
        // Destructive op: an explicit empty/unknown project must match NOTHING,
        // never fall through to "all" — keep the raw value when it doesn't resolve.
        project: filter.project === undefined ? undefined : (repo.resolveProject(filter.project) ?? filter.project),
        kind: filter.kind,
        maxConfidence: filter.max_confidence,
        olderThanDays: filter.older_than_days,
        neverRecalled: filter.never_recalled,
      };

      if (action === 'preview') {
        const matches = repo.findByFilter(cleanupFilter, LIMITS.CLEANUP_MAX_DELETE);
        if (matches.length === 0) {
          return { content: [{ type: 'text', text: 'No memories match this filter.' }] };
        }
        const previewPid = sessionProjectId();
        const sample = matches.slice(0, 5).map(m =>
          canReadPrivate(m.project, previewPid)
            ? `  • [${m.kind}] "${formatMemoryContent({ ...m, content: m.content.slice(0, 80) })}" (conf: ${m.confidence.toFixed(2)})`
            : `  • [${m.kind}] [private project — content hidden] (conf: ${m.confidence.toFixed(2)})`
        );
        const lines = [
          `Would delete ${matches.length} memories (max ${LIMITS.CLEANUP_MAX_DELETE}).`,
          'Sample:',
          ...sample,
        ];
        if (matches.length > 5) lines.push(`  ... and ${matches.length - 5} more`);
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      // Attempt user confirmation via MCP elicitation before bulk delete
      if (innerServer) {
        try {
          const preview = repo.findByFilter(cleanupFilter, LIMITS.CLEANUP_MAX_DELETE);
          if (preview.length === 0) {
            return { content: [{ type: 'text', text: 'No memories match this filter.' }] };
          }
          const result = await innerServer.elicitInput({
            message: `Delete ${preview.length} memories? This cannot be undone.`,
            requestedSchema: {
              type: 'object' as const,
              properties: {
                confirm: {
                  type: 'boolean' as const,
                  title: 'Confirm deletion',
                  description: `Delete ${preview.length} memories matching the filter`,
                },
              },
              required: ['confirm'],
            },
          });
          if (result.action !== 'accept' || !(result.content as Record<string, unknown>)?.confirm) {
            return { content: [{ type: 'text', text: 'Cleanup cancelled by user.' }] };
          }
        } catch {
          // Client doesn't support elicitation — proceed without confirmation
        }
      }

      // N5: destruction follows readability — an agent that cannot read a
      // private project's rows must not be able to delete them either
      // (the preview redacts their content; deleting them anyway would
      // protect confidentiality while surrendering integrity).
      const candidates = repo.findByFilter(cleanupFilter, LIMITS.CLEANUP_MAX_DELETE);
      const executePid = sessionProjectId();
      const deletable = candidates.filter(m => canReadPrivate(m.project, executePid));
      const skippedPrivate = candidates.length - deletable.length;
      // One statement — a per-row loop an interruption leaves half-applied
      // would trade cleanup's atomicity for the private-row exclusion.
      const deleted = repo.deleteByIds(deletable.map(m => m.id));
      if (deleted > 0) bumpCache(sessionCache);
      const note = skippedPrivate > 0
        ? ` (${skippedPrivate} in private project(s) skipped — run from a session inside the project)` : '';
      return { content: [{ type: 'text', text: `deleted ${deleted}${note}` }] };
    },
  );
}

// --- Helpers ----------------------------------------------------------------

function modeAdjustedLimit(mode: ContextMode, requested?: number): number {
  const defaults: Record<ContextMode, number> = {
    normal: LIMITS.RECALL_DEFAULT,
    compact: LIMITS.RECALL_COMPACT,
    minimal: LIMITS.RECALL_MINIMAL,
    critical: 0,
  };
  const modeMax = defaults[mode];
  if (requested !== undefined) return Math.min(requested, modeMax);
  return modeMax;
}

/** Auto-create 'informs' edges between a new memory and similar memories of different kinds.
 *  Uses embedding cosine similarity to catch semantic relationships that FTS misses.
 *  Bounded: checks max 1 other kind, creates max 1 edge per learn. */
function createCrossKindEdges(
  repo: MemoryRepository,
  edgeRepo: EdgeRepository,
  newId: string,
  content: string,
  kind: string,
  project: string | null,
  embedding: Buffer,
): void {
  // Search for similar memories of different kinds via FTS (fast, no model needed)
  const candidates = repo.search(content, {
    project: project ?? undefined,
    maxResults: 5,
    minConfidence: 0,
  });

  // Filter to different kinds and check embedding similarity
  for (const { memory: candidate } of candidates) {
    if (candidate.kind === kind) continue;
    if (candidate.id === newId) continue;

    // Use proxy embedding search: fetch candidate's embedding and compute cosine
    const candidateEmb = repo.getEmbedding(candidate.id);
    if (!candidateEmb) continue;

    // Use bufferToEmbedding for safe alignment (Buffer byteOffset may not be multiple of 4)
    const sim = cosineSimilarity(
      bufferToEmbedding(embedding),
      bufferToEmbedding(candidateEmb),
    );

    if (sim >= RELEVANCE.CROSS_KIND_EDGE_THRESHOLD) {
      edgeRepo.createEdge(newId, candidate.id, 'informs', sim);
      return; // Max 1 cross-kind edge per learn
    }
  }
}
