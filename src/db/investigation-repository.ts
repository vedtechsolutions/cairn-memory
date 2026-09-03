/**
 * Investigation chain repository — tracks debugging sequences as coherent chains.
 * Stores trigger → attempts → resolution so post-compaction briefings can surface
 * "skip A and B, go straight to C" instead of isolated error pitfalls.
 */
import type Database from 'better-sqlite3';
import { generateId, now } from '../utils/index.js';
import { LIMITS } from '../constants/index.js';

export interface ChainAttempt {
  approach: string;
  outcome: string;
  timestamp: string;
}

export interface InvestigationChain {
  id: string;
  project: string;
  session_id: string;
  trigger_error: string;
  attempts: ChainAttempt[];
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
  memory_ids: string[];
}

interface ChainRow {
  id: string;
  project: string;
  session_id: string;
  trigger_error: string;
  attempts: string;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
  memory_ids: string;
}

export class InvestigationRepository {
  constructor(private db: Database.Database) {}

  private rowToChain(row: ChainRow): InvestigationChain {
    return {
      ...row,
      attempts: JSON.parse(row.attempts) as ChainAttempt[],
      memory_ids: JSON.parse(row.memory_ids) as string[],
    };
  }

  /** Create a new investigation chain from the first error. */
  create(project: string, sessionId: string, triggerError: string, firstAttempt: ChainAttempt): InvestigationChain {
    const id = generateId();
    const timestamp = now();
    const attempts = [firstAttempt];

    this.db.prepare(`
      INSERT INTO investigation_chains (id, project, session_id, trigger_error, attempts, resolution, created_at, resolved_at, memory_ids)
      VALUES (?, ?, ?, ?, ?, NULL, ?, NULL, '[]')
    `).run(id, project, sessionId, triggerError, JSON.stringify(attempts), timestamp);

    return {
      id, project, session_id: sessionId, trigger_error: triggerError,
      attempts, resolution: null, created_at: timestamp, resolved_at: null, memory_ids: [],
    };
  }

  /** Get the active (unresolved) chain for a project + session. Returns null if none. */
  getActiveChain(project: string, sessionId: string): InvestigationChain | null {
    const row = this.db.prepare(`
      SELECT * FROM investigation_chains
      WHERE project = ? AND session_id = ? AND resolved_at IS NULL
      ORDER BY created_at DESC LIMIT 1
    `).get(project, sessionId) as ChainRow | undefined;

    return row ? this.rowToChain(row) : null;
  }

  /** Get recently resolved chains for briefing injection (cross-session). */
  getRecentResolved(project: string, limit: number): InvestigationChain[] {
    const rows = this.db.prepare(`
      SELECT * FROM investigation_chains
      WHERE project = ? AND resolved_at IS NOT NULL
      ORDER BY resolved_at DESC LIMIT ?
    `).all(project, limit) as ChainRow[];

    return rows.map(r => this.rowToChain(r));
  }

  /** Append an attempt to an existing chain. Capped at LIMITS.MAX_ATTEMPTS_PER_CHAIN. */
  appendAttempt(chainId: string, attempt: ChainAttempt): boolean {
    const row = this.db.prepare('SELECT attempts FROM investigation_chains WHERE id = ?')
      .get(chainId) as { attempts: string } | undefined;
    if (!row) return false;

    const attempts = JSON.parse(row.attempts) as ChainAttempt[];
    if (attempts.length >= LIMITS.MAX_ATTEMPTS_PER_CHAIN) return false;

    attempts.push(attempt);
    this.db.prepare('UPDATE investigation_chains SET attempts = ? WHERE id = ?')
      .run(JSON.stringify(attempts), chainId);
    return true;
  }

  /** Resolve a chain — records what finally worked. */
  resolve(chainId: string, resolution: string): void {
    this.db.prepare(`
      UPDATE investigation_chains SET resolution = ?, resolved_at = ? WHERE id = ?
    `).run(resolution, now(), chainId);
  }

  /** Link related memory IDs to a chain (pitfalls/decisions created during investigation). */
  addMemoryId(chainId: string, memoryId: string): void {
    const row = this.db.prepare('SELECT memory_ids FROM investigation_chains WHERE id = ?')
      .get(chainId) as { memory_ids: string } | undefined;
    if (!row) return;

    const ids = JSON.parse(row.memory_ids) as string[];
    if (!ids.includes(memoryId)) {
      ids.push(memoryId);
      this.db.prepare('UPDATE investigation_chains SET memory_ids = ? WHERE id = ?')
        .run(JSON.stringify(ids), chainId);
    }
  }

  /** Cleanup old chains — remove resolved chains older than the given hours. */
  cleanup(retentionHours: number): number {
    const result = this.db.prepare(`
      DELETE FROM investigation_chains
      WHERE resolved_at IS NOT NULL
        AND resolved_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' hours')
    `).run(retentionHours);
    return result.changes;
  }
}
