/**
 * Retrospective learning at session end: iteration-cost pitfalls for files
 * that needed too many edits, and winning patterns mined from smooth
 * sessions. Split from session-end.ts (phase 4).
 */
import { basename } from 'node:path';
import type { SessionEndInput } from '../hook-io.js';
import type { HookDbClient } from '../db-client.js';
import { loadTracker } from '../edit-tracker.js';
import { LIMITS, CONFIDENCE } from '../../../constants/index.js';
import { extractWinningPattern } from '../transcript-parser.js';
import { originClientOf, readTranscriptSnapshotFor } from '../client-adapter.js';
import { generateFingerprint } from '../../../utils/fingerprint.js';
import { getGitHash } from '../../../utils/project-scanner.js';
import type { SessionQuality } from './session-quality.js';

export function runRetrospective(
  client: HookDbClient, input: SessionEndInput, project: string, quality: SessionQuality,
): void {
  // --- Phase 3: retrospective learning — iteration-cost pitfalls + wins ---
  // Walk the per-file edit counter from the tracker. Files that required
  // more than ITERATION_COST_THRESHOLD edits produce an auto-pitfall
  // (capped at ITERATION_COST_MAX_PER_SESSION so a single thrashy session
  // can't flood memory). On smooth sessions, mine the approach notes for
  // winning patterns and store them as kind='pattern' memories. Must run
  // BEFORE deleteTracker below so we still have the edit counts.
  try {
    const retroTracker = loadTracker(input.session_id);
    const editCounts = retroTracker.editCountsByFile ?? {};

    let projectContext = null;
    try {
      const hash = getGitHash(input.cwd);
      if (hash) projectContext = client.contextRepo.get(project, hash);
      if (!projectContext) projectContext = client.contextRepo.getLatest(project);
    } catch { /* best-effort */ }
    const retroFp = generateFingerprint({ projectContext });

    // Iteration-cost pitfalls — sorted by count DESC so the worst offenders
    // land first when the per-session cap is tight.
    const overBudget = Object.entries(editCounts)
      .filter(([, count]) => count > LIMITS.ITERATION_COST_THRESHOLD)
      .sort((a, b) => b[1] - a[1])
      .slice(0, LIMITS.ITERATION_COST_MAX_PER_SESSION);

    for (const [file, count] of overBudget) {
      const base = basename(file);
      const lesson = `${base} required ${count} edits in one session — read the file more carefully and plan the full change before editing next time.`;
      client.memoryRepo.create({
        content: lesson,
        kind: 'pitfall',
        project,
        source: 'learned',
        originClient: originClientOf(input),
        confidence: CONFIDENCE.AUTO_DETECTED,
        fingerprint: retroFp,
      });
    }

    // Pattern mining — only on smooth sessions with real progress, and only
    // when the session wasn't also thrashy (no iteration-cost pitfalls from
    // this same session). A session with iteration pitfalls wasn't clean
    // enough to produce a reliable winning pattern.
    if (overBudget.length === 0 && quality.label === 'smooth' && quality.stepsCompleted > 0) {
      try {
        const retroSnapshot = readTranscriptSnapshotFor(input, input.transcript_path);
        const patterns: string[] = [];
        // Scan approach notes first — these are already pre-filtered to
        // strategy-like content.
        for (const note of retroSnapshot.approachNotes) {
          if (patterns.length >= LIMITS.PATTERN_MINE_MAX_PER_SESSION) break;
          const p = extractWinningPattern(note);
          if (p && !patterns.includes(p)) patterns.push(p);
        }
        for (const p of patterns) {
          client.memoryRepo.create({
            content: p,
            kind: 'pattern',
            project,
            source: 'learned',
            originClient: originClientOf(input),
            confidence: CONFIDENCE.AUTO_DETECTED,
            fingerprint: retroFp,
          });
        }
      } catch { /* best-effort — pattern mining must never block session end */ }
    }
  } catch { /* retrospective is best-effort */ }
}
