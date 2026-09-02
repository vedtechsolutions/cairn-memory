/**
 * Per-question isolated store construction (roadmap W1 slice 2).
 *
 * Evaluation protocol requirements (Codex review, upstream-verified):
 *   - one isolated DB per question (each question has its own haystack);
 *   - corpus modes: 'user-only' mirrors the official flat turn index
 *     (run_retrieval.py ingests user turns only — assistant replies often
 *     paraphrase evidence and inflate session recall); 'all-roles' is a
 *     separately-labeled Waykeep experiment;
 *   - turn-preserving ingestion — one memory per turn at its ORIGINAL turn
 *     index (official doc ids are sessionId_<1-indexed original position>),
 *     split only when a single turn exceeds the chunk bound;
 *   - verbatim corpus: dedup AND truth-maintenance conflict detection are
 *     bypassed — opposing version claims are both retrieval targets, and
 *     supersession would hide the older one from search;
 *   - uniform confidence in retrieval-only mode;
 *   - the live store must never be touched.
 */
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../../db/connection.js';
import { MemoryRepository } from '../../db/memory-repository.js';
import { type LmeQuestion, parseSessionDate } from './data.js';
import { realHomeDataDir } from '../../constants/paths.js';

export const LME_PROJECT = 'lme-bench';
/** Uniform ingest confidence — any value works as long as it is identical for
 *  every memory (retrieval-only mode must not let confidence rank results). */
export const UNIFORM_CONFIDENCE = 0.65;
/** Split threshold for a single oversized turn (~512 tokens at ~4 chars/token) */
export const MAX_TURN_CHARS = 2000;

/** 'user-only' = official protocol; 'all-roles' = labeled Waykeep experiment. */
export type CorpusMode = 'user-only' | 'all-roles';

export interface TurnRef {
  sessionId: string;
  /** 0-based occurrence index of this session id within the haystack. The
   *  real data repeats identical filler sessions at different dates; upstream
   *  keeps each occurrence as a separate corpus entry, so occurrences must
   *  stay distinguishable for official_compat ranking (their turn doc ids
   *  collide by design). */
  occurrence: number;
  /** ORIGINAL 0-based turn position within the session (assistant turns
   *  count toward the index even when not ingested — official doc ids are
   *  built from the full-session enumeration). */
  turnIdx: number;
}

export interface QuestionStore {
  db: Database.Database;
  repo: MemoryRepository;
  corpusMode: CorpusMode;
  /** memory id → source session id */
  memoryToSession: Map<string, string>;
  /** memory id → source turn */
  memoryToTurn: Map<string, TurnRef>;
  /** ingested turns in corpus order (one entry per turn, not per chunk) —
   *  the official metrics' corpus relevance vector is built from this */
  corpusTurns: TurnRef[];
  /** evidence turns (official has_answer labels) among INGESTED turns */
  evidenceTurns: TurnRef[];
  close(): void;
}

/** Refuse to operate anywhere near the live store — the benchmark must be
 *  impossible to point at ~/.cairn by accident. */
export function assertNotLiveStore(dbPath: string): void {
  if (dbPath === ':memory:') return;
  const resolved = resolve(dbPath);
  const liveDir = realHomeDataDir();
  if (resolved === liveDir || resolved.startsWith(liveDir + '/')) {
    throw new Error(`benchmark refuses to touch the live store directory: ${resolved}`);
  }
}

/** Split an oversized turn into bounded chunks on whitespace; a turn within
 *  the bound stays whole. A single whitespace-free token longer than the
 *  bound is hard-sliced so no chunk can ever exceed maxChars. */
export function splitTurn(content: string, maxChars: number = MAX_TURN_CHARS): string[] {
  if (content.length <= maxChars) return [content];
  const words: string[] = [];
  for (const word of content.split(/\s+/)) {
    if (word.length <= maxChars) {
      words.push(word);
    } else {
      for (let i = 0; i < word.length; i += maxChars) {
        words.push(word.slice(i, i + maxChars));
      }
    }
  }
  const chunks: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length + word.length + 1 > maxChars && current.length > 0) {
      chunks.push(current);
      current = word;
    } else {
      current = current.length > 0 ? `${current} ${word}` : word;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/** Build a fresh in-memory store containing exactly one question's haystack.
 *  Always ':memory:' — strongest isolation (per review, no custom paths). */
export function buildQuestionStore(
  question: LmeQuestion,
  options: { corpusMode?: CorpusMode } = {},
): QuestionStore {
  const corpusMode = options.corpusMode ?? 'user-only';
  const db = openDatabase({ dbPath: ':memory:' });
  const repo = new MemoryRepository(db);
  const memoryToSession = new Map<string, string>();
  const memoryToTurn = new Map<string, TurnRef>();
  const corpusTurns: TurnRef[] = [];
  const evidenceTurns: TurnRef[] = [];

  const occurrenceCounter = new Map<string, number>();
  question.haystack_sessions.forEach((session, si) => {
    const sessionId = question.haystack_session_ids[si];
    const createdAt = parseSessionDate(question.haystack_dates[si]);
    const occurrence = occurrenceCounter.get(sessionId) ?? 0;
    occurrenceCounter.set(sessionId, occurrence + 1);

    session.forEach((turn, ti) => {
      if (corpusMode === 'user-only' && turn.role !== 'user') return;
      const trimmed = turn.content.trim();
      if (trimmed.length === 0) return;

      const ref: TurnRef = { sessionId, occurrence, turnIdx: ti };
      corpusTurns.push(ref);
      if (turn.has_answer === true) evidenceTurns.push(ref);

      // Deliberately NO tags: memories_fts indexes the tags column, so any
      // metadata written there becomes retrievable text. A role tag like
      // "lme:role:user" tokenizes to "user" and matches every question that
      // says "the user" — the fixture's designed-miss question caught this.
      // Session/turn identity lives only in the in-memory maps.
      for (const chunk of splitTurn(trimmed)) {
        const result = repo.create({
          content: chunk,
          kind: 'fact',
          project: LME_PROJECT,
          confidence: UNIFORM_CONFIDENCE,
          createdAt,
          skipDedup: true,
          skipConflictDetection: true,
        });
        memoryToSession.set(result.id, sessionId);
        memoryToTurn.set(result.id, ref);
      }
    });
  });

  return {
    db, repo, corpusMode, memoryToSession, memoryToTurn, corpusTurns, evidenceTurns,
    close: () => db.close(),
  };
}
