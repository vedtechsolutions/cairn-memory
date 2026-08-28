import Database from 'better-sqlite3';
import { mkdirSync, existsSync, copyFileSync, unlinkSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { FS_PERMS } from '../constants/index.js';
import { resolveDbPath } from './db-path.js';
import { ALL_DDL, SCHEMA_VERSION } from './schema.js';
import {
  CREATE_REMINDERS_TABLE, CREATE_REMINDERS_FTS, CREATE_REMINDERS_FTS_TRIGGERS,
  CREATE_HOOK_TELEMETRY_TABLE,
  CREATE_PROJECT_CONTEXT_TABLE,
  CREATE_CONTEXT_VECTOR_TABLE,
  CREATE_MEMORIES_FTS,
  CREATE_FTS_TRIGGERS,
  CREATE_INDEXES,
  CREATE_MEMORY_EDGES_TABLE,
  CREATE_EDGE_INDEXES,
  CREATE_MEMORY_CORECALL_TABLE,
  CREATE_SESSION_MEMORIES_TABLE,
  CREATE_CORECALL_INDEXES,
  CREATE_MEMORY_VERSIONS_TABLE,
  CREATE_MEMORY_VERSIONS_INDEX,
  CREATE_INVESTIGATION_CHAINS_TABLE,
  CREATE_INVESTIGATION_CHAINS_INDEXES,
  CREATE_USER_MODEL_TABLE,
  CREATE_MAINTENANCE_META_TABLE,
  CREATE_MEMORY_REVISION_TRIGGER,
  CREATE_MEMORY_FILES_TABLE,
  CREATE_MEMORY_FILES_REVISION_TRIGGER,
  CREATE_EXACT_SCOPE_INDEX,
} from './schema.js';
import { DB } from '../constants/index.js';
import { migrateToV28 } from './migrations/v28-governance.js';
import { migrateToV29 } from './migrations/v29-origin-client.js';

const LAST_LEGACY_SCHEMA_VERSION = 27;

export interface ConnectionOptions {
  /** Path to the SQLite database file. Use ':memory:' for in-memory. */
  dbPath?: string;
  /** Enable verbose logging to stderr */
  verbose?: boolean;
}

/**
 * Open (or create) the Cairn SQLite database with proper configuration.
 * - WAL mode for concurrent reads
 * - Foreign keys enabled
 * - Busy timeout for lock contention
 * - Auto-creates schema on first run
 * - Integrity check with auto-recovery on corruption
 */
export function openDatabase(options: ConnectionOptions = {}): Database.Database {
  const dbPath = resolveDbPath(options.dbPath);
  const isMemory = dbPath === ':memory:';

  if (!isMemory) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      // Owner-only: the DB and its WAL/SHM sidecars can hold command history
      // and distilled memory, and must not be world-readable on shared hosts.
      mkdirSync(dir, { recursive: true, mode: FS_PERMS.DIR });
    }
  }

  // If file exists, run integrity check before opening
  if (!isMemory && existsSync(dbPath)) {
    const integrityOk = checkIntegrity(dbPath, options.verbose);
    if (!integrityOk) {
      recoverCorruptDb(dbPath, options.verbose);
    }
  }

  const db = new Database(dbPath, {
    verbose: options.verbose ? (msg: unknown) => console.error('[cairn-db]', msg) : undefined,
  });

  // Restrict the DB file to its owner. Older installs left it world-readable
  // (0644), exposing distilled memory and any opt-in raw command history to
  // co-tenants. Best-effort: never fail startup if the FS rejects chmod.
  if (!isMemory) {
    try { chmodSync(dbPath, FS_PERMS.FILE); } catch { /* best-effort on exotic FS */ }
  }

  try {
    configureConnection(db);
    ensureSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Whether sqlite-vec extension was loaded successfully */
let sqliteVecLoaded = false;

export function isSqliteVecAvailable(): boolean {
  return sqliteVecLoaded;
}

function configureConnection(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma(`busy_timeout = ${DB.BUSY_TIMEOUT_MS}`);
  db.pragma('synchronous = NORMAL');

  // Load sqlite-vec extension for vector similarity functions
  try {
    const require = createRequire(import.meta.url);
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);
    sqliteVecLoaded = true;
  } catch {
    // Extension not available — vector search will use JS fallback
  }
}

