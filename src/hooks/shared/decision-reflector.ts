/**
 * Decision reflector — Layer 1c, the Socratic Stop reflection.
 *
 * Two components:
 *
 *   1. countDecisionMarkers(text)  — cheap pre-gate, pure regex
 *      Counts decision-indicative phrases in an assistant turn without
 *      trying to extract content. Runs unconditionally on every Stop.
 *      Used to short-circuit the expensive LLM call when there's nothing
 *      to reflect on.
 *
 *   2. reflectOnTurn(message, innerServer) — LLM-backed extraction
 *      When markers are present and no sigils were emitted, asks a
 *      capability-gated LLM (via MCP sampling) to extract decisions as
 *      strict JSON. Haiku-preferred for cost. Falls back to an empty
 *      array on any failure — capability missing, parse error, timeout,
 *      or API error — so the caller can route to the tier-3 nudge path.
 *
 * Why this architecture, not wider regex:
 *   - The legacy prose extractor rejects markdown-heavy text via length
 *     and bold/header gates. Widening those gates risks false-positive
 *     explosion.
 *   - mem0, A-MEM, and mem-agent (2025 state-of-the-art) all use LLM
 *     extraction at ingest. We adopt the same pattern but gate it on a
 *     cheap signal counter so non-decision turns pay zero inference.
 *   - Sigils (Layer 1a) remain the primary path — cheaper, zero false
 *     positives, and deterministic. Reflection is the safety net for
 *     turns where the agent forgot to sigilize.
 *
 * Runtime cost: ~0µs on non-decision turns (marker counter miss), one
 * inference on decision turns without sigils. Fire-and-forget from the
 * caller's perspective so Stop latency is unaffected by the LLM call.
 */
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { REFLECTION, TRUNCATE } from '../../constants/index.js';
import { truncateAscii } from '../../utils/text.js';

// --- Tunables --------------------------------------------------------

// --- Marker patterns -------------------------------------------------
//
// These are broader than extractAssistantDecision's choiceSignals because
// the goal here is RECALL, not precision. False positives are fine — the
// LLM reflection pass is the precision filter.

const DECISION_MARKER_PATTERNS: RegExp[] = [
  // Recommendation verbs
  /\b(i'?d recommend|i recommend|my recommendation|i'?d suggest|i suggest)\b/i,
  // Choice verbs (legacy extractor's set, unconditionally)
  /\b(i'?ll use|going with|chose|choosing|i chose|opted for|opt for|decided to)\b/i,
  // Pushback / rejection (decisions by negation)
  /\b(i'?d push back|wouldn'?t|shouldn'?t|don'?t build|against building|avoid)\b/i,
  // Comparison framing
  /\b(instead of|rather than|over (?:the )?(?:alternative|other)|prefer \w+ to)\b/i,
  // Architecture language
  /\b(the approach is|the design|the strategy|the right (?:shape|path|move)|the cheaper \w+)\b/i,
  // Trade-off framing
  /\b(trade-?off|the cost is|the payoff|the gap is|worth (?:building|the))\b/i,
  // Sigil (if present, count it — sigils should have pre-empted reflection
  // but surface them here for telemetry if caller skipped the gate)
  /\[dec:\s*[^\]\n]{4,}\]/i,
];

// --- countDecisionMarkers --------------------------------------------

/**
 * Count decision-indicative phrases in assistant text. Does NOT try to
 * extract content — only counts matches against the marker set.
 *
 * Code fences and inline backticks are stripped first so examples of
 * decision language in documentation (e.g. "you can write `i'll use X`")
 * don't inflate the count.
 *
 * Returns: integer count of marker pattern matches across the cleaned
 * text. Each pattern can match at most once per call (Set-dedup) to
 * prevent a single verbose decision from inflating the count and
 * triggering on weak signal.
 */
export function countDecisionMarkers(text: string): number {
  if (!text || text.length < 20) return 0;

  // Strip fenced blocks and inline code so examples/docs aren't counted.
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');

  let count = 0;
  for (const pattern of DECISION_MARKER_PATTERNS) {
    if (pattern.test(cleaned)) count++;
  }
  return count;
}

// --- reflectOnTurn ---------------------------------------------------

/**
 * Structured decision extracted by the reflector.
 * `chose`   — one-sentence summary of what was picked
 * `why`     — one-sentence rationale for the choice
 */
export interface ReflectedDecision {
  chose: string;
  why: string;
}

/** Render a ReflectedDecision into a single-line content string suitable
 *  for storage as a decision memory. Mirrors the shape the legacy
 *  extractor stores: "chose X because Y". */
export function renderReflectedDecision(d: ReflectedDecision): string {
  const chose = d.chose.trim();
  const why = d.why.trim();
  if (!chose) return '';
  if (!why) return chose.slice(0, TRUNCATE.DECISION_FULL_CHARS);
  return truncateAscii(`${chose} because ${why}`, TRUNCATE.DECISION_FULL_CHARS);
}

/** Shape of the structured JSON we ask the LLM to return. */
interface ReflectionResponse {
  decisions: ReflectedDecision[];
}

/** Parse the LLM response text into a ReflectionResponse. Tolerates
 *  common model quirks — leading/trailing prose, markdown code fences,
 *  smart-quoted JSON. Returns an empty decision list on any failure. */
