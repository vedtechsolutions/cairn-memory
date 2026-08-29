// ============================================================================
// Waykeep Database Schema — All table definitions as SQL constants
// ============================================================================

import { GOVERNANCE_DDL } from './governance-schema.js';

export const SCHEMA_VERSION = 32;

export const CREATE_MEMORIES_TABLE = `
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pitfall','decision','correction','fact','task_state','user_profile','reference','pattern','goal','rule')),
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
  embedding_model TEXT DEFAULT NULL,
  anchor TEXT DEFAULT NULL,
  superseded_by TEXT DEFAULT NULL,
  superseded_at TEXT DEFAULT NULL,
  last_decayed_at TEXT DEFAULT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  origin_client TEXT NOT NULL DEFAULT 'claude',
  author TEXT DEFAULT NULL,
  updated_at TEXT DEFAULT NULL,
  share_state TEXT DEFAULT NULL CHECK (share_state IN ('local','team') OR share_state IS NULL)
)`;

/** Maintenance bookkeeping (rate-gate timestamps etc.) — key/value rows. */
export const CREATE_MAINTENANCE_META_TABLE = `
CREATE TABLE IF NOT EXISTS maintenance_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
)`;

export const CREATE_MEMORY_CORECALL_TABLE = `
CREATE TABLE IF NOT EXISTS memory_corecall (
  memory_a TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  memory_b TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  co_count INTEGER DEFAULT 1,
  last_co_recall TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (memory_a, memory_b)
)`;

export const CREATE_SESSION_MEMORIES_TABLE = `
CREATE TABLE IF NOT EXISTS session_memories (
  session_id TEXT NOT NULL,
  memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  recalled_at TEXT NOT NULL DEFAULT (datetime('now')),
  led_to_success INTEGER DEFAULT 0,
  PRIMARY KEY (session_id, memory_id)
)`;

export const CREATE_CORECALL_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_corecall_a ON memory_corecall(memory_a)',
  'CREATE INDEX IF NOT EXISTS idx_session_memories_session ON session_memories(session_id)',
];

export const CREATE_MEMORY_EDGES_TABLE = `
CREATE TABLE IF NOT EXISTS memory_edges (
  source_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation TEXT NOT NULL CHECK (relation IN (
    'supersedes','refines','contradicts','caused_by',
    'informs','co_occurred','generalizes'
  )),
  weight REAL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (source_id, target_id, relation)
)`;

export const CREATE_EDGE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_edges_source ON memory_edges(source_id)',
  'CREATE INDEX IF NOT EXISTS idx_edges_target ON memory_edges(target_id)',
  'CREATE INDEX IF NOT EXISTS idx_edges_relation ON memory_edges(relation)',
];

export const CREATE_MEMORIES_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  content,
  tags,
  content=memories,
  content_rowid=rowid
)`;

/** Triggers to keep FTS5 in sync with memories table */
export const CREATE_FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
  END`,

  `CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
  END`,

  // v27: narrowed to the columns FTS actually indexes — the previous broad
  // AFTER UPDATE rebuilt FTS on EVERY column write and would be re-fired by
  // the revision trigger's internal update (recursive_triggers=OFF does NOT
  // stop cross-trigger firing). UPDATE OF gates on SET-clause mention.
  `CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, tags ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES('delete', old.rowid, old.content, old.tags);
    INSERT INTO memories_fts(rowid, content, tags) VALUES (new.rowid, new.content, new.tags);
  END`,
];