function ensureSchema(db: Database.Database): void {
  const versionRow = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
  ).get() as { name: string } | undefined;

  if (!versionRow) {
    // Fresh database — create all tables
    db.transaction(() => {
      for (const ddl of ALL_DDL) {
        db.exec(ddl);
      }
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    })();
    return;
  }

  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
  const currentVersion = row?.version ?? 0;

  const legacyTarget = Math.min(SCHEMA_VERSION, LAST_LEGACY_SCHEMA_VERSION);
  if (currentVersion < legacyTarget) {
    migrate(db, currentVersion, legacyTarget);
  }
  if (currentVersion < 28 && SCHEMA_VERSION >= 28) {
    migrateToV28(db);
  }
  if (currentVersion < 29 && SCHEMA_VERSION >= 29) {
    migrateToV29(db);
  }

  ensureFtsIntegrity(db);
}

/** Detect and repair FTS drift. A process killed mid-migration (the v9/v22
 *  drop-and-rebuild pattern) can leave memories_fts empty or partial, which
 *  silently kills keyword recall until manually repaired. memories_fts is an
 *  external-content FTS5 table, so the 'rebuild' command regenerates the whole
 *  index from the memories table. Row counts must match exactly: the sync
 *  triggers mirror every memories row (including invalidated) into the index.
 *
 *  The indexed-row count MUST come from the memories_fts_docsize shadow table:
 *  a full scan of an external-content FTS5 table (COUNT(*) FROM memories_fts)
 *  reads through to the content table, so it always equals the memories count
 *  and can never detect drift. docsize holds one row per indexed document
 *  (present because the table doesn't set columnsize=0).
 *
 *  Scope: this detects cardinality drift only (empty or partially rebuilt
 *  index — the mid-migration-kill failure mode). Same-row-count corruption
 *  with stale terms would need FTS5's O(index) 'integrity-check' command,
 *  deliberately not run on the per-hook startup path. */
function ensureFtsIntegrity(db: Database.Database): void {
  try {
    const memCount = (db.prepare('SELECT COUNT(*) AS n FROM memories').get() as { n: number }).n;
    const ftsCount = (db.prepare('SELECT COUNT(*) AS n FROM memories_fts_docsize').get() as { n: number }).n;
    if (memCount !== ftsCount) {
      db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
    }
  } catch {
    // Count query failed — index structurally corrupt. Attempt a rebuild;
    // if that also fails, leave recall degraded rather than crash startup.
    try {
      db.exec("INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')");
    } catch { /* best-effort */ }
  }
}

