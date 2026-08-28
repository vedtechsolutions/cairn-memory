/**
 * Project context cache — stores structural snapshots keyed by project + git hash.
 * Avoids re-scanning the filesystem when the project hasn't changed.
 */
import type Database from 'better-sqlite3';
import type { ProjectContext } from '../utils/project-scanner.js';
import { PROJECT_SCAN } from '../constants/index.js';

export class ContextRepository {
  constructor(private db: Database.Database) {}

  /** Get cached context for a project + git hash. Returns null on cache miss. */
  get(project: string, gitHash: string): ProjectContext | null {
    const row = this.db.prepare(
      'SELECT context FROM project_context WHERE project = ? AND git_hash = ?'
    ).get(project, gitHash) as { context: string } | undefined;

    if (!row) return null;
    try {
      return JSON.parse(row.context) as ProjectContext;
    } catch {
      return null;
    }
  }

  /** Store a project context snapshot. Upserts by project + git_hash. */
  store(project: string, context: ProjectContext): void {
    this.db.prepare(`
      INSERT INTO project_context (project, git_hash, context, scanned_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (project, git_hash) DO UPDATE SET context = excluded.context, scanned_at = excluded.scanned_at
    `).run(project, context.gitHash, JSON.stringify(context), context.scannedAt);
  }

  /** Get the most recent context for a project (any git hash). */
  getLatest(project: string): ProjectContext | null {
    const row = this.db.prepare(
      'SELECT context FROM project_context WHERE project = ? ORDER BY scanned_at DESC LIMIT 1'
    ).get(project) as { context: string } | undefined;

    if (!row) return null;
    try {
      return JSON.parse(row.context) as ProjectContext;
    } catch {
      return null;
    }
  }

  /** Clean up old entries, keeping the most recent N per project. */
  cleanup(project: string): number {
    const keep = PROJECT_SCAN.MAX_CACHE_PER_PROJECT;
    const result = this.db.prepare(`
      DELETE FROM project_context
      WHERE project = ? AND rowid NOT IN (
        SELECT rowid FROM project_context WHERE project = ? ORDER BY scanned_at DESC LIMIT ?
      )
    `).run(project, project, keep);
    return result.changes;
  }
}