export const CREATE_SESSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  task_summary TEXT,
  plan_id TEXT,
  steps_completed TEXT,
  session_quality TEXT,
  project_goal TEXT
)`;

export const CREATE_PLANS_TABLE = `
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('active','completed','abandoned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

export const CREATE_PLAN_STEPS_TABLE = `
CREATE TABLE IF NOT EXISTS plan_steps (
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  step_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('done','in_progress','pending','blocked')),
  depends_on TEXT,
  outcome TEXT,
  blockers TEXT,
  notes TEXT,
  PRIMARY KEY (plan_id, step_id)
)`;

export const CREATE_PLAN_DECISIONS_TABLE = `
CREATE TABLE IF NOT EXISTS plan_decisions (
  id TEXT PRIMARY KEY,
  plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  step_id INTEGER,
  chose TEXT NOT NULL,
  why TEXT NOT NULL,
  alternatives TEXT,
  permanent INTEGER DEFAULT 0,
  decided_at TEXT NOT NULL
)`;

export const CREATE_REMINDERS_TABLE = `
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  trigger_pattern TEXT NOT NULL,
  action TEXT NOT NULL,
  project TEXT,
  fire_count INTEGER DEFAULT 0,
  max_fires INTEGER DEFAULT 0,
  active INTEGER DEFAULT 1,
  created_at TEXT NOT NULL,
  trigger_type TEXT DEFAULT 'prompt' CHECK (trigger_type IN ('prompt','file','time','conditional')),
  trigger_config TEXT DEFAULT NULL
)`;

export const CREATE_REMINDERS_FTS = `
CREATE VIRTUAL TABLE IF NOT EXISTS reminders_fts USING fts5(
  trigger_pattern,
  content=reminders,
  content_rowid=rowid
)`;

export const CREATE_REMINDERS_FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS reminders_ai AFTER INSERT ON reminders BEGIN
    INSERT INTO reminders_fts(rowid, trigger_pattern) VALUES (new.rowid, new.trigger_pattern);
  END`,
  `CREATE TRIGGER IF NOT EXISTS reminders_ad AFTER DELETE ON reminders BEGIN
    INSERT INTO reminders_fts(reminders_fts, rowid, trigger_pattern) VALUES('delete', old.rowid, old.trigger_pattern);
  END`,
  `CREATE TRIGGER IF NOT EXISTS reminders_au AFTER UPDATE ON reminders BEGIN
    INSERT INTO reminders_fts(reminders_fts, rowid, trigger_pattern) VALUES('delete', old.rowid, old.trigger_pattern);
    INSERT INTO reminders_fts(rowid, trigger_pattern) VALUES (new.rowid, new.trigger_pattern);
  END`,
];

export const CREATE_COMPACTION_SNAPSHOTS_TABLE = `
CREATE TABLE IF NOT EXISTS compaction_snapshots (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  recent_files TEXT,
  recent_read_files TEXT,
  recent_commands TEXT,
  user_context TEXT,
  approach_notes TEXT,
  initial_goal TEXT,
  goal_captured_at TEXT,
  goal_branch TEXT,
  goal_carry_count INTEGER DEFAULT 0,
  recent_decisions TEXT,
  reasoning_state TEXT,
  error_context TEXT,
  project_goal TEXT,
  project_goal_source TEXT,
  project_goal_captured_at TEXT,
  last_edit_cursor TEXT
)`;

export const CREATE_HOOK_TELEMETRY_TABLE = `
CREATE TABLE IF NOT EXISTS hook_telemetry (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hook_name TEXT NOT NULL,
  event_type TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  success INTEGER NOT NULL DEFAULT 1,
  error_message TEXT,
  metadata TEXT,
  agent_id TEXT DEFAULT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/** v30 — durable tokens-saved aggregates. hook_telemetry is pruned at 7
 *  days; the report needs months, so aggregates persist here (own long
 *  retention in maintenance). One row per (session, surface) event. */
export const CREATE_TELEMETRY_ROLLUP_TABLE = `
CREATE TABLE IF NOT EXISTS telemetry_rollup (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  day TEXT NOT NULL,
  metric TEXT NOT NULL,
  surface TEXT NOT NULL DEFAULT '',
  tokens INTEGER NOT NULL,
  events INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

export const CREATE_PROJECT_CONTEXT_TABLE = `
CREATE TABLE IF NOT EXISTS project_context (
  project TEXT NOT NULL,
  git_hash TEXT NOT NULL,
  context TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  PRIMARY KEY (project, git_hash)
)`;

export const CREATE_SCHEMA_VERSION_TABLE = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
)`;

/** Rolling context vector cache — one embedding per project, updated by MCP server.
 *  Hooks write pending prompts (embedding NULL), MCP server computes and blends. */
export const CREATE_CONTEXT_VECTOR_TABLE = `
CREATE TABLE IF NOT EXISTS context_vectors (
  project TEXT PRIMARY KEY,
  embedding BLOB,
  embedding_model TEXT DEFAULT NULL,
  pending_prompt TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/** v27: structural revision counter for memory-tool CAS (roadmap W4).
 *  Fires on SET-clause mention of any RENDERED-SEMANTIC column — embeddings
 *  and telemetry are deliberately excluded (they never change a rendered
 *  block). The inner update mentions only `revision`, which appears in no
 *  trigger's UPDATE OF list, so it can never recurse or re-fire FTS under
 *  either recursive_triggers setting. */
export const CREATE_MEMORY_REVISION_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS memories_revision_au AFTER UPDATE OF
  content, kind, project, tags, confidence, source, context, anchor,
  invalidated, expires_at, superseded_by, superseded_at
ON memories BEGIN
  UPDATE memories SET revision = revision + 1, updated_at = datetime('now') WHERE id = new.id;
END`;

/** v27: free-form memory-tool files (roadmap W4). The CHECK is a BYTE cap —
 *  SQLite length(TEXT) counts characters, so the content is cast to BLOB. */
export const CREATE_MEMORY_FILES_TABLE = `
CREATE TABLE IF NOT EXISTS memory_files (
  path TEXT PRIMARY KEY,
  content TEXT NOT NULL CHECK (length(CAST(content AS BLOB)) <= 65536),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
)`;

export const CREATE_MEMORY_FILES_REVISION_TRIGGER = `
CREATE TRIGGER IF NOT EXISTS memory_files_revision_au AFTER UPDATE OF content ON memory_files BEGIN
  UPDATE memory_files SET revision = revision + 1 WHERE path = new.path;
END`;

/** v27: exact-scope partial index for memory-tool file queries
 *  (project = ? AND kind = ? over ACTIVE records — active means neither
 *  invalidated nor superseded; both predicates are required or the index
 *  covers retired records). */
export const CREATE_EXACT_SCOPE_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_memories_project_kind_active ON memories(project, kind) WHERE invalidated = 0 AND superseded_by IS NULL';

/** v31: exact-content dedup lookup (kind, project, content) over ACTIVE
 *  records. findSimilar's exact check must be independent of FTS (its
 *  query tokenization diverges from unicode61 on non-ASCII, and
 *  stopword-only content builds no query at all), and without an index
 *  the plain equality read scans every active row in scope on EVERY
 *  gateway write (measured: 1000 writes into a single-scope 10k-row
 *  store took ~48s). Storage cost is real, not just "bounded": measured
 *  ~4.4MB per 20k rows of ~180-char content (~36% of the store, and at
 *  worst-case 2000-char content the index would rival the table) —
 *  accepted for O(log n) exactness on every gateway write. */
export const CREATE_EXACT_DEDUP_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_memories_exact_dedup ON memories(kind, project, content) WHERE invalidated = 0 AND superseded_by IS NULL';

/** Version history for corrected/updated memories — preserves decision evolution. */
export const CREATE_MEMORY_VERSIONS_TABLE = `
CREATE TABLE IF NOT EXISTS memory_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  old_content TEXT NOT NULL,
  new_content TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
)`;

export const CREATE_MEMORY_VERSIONS_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_memory_versions_memory ON memory_versions(memory_id)';

/** Investigation chains — debugging sequence tracking.
 *  Stores trigger → attempts → resolution as a coherent chain. */
export const CREATE_INVESTIGATION_CHAINS_TABLE = `
CREATE TABLE IF NOT EXISTS investigation_chains (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  session_id TEXT NOT NULL,
  trigger_error TEXT NOT NULL,
  attempts TEXT NOT NULL DEFAULT '[]',
  resolution TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  memory_ids TEXT DEFAULT '[]'
)`;

export const CREATE_INVESTIGATION_CHAINS_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_chains_project_session ON investigation_chains(project, session_id)',
  'CREATE INDEX IF NOT EXISTS idx_chains_resolved ON investigation_chains(resolved_at)',
];

/** Structured user model — queryable dimensions (role, expertise, preference, etc.) */
export const CREATE_USER_MODEL_TABLE = `
CREATE TABLE IF NOT EXISTS user_model (
  id TEXT PRIMARY KEY,
  dimension TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(dimension, key)
)`;

// --- Indexes ----------------------------------------------------------------

export const CREATE_INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project)',
  'CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind)',
  'CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence DESC)',
  'CREATE INDEX IF NOT EXISTS idx_memories_invalidated ON memories(invalidated)',
  'CREATE INDEX IF NOT EXISTS idx_memories_last_recalled ON memories(last_recalled)',
  'CREATE INDEX IF NOT EXISTS idx_memories_superseded ON memories(superseded_by)',
  'CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project, started_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_plans_project ON plans(project, status)',
  'CREATE INDEX IF NOT EXISTS idx_snapshots_session ON compaction_snapshots(session_id)',
  'CREATE INDEX IF NOT EXISTS idx_plan_decisions_plan ON plan_decisions(plan_id)',
  'CREATE INDEX IF NOT EXISTS idx_reminders_active ON reminders(active, project)',
  'CREATE INDEX IF NOT EXISTS idx_telemetry_hook ON hook_telemetry(hook_name, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_rollup_day ON telemetry_rollup(day, metric)',
];

