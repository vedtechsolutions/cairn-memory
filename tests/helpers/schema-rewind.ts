/**
 * Test helper: strip the schema-v27 surface from a freshly created store so
 * migration tests can rewind to older shapes (v24/v25/v26) and exercise the
 * real upgrade path. Restores the pre-v27 BROAD memories_au trigger, which
 * every pre-v27 shape had. Drop order matters: triggers and the partial
 * index reference the revision column.
 */
import type Database from 'better-sqlite3';

export function stripV27Surface(db: Database.Database): void {
  db.exec('DROP TRIGGER memories_revision_au');
  db.exec('DROP TRIGGER memory_files_revision_au');
  db.exec('DROP TABLE memory_files');
  db.exec('DROP INDEX idx_memories_project_kind_active');
  db.exec('ALTER TABLE memories DROP COLUMN revision');
  db.exec('DROP TRIGGER memories_au');
  db.exec(`CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
  END`);
}
