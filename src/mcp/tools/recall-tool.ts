/**
 * waykeep_recall — read-only retrieval with the scope policy, the
 * cross-project guard, optional reranking and graph enrichment.
 */
import * as z from 'zod/v4';
import { formatMemoryContent, formatAuxText } from '../../utils/memory-injection.js';
import { LIMITS, FINGERPRINT, RETRIEVAL_PATHS, RERANK_FALLBACK_LABEL, type RetrievalPathKind, type ContextMode } from '../../constants/index.js';
import { RERANK } from '../../constants/reranker-models.js';
import { generateFingerprint } from '../../utils/fingerprint.js';
import { surfacesInScopedRecall } from '../../utils/cross-project-guard.js';
import { canReadPrivate } from '../../config/waykeep-config.js';
import { sessionProjectId } from '../../utils/session-project.js';
import { isCritical, registerToolCompat } from './helpers.js';
import { embedQuery, embeddingToBuffer, isEmbeddingReady } from '../../utils/embeddings.js';
import { TOOL } from '../../constants/mcp.js';
import { log } from '../../utils/log.js';
import type { MemoryToolDeps } from './memory-tool-deps.js';

export function registerRecallTool(deps: MemoryToolDeps): void {
  const { server, repo, getMode, rerankerImpl, contextRepo } = deps;
  // --- waykeep_recall ----------------------------------------------------------

  registerToolCompat(server,
    TOOL.RECALL,
    {
      title: 'Recall Memories',
      description: 'Retrieve relevant memories for a topic or task. Returns pitfalls, decisions, corrections, and facts ranked by relevance.',
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      inputSchema: z.object({
        query: z.string().max(LIMITS.MAX_STRING_PARAM).describe('What you are about to do — used to find relevant memories'),
        project: z.string().max(LIMITS.MAX_STRING_PARAM).optional().describe('Scope to a specific project ID'),
        max_results: z.number().int().positive().optional().describe('Max results (default: 5)'),
        scope: z.enum(['all', 'project', 'global']).optional().describe("Result scope: 'all' (default) = the target project's rows plus globals; 'project' = ONLY the target project's own rows; 'global' = ONLY global rows. The target project is the `project` argument when given, else this session's own project."),
      }),
    },
    async ({ query, project, max_results: maxResults, scope }) => {
      const mode = getMode();
      const critical = isCritical(mode);
      if (critical) return critical;

      // Resolve a bare project name (e.g. "cairn") to its full id for scoping.
      //
      // SYMMETRY (remediation step 2): when `project` is omitted, default to
      // the session's own project — the same default `waykeep_learn` applies —
      // so a lesson stored by this session is visible to this session's next
      // bare recall. Before this, bare recall searched GLOBAL-ONLY, and a
      // freshly learned project-scoped pitfall was unreachable seconds later
      // (incident mechanism R6). Globals still surface either way; the
      // explicit global-ONLY mode is scope: 'global' below — omitting the
      // argument was never a documented way to exclude project rows.
      const resolvedProject = scope === 'global'
        ? null // global-only retrieves GLOBAL candidates — filtering a session-scoped window can crowd every global out
        : project !== undefined
          ? repo.resolveProject(project) ?? null
          : sessionProjectId();
      if (scope === 'project' && !resolvedProject) {
        return { content: [{ type: 'text' as const, text: "error: scope: 'project' needs a target — pass `project`, or run the session inside a workspace so it has one of its own" }], isError: true };
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
      // read-only, cross-encode, keep the top `limit`. No recall side
      // effects exist anywhere in this tool (step 7) — candidates and
      // returned results alike stay unstamped.
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
      if (scope === 'global') {
        results = results.filter(r => r.memory.project === null);
      }

      // Cross-project guard (same filter the hook/briefing paths apply): a
      // global memory surfaces in a project-scoped recall only when its
      // fingerprint overlaps the project's — blocking mis-scoped globals such
      // as an Odoo pitfall stored global. The query fingerprint comes from the
      // project's stored context, exactly as on the UserPromptSubmit path;
      // absent context yields an empty fp → fail closed (block, never leak).
      // The mis-scoped-global fingerprint guard applies only when the CALLER
      // named a project — the pre-symmetry contract. Bare recall keeps every
      // global reachable exactly as it always did: applying the guard to the
      // session default silently hid 12 legitimate global lessons whose older
      // fingerprints spell 'node' where current contexts spell 'node.js'
      // (fingerprint drift — a store-repair concern, not a recall filter).
      const queryFp = project !== undefined && resolvedProject
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
          log.warn('rerank unavailable — returning RRF order (labeled)');
        } else {
          const byId = new Map(results.map(r => [r.memory.id, r]));
          results = reordered.map(c => byId.get(c.id)).filter((r): r is NonNullable<typeof r> => r !== undefined);
        }
      }
      // Slice to the requested limit AFTER filtering/reranking.
      // NO recall-stat or co-recall writes happen here (step 7 / M5): this
      // tool declares readOnlyHint: true and is now read-only in fact — a
      // diagnostic recall must not reinforce what it observes. Exposure
      // tracking (last_recalled / recall_count) is stamped by the
      // prompt-handler at its injection boundary (markRecalled on exactly
      // the ids whose budgetPush succeeded), never during retrieval.
      results = results.slice(0, limit);

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
        // A neighbor must belong to the target project or be global: with
        // session rows now serving as graph entry points, an edge would
        // otherwise smuggle ANOTHER project's row into a bare recall.
        results = results.filter(r =>
          directIds.has(r.memory.id) || r.memory.project === resolvedProject || r.memory.project === null);
        if (scope === 'project') {
          results = results.filter(r => directIds.has(r.memory.id) || r.memory.project === resolvedProject);
        }
        if (scope === 'global') {
          results = results.filter(r => directIds.has(r.memory.id) || r.memory.project === null);
        }
        if (queryFp) {
          results = results.filter(r => directIds.has(r.memory.id) || surfacesInScopedRecall(r.memory, resolvedProject, queryFp));
        }
      }

      // Which retrieval actually ran — the TYPED contract (step 5): the
      // strings come from RETRIEVAL_PATHS, never minted here. The FTS-only
      // degraded path can rank very differently from hybrid, so silence
      // would mislead exactly when results are least trustworthy. Minimal
      // mode gets a compact marker for the degraded case only.
      const pathKind: RetrievalPathKind = queryEmbedding ? 'hybrid' : 'fts_degraded';
      const retrievalPath = RETRIEVAL_PATHS[pathKind].header;
      const compactMarker = RETRIEVAL_PATHS[pathKind].compactMarker;

      if (results.length === 0) {
        const note = mode === 'minimal'
          ? `No relevant memories found.${compactMarker ? ' ' + compactMarker : ''}`
          : `No relevant memories found. [retrieval: ${retrievalPath}]`;
        return { content: [{ type: 'text', text: note }] };
      }

      const header = mode === 'minimal'
        ? (compactMarker ? [compactMarker] : [])
        : [`[retrieval: ${retrievalPath}]`];
      if (rerankFallback) header.push(RERANK_FALLBACK_LABEL);
      // After a successful rerank the ORDER is the cross-encoder's but the
      // numeric score is still the RRF fusion score — label it honestly so
      // a reader never mistakes it for the reranker's relevance score.
      // Graph neighbors get their own label; without reranking the generic
      // 'score' stays for all rows (pre-existing output format).
      const labelFor = (id: string): string => {
        if (!(rerankActive && !rerankFallback)) return 'score';
        return directIds.has(id) ? 'rrf_score' : 'graph_score';
      };
      const lines = results.map(({ memory: m, score }, rank) => {
        const scope = m.project ? `[${m.project}]` : '[global]';
        const tags = m.tags.length > 0 ? ` (${m.tags.map(formatAuxText).join(', ')})` : '';
        const why = m.context?.why ? ` (Why: ${formatAuxText(m.context.why)})` : '';

        if (mode === 'minimal') {
          return `• ${formatMemoryContent(m)}${why}`;
        }
        // Rank ordinal is explicit and the score keeps 4 decimals: RRF scores
        // live around 0.03 and collapse to indistinguishable values at 2 — the
        // misread that motivated this line's format (see incident fixture).
        return `• #${rank + 1} [${m.kind}] ${formatMemoryContent(m)}${why} ${scope}${tags} — conf: ${m.confidence.toFixed(2)}, ${labelFor(m.id)}: ${score.toFixed(4)}`;
      });

      return { content: [{ type: 'text', text: [...header, ...lines].join('\n') }] };
    },
  );
}

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
