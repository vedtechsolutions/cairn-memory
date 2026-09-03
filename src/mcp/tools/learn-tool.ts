/**
 * waykeep_learn — validation, secret scrubbing, scope defaults, embedding,
 * anchor extraction, the kind-specific write gateways and cross-kind edges.
 */
import * as z from 'zod/v4';
import type { MemoryRepository } from '../../db/memory-repository.js';
import type { EdgeRepository } from '../../db/edge-repository.js';
import { deriveOriginClient } from '../../hooks/shared/client-adapter.js';
import { LEARNABLE_KINDS, LIMITS, RELEVANCE, CONFIDENCE } from '../../constants/index.js';
import { sessionProjectId } from '../../utils/session-project.js';
import { registerToolCompat } from './helpers.js';
import { sanitize } from '../../utils/validation.js';
import { scrubSecrets } from '../../utils/secret-scanner.js';
import {
  validateMemoryContent,
  validateTags,
  validateContentQuality,
  detectRelativeDates,
  isLearnableKind,
} from '../../utils/validation.js';
import { embed, embeddingToBuffer, isEmbeddingReady, bufferToEmbedding } from '../../utils/embeddings.js';
import { extractAnchor, anchorToJson } from '../../utils/anchor.js';
import { cosineSimilarity } from '../../utils/similarity.js';
import { TOOL } from '../../constants/mcp.js';
import { bumpCache, type MemoryToolDeps } from './memory-tool-deps.js';

export function registerLearnTool(deps: MemoryToolDeps): void {
  const { server, repo, innerServer, edgeRepo, sessionCache } = deps;
  // --- waykeep_learn -----------------------------------------------------------

  registerToolCompat(server,
    TOOL.LEARN,
    {
      title: 'Learn Memory',
      description: 'Store a distilled lesson. One sentence preferred. Deduplicates automatically.',
      annotations: { readOnlyHint: false, destructiveHint: false },
      inputSchema: z.object({
        content: z.string().max(LIMITS.MAX_CONTENT_CHARS).describe('The distilled lesson — one sentence preferred'),
        kind: z.enum(LEARNABLE_KINDS).describe('Memory kind: pitfall, decision, correction, fact, user_profile, or reference'),
        tags: z.array(z.string().max(LIMITS.MAX_TAG_CHARS)).max(LIMITS.MAX_TAGS).optional()
          .describe(`Free-form tags for retrieval (max ${LIMITS.MAX_TAGS})`),
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
      let effectiveProject: string | null;
      if (kind === 'user_profile') {
        effectiveProject = null;
      } else if (project !== undefined) {
        effectiveProject = project;
      } else if (kind === 'correction') {
        effectiveProject = null;
      } else {
        // Fail EXPLICITLY when the session project cannot be derived: the old
        // code threw here, and silently storing a project-default lesson as
        // GLOBAL widens its audience without the user choosing that.
        const sessionProject = sessionProjectId();
        if (sessionProject === null) {
          return { content: [{ type: 'text', text: 'error: no session project could be derived — pass `project` explicitly (a project id, or null for global scope)' }], isError: true };
        }
        effectiveProject = sessionProject;
      }

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
            // DELIBERATE learning (step 3): a pitfall stored through this tool
            // was a conscious act, not a miner's guess — born strictly above
            // the injection gate instead of inheriting AUTO_DETECTED, which
            // left it invisible on every confidence-gated recall/injection
            // surface until reinforced (incident mechanism M7).
            confidence: CONFIDENCE.DELIBERATE,
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
