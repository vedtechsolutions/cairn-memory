/**
 * Relevance scoring for pitfall surfacing.
 * Determines whether a pitfall should be injected based on current context.
 */
import { SCORING_PROFILES } from '../constants/index.js';
import { recencyBucketBoost } from './scoring-primitives.js';

const TAG_PROFILE = SCORING_PROFILES.SURFACING.TAG_RELEVANCE;
import type { Memory } from '../db/memory-repository.js';

export interface RelevanceContext {
  filePath?: string;
  command?: string;
  userMessage?: string;
}

/** Score a pitfall's relevance to the current context */
export function scoreRelevance(memory: Memory, ctx: RelevanceContext): number {
  const tagMatch = computeTagMatch(memory.tags, ctx);
  // Shared primitive (W3) — this file previously carried its own copy of
  // the recency buckets, which had already drifted into a third variant.
  const recencyBoost = recencyBucketBoost(memory.last_recalled);
  return tagMatch * memory.confidence * recencyBoost;
}

/** Check if a relevance score passes the injection threshold (strict >) */
export function isRelevant(score: number): boolean {
  return score > TAG_PROFILE.INJECTION_THRESHOLD;
}

function computeTagMatch(tags: string[], ctx: RelevanceContext): number {
  if (tags.length === 0) return 0;

  let score = 0;

  if (ctx.filePath) {
    const ext = extractExtension(ctx.filePath);
    const pathParts = ctx.filePath.toLowerCase().split('/');

    for (const tag of tags) {
      const lower = tag.toLowerCase();
      if (ext && lower === ext) score += TAG_PROFILE.EXTENSION_WEIGHT;
      if (pathParts.some(p => p === lower)) score += TAG_PROFILE.PATH_PART_WEIGHT;
    }
  }

  if (ctx.command) {
    const commandLower = ctx.command.toLowerCase();
    for (const tag of tags) {
      if (commandLower.includes(tag.toLowerCase())) score += TAG_PROFILE.COMMAND_WEIGHT;
    }
  }

  if (ctx.userMessage) {
    const msgLower = ctx.userMessage.toLowerCase();
    for (const tag of tags) {
      if (msgLower.includes(tag.toLowerCase())) score += TAG_PROFILE.MESSAGE_WEIGHT;
    }
  }

  return Math.min(score, 1.0);
}

function extractExtension(filePath: string): string | null {
  const parts = filePath.split('.');
  if (parts.length < 2) return null;
  return parts[parts.length - 1].toLowerCase();
}