function migrate(db: Database.Database, from: number, to: number): void {
  db.transaction(() => {
    if (from < 2 && to >= 2) {
      // v2: Add reminders table with FTS5
      db.exec(CREATE_REMINDERS_TABLE);
      db.exec(CREATE_REMINDERS_FTS);
      for (const trigger of CREATE_REMINDERS_FTS_TRIGGERS) {
        db.exec(trigger);
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_reminders_active ON reminders(active, project)');
    }
    if (from < 3 && to >= 3) {
      // v3: Add read file tracking + initial goal to compaction snapshots
      db.exec('ALTER TABLE compaction_snapshots ADD COLUMN recent_read_files TEXT');
      db.exec('ALTER TABLE compaction_snapshots ADD COLUMN initial_goal TEXT');
    }
    if (from < 4 && to >= 4) {
      // v4: Phase 8 — TTL, cross-session, telemetry, decision snapshots
      db.exec('ALTER TABLE memories ADD COLUMN expires_at TEXT DEFAULT NULL');
      db.exec('ALTER TABLE sessions ADD COLUMN plan_id TEXT');
      db.exec('ALTER TABLE sessions ADD COLUMN steps_completed TEXT');
      db.exec('ALTER TABLE compaction_snapshots ADD COLUMN recent_decisions TEXT');
      db.exec(CREATE_HOOK_TELEMETRY_TABLE);
      db.exec('CREATE INDEX IF NOT EXISTS idx_memories_last_recalled ON memories(last_recalled)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_telemetry_hook ON hook_telemetry(hook_name, created_at DESC)');
    }
    if (from < 5 && to >= 5) {
      // v5: Memory impact tracking — surface/impact counters for pitfall effectiveness
      db.exec('ALTER TABLE memories ADD COLUMN surface_count INTEGER DEFAULT 0');
      db.exec('ALTER TABLE memories ADD COLUMN impact_count INTEGER DEFAULT 0');
    }
    if (from < 6 && to >= 6) {
      // v6: Project context cache — structural snapshots keyed by project + git hash
      db.exec(CREATE_PROJECT_CONTEXT_TABLE);
    }
    if (from < 7 && to >= 7) {
      // v7: Context fingerprints for multi-dimensional retrieval
      db.exec('ALTER TABLE memories ADD COLUMN fingerprint TEXT DEFAULT NULL');
    }
    if (from < 8 && to >= 8) {
      // v8: Session quality signal for cross-session momentum
      db.exec('ALTER TABLE sessions ADD COLUMN session_quality TEXT DEFAULT NULL');
    }
    if (from < 9 && to >= 9) {
      // v9: Structured context (why/how_to_apply), new kinds (user_profile, reference), confirmed source
      // SQLite cannot ALTER CHECK constraints, so we must recreate the table.

      // Step 1: Create new table with updated constraints + context column
      db.exec(`CREATE TABLE memories_new (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('pitfall','decision','correction','fact','task_state','user_profile','reference')),
        project TEXT,
        tags TEXT,
        confidence REAL DEFAULT 0.5,
        source TEXT DEFAULT 'learned' CHECK (source IN ('user','learned','corrected','confirmed')),
        created_at TEXT NOT NULL,
        last_recalled TEXT,
        recall_count INTEGER DEFAULT 0,
        invalidated INTEGER DEFAULT 0,
        expires_at TEXT DEFAULT NULL,
        surface_count INTEGER DEFAULT 0,
        impact_count INTEGER DEFAULT 0,
        fingerprint TEXT DEFAULT NULL,
        context TEXT DEFAULT NULL
      )`);

      // Step 2: Copy existing data (context defaults to NULL)
      db.exec(`INSERT INTO memories_new
        SELECT id, content, kind, project, tags, confidence, source, created_at,
               last_recalled, recall_count, invalidated, expires_at,
               surface_count, impact_count, fingerprint, NULL
        FROM memories`);

      // Step 3: Drop FTS triggers, FTS table, old table
      db.exec('DROP TRIGGER IF EXISTS memories_ai');
      db.exec('DROP TRIGGER IF EXISTS memories_ad');
      db.exec('DROP TRIGGER IF EXISTS memories_au');
      db.exec('DROP TABLE IF EXISTS memories_fts');
      db.exec('DROP TABLE memories');

      // Step 4: Rename
      db.exec('ALTER TABLE memories_new RENAME TO memories');

      // Step 5: Recreate FTS and triggers
      db.exec(CREATE_MEMORIES_FTS);
      for (const trigger of CREATE_FTS_TRIGGERS) {
        db.exec(trigger);
      }

      // Step 6: Rebuild FTS index from existing data
      db.exec('INSERT INTO memories_fts(rowid, content, tags) SELECT rowid, content, tags FROM memories');

      // Step 7: Recreate indexes
      for (const idx of CREATE_INDEXES) {
        if (idx.includes('idx_memories_')) {
          db.exec(idx);
        }
      }
    }
    if (from < 10 && to >= 10) {
      // v10: Embedding column + memory graph edges
      db.exec('ALTER TABLE memories ADD COLUMN embedding BLOB DEFAULT NULL');
      db.exec(CREATE_MEMORY_EDGES_TABLE);
      for (const idx of CREATE_EDGE_INDEXES) {
        db.exec(idx);
      }
    }
    if (from < 11 && to >= 11) {
      // v11: Code-location anchors + co-recall tracking + session-memory junction
      db.exec('ALTER TABLE memories ADD COLUMN anchor TEXT DEFAULT NULL');
      db.exec(CREATE_MEMORY_CORECALL_TABLE);
      db.exec(CREATE_SESSION_MEMORIES_TABLE);
      for (const idx of CREATE_CORECALL_INDEXES) {
        db.exec(idx);
      }
    }
    if (from < 12 && to >= 12) {
      // v12: Rich reminders + agent_id on telemetry
      db.exec("ALTER TABLE reminders ADD COLUMN trigger_type TEXT DEFAULT 'prompt'");
      db.exec('ALTER TABLE reminders ADD COLUMN trigger_config TEXT DEFAULT NULL');
      db.exec('ALTER TABLE hook_telemetry ADD COLUMN agent_id TEXT DEFAULT NULL');
    }
    if (from < 13 && to >= 13) {
      // v13: Rolling context vector cache for hook-MCP embedding bridge
      db.exec(CREATE_CONTEXT_VECTOR_TABLE);
    }
    if (from < 14 && to >= 14) {
      // v14: Memory version history — preserves old content on correct/update
      db.exec(CREATE_MEMORY_VERSIONS_TABLE);
      db.exec(CREATE_MEMORY_VERSIONS_INDEX);
    }
    if (from < 15 && to >= 15) {
      // v15: Investigation chains — debugging sequence tracking
      db.exec(CREATE_INVESTIGATION_CHAINS_TABLE);
      for (const idx of CREATE_INVESTIGATION_CHAINS_INDEXES) {
        db.exec(idx);
      }
    }
    if (from < 16 && to >= 16) {
      // v16: Structured user model — queryable dimensions
      db.exec(CREATE_USER_MODEL_TABLE);
    }
    if (from < 17 && to >= 17) {
      // v17: Reasoning state snapshots — hypotheses, open questions, error context
      db.exec('ALTER TABLE compaction_snapshots ADD COLUMN reasoning_state TEXT');
      db.exec('ALTER TABLE compaction_snapshots ADD COLUMN error_context TEXT');
    }
    if (from < 18 && to >= 18) {
      // v18: Clear inverted supersedes edges from session-end consolidation bug
      // (source/target were swapped — source should be OLD, target should be NEW)
      db.prepare("DELETE FROM memory_edges WHERE relation = 'supersedes'").run();
    }
    if (from < 19 && to >= 19) {
      // v19: Goal staleness tracking — branch + carry count for stale goal detection
      db.exec('ALTER TABLE compaction_snapshots ADD COLUMN goal_branch TEXT');
      db.exec('ALTER TABLE compaction_snapshots ADD COLUMN goal_carry_count INTEGER DEFAULT 0');
    }
    if (from < 20 && to >= 20) {
      // v20: Project goal continuity — sticky ambient goal distinct from turn goal.
      // project_goal persists across meta turns so the briefing can surface "what
      // this branch is FOR" even when the latest user message is a side-quest.
      // project_goal_source is one of: 'transcript' | 'plan' | 'branch' | 'user'.
      db.exec('ALTER TABLE compaction_snapshots ADD COLUMN project_goal TEXT');
      db.exec('ALTER TABLE compaction_snapshots ADD COLUMN project_goal_source TEXT');
      db.exec('ALTER TABLE sessions ADD COLUMN project_goal TEXT');
    }
    if (from < 21 && to >= 21) {
      // v21: Resume cursor persistence — last edit (file, line, tool, at)
      // stored in the snapshot as JSON so it survives SessionEnd's
      // deleteTracker call. Without this the cursor is wiped on clean /exit
      // and the next startup briefing can't show "Resume: foo.ts:240".
      db.exec('ALTER TABLE compaction_snapshots ADD COLUMN last_edit_cursor TEXT');
    }
    if (from < 22 && to >= 22) {
      // v22: North-Star Phases 3 + 4 — add 'pattern' and 'goal' memory kinds.
      // SQLite cannot ALTER CHECK constraints, so we recreate the memories
      // table with the extended enum. Bundled into a single migration so
      // the table rebuild only happens once. Same recipe as v9.

      db.exec(`CREATE TABLE memories_new (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('pitfall','decision','correction','fact','task_state','user_profile','reference','pattern','goal')),
        project TEXT,
        tags TEXT,
        confidence REAL DEFAULT 0.5,
        source TEXT DEFAULT 'learned' CHECK (source IN ('user','learned','corrected','confirmed')),
        created_at TEXT NOT NULL,
        last_recalled TEXT,
        recall_count INTEGER DEFAULT 0,
        invalidated INTEGER DEFAULT 0,
        expires_at TEXT DEFAULT NULL,
        surface_count INTEGER DEFAULT 0,
        impact_count INTEGER DEFAULT 0,
        fingerprint TEXT DEFAULT NULL,
        context TEXT DEFAULT NULL,
        embedding BLOB DEFAULT NULL,
        anchor TEXT DEFAULT NULL
      )`);

      db.exec(`INSERT INTO memories_new
        SELECT id, content, kind, project, tags, confidence, source, created_at,
               last_recalled, recall_count, invalidated, expires_at,
               surface_count, impact_count, fingerprint, context, embedding, anchor
        FROM memories`);

      db.exec('DROP TRIGGER IF EXISTS memories_ai');
      db.exec('DROP TRIGGER IF EXISTS memories_ad');
      db.exec('DROP TRIGGER IF EXISTS memories_au');
      db.exec('DROP TABLE IF EXISTS memories_fts');
      db.exec('DROP TABLE memories');
      db.exec('ALTER TABLE memories_new RENAME TO memories');

      db.exec(CREATE_MEMORIES_FTS);
      for (const trigger of CREATE_FTS_TRIGGERS) {
        db.exec(trigger);
      }
      db.exec('INSERT INTO memories_fts(rowid, content, tags) SELECT rowid, content, tags FROM memories');

      for (const idx of CREATE_INDEXES) {
        if (idx.includes('idx_memories_')) {
          db.exec(idx);
        }
      }
    }
    if (from < 23 && to >= 23) {
      // v23: Three-tier goal rendering (Now/Feature/Project) — add captured_at
      // metadata columns so each tier can apply its own staleness policy.
      // goal_captured_at: when initial_goal (Now tier) was mined.
      // project_goal_captured_at: when project_goal (Feature/Project tier) was
      // first recorded; carries forward across snapshots and only refreshes on
      // an explicit pivot (plan rename or user correction).
      db.exec('ALTER TABLE compaction_snapshots ADD COLUMN goal_captured_at TEXT');
      db.exec('ALTER TABLE compaction_snapshots ADD COLUMN project_goal_captured_at TEXT');
    }
    if (from < 24 && to >= 24) {
      // v24: Truth maintenance — supersession bookkeeping. A memory with
      // superseded_by set has been retired by a newer conflicting claim; it is
      // excluded from active recall/briefings but kept queryable (bitemporal,
      // non-destructive). superseded_at records when.
      db.exec('ALTER TABLE memories ADD COLUMN superseded_by TEXT DEFAULT NULL');
      db.exec('ALTER TABLE memories ADD COLUMN superseded_at TEXT DEFAULT NULL');
      db.exec('CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by)');
    }
    if (from < 25 && to >= 25) {
      // v25: Incremental decay bookkeeping. last_decayed_at marks the point up
      // to which decay has been charged, making decay a function of wall-clock
      // time instead of invocation count (the pre-v25 model recomputed
      // retention from total age on every fresh session start and multiplied
      // it into an already-decayed confidence — compounding). Backfilled to
      // "now" so the first post-migration run charges nothing: this store has
      // already been over-decayed by the old model. ISO UTC format to match
      // the now() convention used everywhere else.
      db.exec('ALTER TABLE memories ADD COLUMN last_decayed_at TEXT DEFAULT NULL');
      db.exec("UPDATE memories SET last_decayed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
      db.exec(CREATE_MAINTENANCE_META_TABLE);
    }
    if (from < 26 && to >= 26) {
      // v26: per-row embedding-model tagging (roadmap W2). Every vector read
      // filters on the active model and every vector write stamps it —
      // mixing dims in vec_distance_cosine is a per-row runtime error, so
      // this is correctness, not hygiene. Backfill hardcodes 'minilm-l6'
      // (NOT the default-model constant): every pre-v26 vector was produced
      // by all-MiniLM-L6-v2, and the migration must record what the vectors
      // actually ARE even if the default changes later.
      db.exec('ALTER TABLE memories ADD COLUMN embedding_model TEXT DEFAULT NULL');
      db.exec('ALTER TABLE context_vectors ADD COLUMN embedding_model TEXT DEFAULT NULL');
      db.exec("UPDATE memories SET embedding_model = 'minilm-l6' WHERE embedding IS NOT NULL");
      db.exec("UPDATE context_vectors SET embedding_model = 'minilm-l6' WHERE embedding IS NOT NULL");
    }
    if (from < 27 && to >= 27) {
      // v27 (roadmap W4 preparatory): structural revision counter for
      // memory-tool CAS + free-form memory_files. The revision trigger fires
      // on SET-clause mention of rendered-semantic columns only; embeddings
      // and telemetry are excluded. memories_au is DROPPED and recreated
      // narrowed to AFTER UPDATE OF content, tags — the old broad trigger
      // rebuilt FTS on every column write and would be re-fired by the
      // revision trigger's internal update (recursive_triggers=OFF does not
      // stop cross-trigger firing). ALTER ADD COLUMN backfills existing rows
      // to revision 1 via the default.
      db.exec('ALTER TABLE memories ADD COLUMN revision INTEGER NOT NULL DEFAULT 1');
      db.exec('DROP TRIGGER IF EXISTS memories_au');
      for (const ddl of CREATE_FTS_TRIGGERS) db.exec(ddl);
      db.exec(CREATE_MEMORY_REVISION_TRIGGER);
      db.exec(CREATE_MEMORY_FILES_TABLE);
      db.exec(CREATE_MEMORY_FILES_REVISION_TRIGGER);
      db.exec(CREATE_EXACT_SCOPE_INDEX);
    }
    db.prepare('UPDATE schema_version SET version = ?').run(to);
  })();
}

function checkIntegrity(dbPath: string, verbose?: boolean): boolean {
  try {
    const testDb = new Database(dbPath, { readonly: true });
    const result = testDb.pragma('integrity_check') as Array<{ integrity_check: string }>;
    testDb.close();
    const ok = result.length === 1 && result[0].integrity_check === 'ok';
    if (!ok && verbose) {
      console.error('[cairn-db] Integrity check failed:', result);
    }
    return ok;
  } catch {
    return false;
  }
}

function recoverCorruptDb(dbPath: string, verbose?: boolean): void {
  const backupPath = `${dbPath}.corrupt.${Date.now()}`;
  if (verbose) {
    console.error(`[cairn-db] Database corrupt. Backing up to ${backupPath} and creating fresh DB.`);
  }
  try {
    copyFileSync(dbPath, backupPath);
    unlinkSync(dbPath);
    // Also remove WAL/SHM files if they exist
    for (const suffix of ['-wal', '-shm']) {
      const sidecar = dbPath + suffix;
      if (existsSync(sidecar)) unlinkSync(sidecar);
    }
  } catch (err) {
    console.error('[cairn-db] Recovery failed:', err);
  }
}
