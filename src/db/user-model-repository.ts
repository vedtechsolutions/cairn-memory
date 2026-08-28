/**
 * Structured user model repository — queryable dimensions (role, expertise, preference, etc.)
 * Replaces free-text user_profile with structured, evidence-counted entries.
 */
import type Database from 'better-sqlite3';
import { generateId, now } from '../utils/index.js';

export type UserDimension = 'role' | 'expertise' | 'preference' | 'team' | 'style';

export interface UserModelEntry {
  id: string;
  dimension: UserDimension;
  key: string;
  value: string;
  confidence: number;
  evidence_count: number;
  created_at: string;
  updated_at: string;
}

interface UserModelRow {
  id: string;
  dimension: string;
  key: string;
  value: string;
  confidence: number;
  evidence_count: number;
  created_at: string;
  updated_at: string;
}

export interface StructuredProfile {
  role: UserModelEntry[];
  expertise: UserModelEntry[];
  preference: UserModelEntry[];
  team: UserModelEntry[];
  style: UserModelEntry[];
}

const CONFIDENCE_BOOST_PER_EVIDENCE = 0.05;
const MAX_CONFIDENCE = 0.95;
const DECAY_FACTOR = 0.9;
const DECAY_MIN_AGE_DAYS = 30;

export class UserModelRepository {
  constructor(private db: Database.Database) {}

  private rowToEntry(row: UserModelRow): UserModelEntry {
    return { ...row, dimension: row.dimension as UserDimension };
  }

  /** Insert or update a user model entry. On repeat observation: boost confidence + increment evidence. */
  upsert(dimension: UserDimension, key: string, value: string, confidence?: number): UserModelEntry {
    const timestamp = now();
    const existing = this.db.prepare(
      'SELECT * FROM user_model WHERE dimension = ? AND key = ?'
    ).get(dimension, key) as UserModelRow | undefined;

    if (existing) {
      const newConfidence = Math.min(MAX_CONFIDENCE, existing.confidence + CONFIDENCE_BOOST_PER_EVIDENCE);
      const newEvidence = existing.evidence_count + 1;
      this.db.prepare(`
        UPDATE user_model SET value = ?, confidence = ?, evidence_count = ?, updated_at = ?
        WHERE dimension = ? AND key = ?
      `).run(value, newConfidence, newEvidence, timestamp, dimension, key);
      return this.rowToEntry({ ...existing, value, confidence: newConfidence, evidence_count: newEvidence, updated_at: timestamp });
    }

    const id = generateId();
    const conf = confidence ?? 0.5;
    this.db.prepare(`
      INSERT INTO user_model (id, dimension, key, value, confidence, evidence_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `).run(id, dimension, key, value, conf, timestamp, timestamp);

    return { id, dimension, key, value, confidence: conf, evidence_count: 1, created_at: timestamp, updated_at: timestamp };
  }

  /** Get all entries for a dimension. */
  getByDimension(dimension: UserDimension): UserModelEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM user_model WHERE dimension = ? ORDER BY confidence DESC'
    ).all(dimension) as UserModelRow[];
    return rows.map(r => this.rowToEntry(r));
  }

  /** Get the full structured profile — all dimensions. */
  getProfile(): StructuredProfile {
    const rows = this.db.prepare(
      'SELECT * FROM user_model ORDER BY dimension, confidence DESC'
    ).all() as UserModelRow[];

    const profile: StructuredProfile = { role: [], expertise: [], preference: [], team: [], style: [] };
    for (const row of rows) {
      const dim = row.dimension as UserDimension;
      if (dim in profile) {
        profile[dim].push(this.rowToEntry(row));
      }
    }
    return profile;
  }

  /** Check if the model has any entries. */
  hasEntries(): boolean {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM user_model').get() as { cnt: number };
    return row.cnt > 0;
  }

  /** Render a compact one-line summary for briefing injection.
   *  Format: "senior developer, TypeScript expert, prefers quality over speed" */
  renderCompact(): string | null {
    const profile = this.getProfile();
    const parts: string[] = [];

    // Role first
    for (const r of profile.role.slice(0, 2)) {
      parts.push(r.value !== 'true' ? `${r.value} ${r.key}` : r.key);
    }
    // Expertise
    for (const e of profile.expertise.slice(0, 3)) {
      parts.push(e.value !== 'true' ? `${e.key} (${e.value})` : e.key);
    }
    // Preferences
    for (const p of profile.preference.slice(0, 2)) {
      parts.push(p.value !== 'true' ? `${p.key}: ${p.value}` : p.key);
    }
    // Style
    for (const s of profile.style.slice(0, 1)) {
      parts.push(s.value !== 'true' ? `${s.key}: ${s.value}` : s.key);
    }

    return parts.length > 0 ? parts.join(', ') : null;
  }

  /** Decay confidence on entries not updated in DECAY_MIN_AGE_DAYS. */
  decay(): number {
    const result = this.db.prepare(`
      UPDATE user_model
      SET confidence = MAX(0.1, confidence * ?),
          updated_at = datetime('now')
      WHERE julianday('now') - julianday(updated_at) > ?
    `).run(DECAY_FACTOR, DECAY_MIN_AGE_DAYS);
    return result.changes;
  }
}