function parseReflectionResponse(raw: string): ReflectedDecision[] {
  if (!raw || raw.length < 2) return [];

  // Strip markdown code fences the model may wrap JSON in
  let text = raw.trim();
  text = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');

  // Find the first {..} block — ignore leading explanatory prose
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace <= firstBrace) return [];
  const jsonSlice = text.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return [];
  }

  // Narrow to ReflectionResponse shape defensively
  if (!parsed || typeof parsed !== 'object') return [];
  const candidate = parsed as Partial<ReflectionResponse>;
  if (!Array.isArray(candidate.decisions)) return [];

  const clean: ReflectedDecision[] = [];
  for (const d of candidate.decisions) {
    if (!d || typeof d !== 'object') continue;
    const chose = typeof (d as ReflectedDecision).chose === 'string' ? (d as ReflectedDecision).chose : '';
    const why = typeof (d as ReflectedDecision).why === 'string' ? (d as ReflectedDecision).why : '';
    if (chose.length >= 3) clean.push({ chose, why });
    if (clean.length >= REFLECTION.MAX_DECISIONS) break;
  }
  return clean;
}

/** System prompt for the reflector. Instructs the model to return strict
 *  JSON and reject trivial/tool-level choices. Kept short to minimize
 *  input cost. */
const REFLECTION_SYSTEM_PROMPT =
  'You extract architectural decisions from an AI assistant turn. ' +
  'A "decision" is a choice between real alternatives WITH rationale — ' +
  'architecture, dependencies, design patterns, trade-offs. ' +
  'NOT tool-level choices (which file to read, which command to run). ' +
  'NOT descriptive prose or status updates. ' +
  'Return STRICT JSON only: {"decisions":[{"chose":"...","why":"..."}]}. ' +
  'At most 3 decisions. If none, return {"decisions":[]}. No prose.';

/** User prompt builder. Includes the truncated turn text. */
function buildUserPrompt(message: string): string {
  const truncated = message.length > REFLECTION.INPUT_MAX_CHARS
    ? message.slice(0, REFLECTION.INPUT_MAX_CHARS) + '\n[...truncated]'
    : message;
  return `Extract decisions from this assistant turn as strict JSON:\n\n${truncated}`;
}

/** Shape of a client-capabilities query — present on the MCP inner
 *  server when the client (Claude Code) has negotiated sampling. */
interface CapabilityProbe {
  getClientCapabilities?: () => { sampling?: unknown } | null | undefined;
}

/**
 * Ask the host LLM to extract decisions from an assistant turn.
 *
 * Capability-gated via MCP sampling (same pattern as utils/distillation.ts).
 * When sampling is unavailable — either because innerServer is undefined
 * (hook running standalone, not through the socket) or because the client
 * didn't negotiate sampling — returns an empty array immediately. Callers
 * use that as the signal to fall back to the marker-counter nudge path.
 *
 * Never throws. Any error (capability missing, API error, timeout, parse
 * failure) resolves to an empty array.
 */
export async function reflectOnTurn(
  message: string,
  innerServer: Server | undefined,
): Promise<ReflectedDecision[]> {
  if (!innerServer) return [];
  if (!message || message.length < 40) return [];

  // Capability probe — if the client didn't negotiate sampling, bail
  // cheaply. Matches the distillation.ts pattern.
  try {
    const caps = (innerServer as unknown as CapabilityProbe).getClientCapabilities?.();
    if (!caps || !caps.sampling) return [];
  } catch {
    return [];
  }

  const userPrompt = buildUserPrompt(message);

  // Race the sampling call against the timeout. If the model is slow,
  // we'd rather ship an empty reflection than delay the next user prompt.
  const samplingPromise = innerServer.createMessage({
    messages: [{
      role: 'user',
      content: { type: 'text', text: userPrompt },
    }],
    systemPrompt: REFLECTION_SYSTEM_PROMPT,
    maxTokens: 400,
    modelPreferences: {
      hints: [{ name: 'haiku' }],
      costPriority: 0.9,
      speedPriority: 0.8,
      intelligencePriority: 0.3,
    },
  });

  // Keep the timer handle so it can be cleared once the race settles —
  // otherwise every Stop event pins a 10s timer that delays GC of the chain.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>(resolve => {
    timeoutHandle = setTimeout(() => resolve(null), REFLECTION.TIMEOUT_MS);
  });

  let result: Awaited<typeof samplingPromise> | null;
  try {
    result = await Promise.race([samplingPromise, timeoutPromise]);
  } catch {
    return [];
  } finally {
    clearTimeout(timeoutHandle);
  }
  if (!result) return [];

  // Extract the text content from the sampling response. MCP's createMessage
  // returns content either as an array of content blocks OR a single block,
  // depending on SDK version — handle both.
  let raw = '';
  const content = result.content;
  if (Array.isArray(content)) {
    const textBlock = content.find((c: { type: string }) => c.type === 'text');
    if (textBlock && 'text' in textBlock) raw = (textBlock as { text: string }).text;
  } else if (content && typeof content === 'object' && 'type' in content && (content as { type: string }).type === 'text') {
    raw = (content as { text: string }).text;
  }

  if (!raw) return [];
  return parseReflectionResponse(raw);
}