// --- All DDL in order -------------------------------------------------------

/** v32 — Phase 2 team-sync neutral replica state (free core; see the
 *  gate-passed brief's ownership map). Standalone value without any sync
 *  worker: tombstones = audit/undo of forgets; the journal = local audit
 *  of semantic changes; the rest is inert until a consumer registers. */

/** Retraction log written by deleteById/invalidate — tombstone propagation
 *  for sync, forget-audit standalone. */
export const CREATE_MEMORY_TOMBSTONES_TABLE = `
CREATE TABLE IF NOT EXISTS memory_tombstones (
  memory_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('delete','invalidate')),
  project TEXT,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, action, deleted_at)
)`;

/** Local row ↔ cloud entity. Cardinality is the brief's rule: one entity
 *  maps to at most one local row and vice versa; `shadow-assoc` rows carry
 *  the inert projection + contributor snapshot so materialization is
 *  offline-executable. */
export const CREATE_SYNC_ENTITY_MAP_TABLE = `
CREATE TABLE IF NOT EXISTS sync_entity_map (
  entity_id TEXT PRIMARY KEY,
  local_memory_id TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('bound','shadow-assoc')),
  canonical_version INTEGER NOT NULL,
  canonical_hash TEXT NOT NULL,
  projection_hash TEXT NOT NULL,
  inert_projection TEXT DEFAULT NULL,
  contributors TEXT DEFAULT NULL,
  updated_at TEXT NOT NULL
)`;

