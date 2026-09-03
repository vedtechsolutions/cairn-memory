/**
 * waykeep_correct, waykeep_forget, waykeep_strengthen, waykeep_weaken — the
 * by-id mutations, each behind the private-project mutation block.
 */
import * as z from 'zod/v4';
import { canReadPrivate } from '../../config/waykeep-config.js';
import { sessionProjectId } from '../../utils/session-project.js';
import { registerToolCompat } from './helpers.js';
import { sanitize } from '../../utils/validation.js';
import { scrubSecrets } from '../../utils/secret-scanner.js';
import { embed, embeddingToBuffer, isEmbeddingReady } from '../../utils/embeddings.js';
import { TOOL } from '../../constants/mcp.js';
import { bumpCache, type MemoryToolDeps } from './memory-tool-deps.js';

export function registerCurationTools(deps: MemoryToolDeps): void {
  const { server, repo, sessionCache } = deps;
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

  // --- waykeep_correct ---------------------------------------------------------

  registerToolCompat(server,
    TOOL.CORRECT,
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

  // --- waykeep_forget ----------------------------------------------------------

  registerToolCompat(server,
    TOOL.FORGET,
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

  // --- waykeep_strengthen ------------------------------------------------------

  registerToolCompat(server,
    TOOL.STRENGTHEN,
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

  // --- waykeep_weaken ----------------------------------------------------------

  registerToolCompat(server,
    TOOL.WEAKEN,
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
}
