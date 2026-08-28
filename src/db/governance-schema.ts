// Schema v28 governance tables and indexes. Kept separate from schema.ts so
// the migration and fresh-schema paths consume one reviewed DDL surface.

export const CREATE_GOVERNANCE_TOOL_EVENTS_TABLE = `
CREATE TABLE IF NOT EXISTS governance_tool_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  canonical_root TEXT NOT NULL,
  session_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_version TEXT,
  hook_event TEXT NOT NULL CHECK (hook_event IN ('PostToolUse','PostToolUseFailure','FileChanged')),
  tool_name TEXT,
  tool_use_id TEXT,
  delivery_fingerprint TEXT,
  received_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  raw_command TEXT,
  redacted_command TEXT,
  command_sha256 TEXT,
  cwd TEXT,
  normalized_argv TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','unknown_failure')),
  exit_code INTEGER,
  signal TEXT,
  interrupted INTEGER NOT NULL DEFAULT 0 CHECK (interrupted IN (0,1)),
  timed_out INTEGER NOT NULL DEFAULT 0 CHECK (timed_out IN (0,1)),
  output_sha256 TEXT,
  redacted_diagnostic TEXT,
  mutation_class TEXT NOT NULL CHECK (mutation_class IN ('none','scoped','unknown')),
  affected_paths TEXT NOT NULL DEFAULT '[]',
  mutation_seq INTEGER NOT NULL DEFAULT 0 CHECK (mutation_seq >= 0),
  adapter_name TEXT NOT NULL,
  adapter_version INTEGER NOT NULL CHECK (adapter_version > 0),
  capture_status TEXT NOT NULL CHECK (capture_status IN ('complete','failed','incomplete','adapter_error')),
  capture_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
)`;

export const CREATE_GOVERNANCE_GATE_RUNS_TABLE = `
CREATE TABLE IF NOT EXISTS governance_gate_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_seq INTEGER NOT NULL REFERENCES governance_tool_events(event_seq) ON DELETE RESTRICT,
  project TEXT NOT NULL,
  session_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  gate_id TEXT NOT NULL,
  rule_id TEXT,
  rule_revision INTEGER CHECK (rule_revision IS NULL OR rule_revision > 0),
  config_version INTEGER NOT NULL CHECK (config_version > 0),
  config_sha256 TEXT NOT NULL,
  parser_name TEXT NOT NULL,
  parser_version INTEGER NOT NULL CHECK (parser_version > 0),
  test_total INTEGER CHECK (test_total IS NULL OR test_total >= 0),
  test_pass INTEGER CHECK (test_pass IS NULL OR test_pass >= 0),
  test_fail INTEGER CHECK (test_fail IS NULL OR test_fail >= 0),
  test_skip INTEGER CHECK (test_skip IS NULL OR test_skip >= 0),
  skip_reasons_complete INTEGER CHECK (skip_reasons_complete IS NULL OR skip_reasons_complete IN (0,1)),
  worktree_digest TEXT,
  digest_version INTEGER CHECK (digest_version IS NULL OR digest_version > 0),
  mutation_seq INTEGER NOT NULL CHECK (mutation_seq >= 0),
  relevant_paths_sha256 TEXT,
  capture_result TEXT NOT NULL CHECK (capture_result IN ('complete','failed','incomplete','adapter_error')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(event_seq, gate_id)
)`;

export const CREATE_GOVERNANCE_AUDIT_TABLE = `
CREATE TABLE IF NOT EXISTS governance_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL,
  session_id TEXT,
  client_name TEXT,
  occurred_at TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_class TEXT NOT NULL,
  redacted_detail TEXT NOT NULL,
  linked_rule_id TEXT,
  linked_rule_memory_id TEXT REFERENCES memories(id) ON DELETE RESTRICT,
  linked_gate_id TEXT,
  linked_event_seq INTEGER REFERENCES governance_tool_events(event_seq) ON DELETE SET NULL,
  payload_version INTEGER NOT NULL CHECK (payload_version > 0),
  payload TEXT NOT NULL DEFAULT '{}'
)`;

export const CREATE_GOVERNANCE_CLIENT_STATE_TABLE = `
CREATE TABLE IF NOT EXISTS governance_client_state (
  project TEXT NOT NULL,
  client_installation_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  client_version TEXT,
  supports_post_tool_use INTEGER CHECK (supports_post_tool_use IS NULL OR supports_post_tool_use IN (0,1)),
  supports_post_tool_failure INTEGER CHECK (supports_post_tool_failure IS NULL OR supports_post_tool_failure IN (0,1)),
  supports_file_changed INTEGER CHECK (supports_file_changed IS NULL OR supports_file_changed IN (0,1)),
  supports_structured_output INTEGER CHECK (supports_structured_output IS NULL OR supports_structured_output IN (0,1)),
  supports_stop INTEGER CHECK (supports_stop IS NULL OR supports_stop IN (0,1)),
  supports_blocking INTEGER CHECK (supports_blocking IS NULL OR supports_blocking IN (0,1)),
  adapter_version INTEGER NOT NULL CHECK (adapter_version > 0),
  settings_source TEXT,
  last_session_id TEXT,
  last_heartbeat_at TEXT,
  last_probe_result TEXT,
  PRIMARY KEY (project, client_installation_id)
)`;

export const CREATE_GOVERNANCE_INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_gov_events_tool_delivery
    ON governance_tool_events(client_name, session_id, tool_use_id, hook_event)
    WHERE tool_use_id IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_gov_events_file_delivery
    ON governance_tool_events(client_name, session_id, delivery_fingerprint)
    WHERE hook_event = 'FileChanged' AND delivery_fingerprint IS NOT NULL`,
  'CREATE INDEX IF NOT EXISTS idx_gov_events_project_session_seq ON governance_tool_events(project, session_id, event_seq)',
  'CREATE INDEX IF NOT EXISTS idx_gov_events_retention ON governance_tool_events(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_gov_gate_config ON governance_gate_runs(project, gate_id, config_sha256, event_seq DESC)',
  'CREATE INDEX IF NOT EXISTS idx_gov_gate_retention ON governance_gate_runs(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_gov_audit_chronology ON governance_audit(project, occurred_at, id)',
  'CREATE INDEX IF NOT EXISTS idx_gov_audit_rule ON governance_audit(project, linked_rule_id, id)',
  'CREATE INDEX IF NOT EXISTS idx_gov_client_heartbeat ON governance_client_state(project, last_heartbeat_at)',
] as const;

export const GOVERNANCE_DDL = [
  CREATE_GOVERNANCE_TOOL_EVENTS_TABLE,
  CREATE_GOVERNANCE_GATE_RUNS_TABLE,
  CREATE_GOVERNANCE_AUDIT_TABLE,
  CREATE_GOVERNANCE_CLIENT_STATE_TABLE,
  ...CREATE_GOVERNANCE_INDEXES,
] as const;