export const CREATE_SYNC_ALIAS_LOG_TABLE = `
CREATE TABLE IF NOT EXISTS sync_alias_log (
  from_entity_id TEXT PRIMARY KEY,
  to_entity_id TEXT NOT NULL,
  as_of_version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  applied_at TEXT NOT NULL
)`;

export const CREATE_SYNC_CONFLICT_SETS_TABLE = `
CREATE TABLE IF NOT EXISTS sync_conflict_sets (
  conflict_set_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  member_entity_ids TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('near-duplicate','divergence')),
  opened_by TEXT NOT NULL,
  opened_seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  resolved_seq INTEGER DEFAULT NULL
)`;

/** Append-only contributor projection (server-stamped provenance mirror). */
export const CREATE_SYNC_CONTRIBUTORS_TABLE = `
CREATE TABLE IF NOT EXISTS sync_contributors (
  entity_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  first_seq INTEGER NOT NULL,
  PRIMARY KEY (entity_id, account_id)
)`;

/** Opaque namespaced kv: cursors, durable memory generation, rename
 *  intents, consent fences. Written only inside owner transactions. */
export const CREATE_SYNC_STATE_TABLE = `
CREATE TABLE IF NOT EXISTS sync_state (
  ns TEXT NOT NULL,
  k TEXT NOT NULL,
  v TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ns, k)
)`;

/** Semantic-change journal: written by repository code in the memory
 *  transaction (shareable mutations only, rescopes suppressed); the
 *  worker classifies entries durably. Admission uses only row-local,
 *  frozen-protocol predicates — the journal is never authorization to
 *  upload. */
export const CREATE_SYNC_JOURNAL_TABLE = `
CREATE TABLE IF NOT EXISTS sync_journal (
  entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  memory_id TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert','tombstone')),
  row_revision INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  classification TEXT DEFAULT NULL CHECK (classification IN ('enqueued','permanently-ineligible','deferred-pending-eligibility') OR classification IS NULL),
  classified_at TEXT DEFAULT NULL
)`;

export const CREATE_SYNC_JOURNAL_INDEX =
  'CREATE INDEX IF NOT EXISTS idx_sync_journal_pending ON sync_journal(project, classification)';

export const ALL_DDL: string[] = [
  CREATE_SCHEMA_VERSION_TABLE,
  CREATE_MAINTENANCE_META_TABLE,
  CREATE_MEMORIES_TABLE,
  CREATE_MEMORIES_FTS,
  ...CREATE_FTS_TRIGGERS,
  CREATE_SESSIONS_TABLE,
  CREATE_PLANS_TABLE,
  CREATE_PLAN_STEPS_TABLE,
  CREATE_PLAN_DECISIONS_TABLE,
  CREATE_COMPACTION_SNAPSHOTS_TABLE,
  CREATE_HOOK_TELEMETRY_TABLE,
  CREATE_TELEMETRY_ROLLUP_TABLE,
  CREATE_REMINDERS_TABLE,
  CREATE_REMINDERS_FTS,
  ...CREATE_REMINDERS_FTS_TRIGGERS,
  CREATE_PROJECT_CONTEXT_TABLE,
  CREATE_MEMORY_EDGES_TABLE,
  ...CREATE_EDGE_INDEXES,
  CREATE_MEMORY_CORECALL_TABLE,
  CREATE_SESSION_MEMORIES_TABLE,
  ...CREATE_CORECALL_INDEXES,
  CREATE_CONTEXT_VECTOR_TABLE,
  CREATE_MEMORY_REVISION_TRIGGER,
  CREATE_MEMORY_FILES_TABLE,
  CREATE_MEMORY_FILES_REVISION_TRIGGER,
  CREATE_EXACT_SCOPE_INDEX,
  CREATE_EXACT_DEDUP_INDEX,
  CREATE_MEMORY_VERSIONS_TABLE,
  CREATE_MEMORY_VERSIONS_INDEX,
  CREATE_MEMORY_TOMBSTONES_TABLE,
  CREATE_SYNC_ENTITY_MAP_TABLE,
  CREATE_SYNC_ALIAS_LOG_TABLE,
  CREATE_SYNC_CONFLICT_SETS_TABLE,
  CREATE_SYNC_CONTRIBUTORS_TABLE,
  CREATE_SYNC_STATE_TABLE,
  CREATE_SYNC_JOURNAL_TABLE,
  CREATE_SYNC_JOURNAL_INDEX,
  CREATE_INVESTIGATION_CHAINS_TABLE,
  ...CREATE_INVESTIGATION_CHAINS_INDEXES,
  CREATE_USER_MODEL_TABLE,
  ...GOVERNANCE_DDL,
  ...CREATE_INDEXES,
];
