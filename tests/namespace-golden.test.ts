/**
 * Namespace golden — the ONE place a namespaced identifier is written out.
 *
 * Everywhere else derives from `NAMESPACE` (guarded by
 * namespace-centralization.test.ts). Derivation alone proves nothing about the
 * VALUES, though: a test that rebuilds its expectation from the same constant
 * the code used is tautological. So this file deliberately hardcodes, and is
 * the single intentional edit when the namespace changes.
 *
 * Its second job is to make the blast radius legible. Flipping `NAMESPACE` to
 * 'waykeep' builds cleanly and fails a few hundred tests across ~44 files —
 * loudly, never silently. Exact counts vary run to run (some tests cancel
 * under load), so treat the shape as the claim, not a number. That failures
 * are LOUD is the point: without the hermetic preload deriving its names they
 * would pass while reading and writing the developer's real home directory.
 *
 * When this file goes red, that is the rename happening. Update it on purpose.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAMESPACE, ENV_PREFIX, DATA_DIR_NAME, DB_FILENAME,
  MCP_SERVER_NAME, MCP_TOOL_PREFIX, MCP_URI_SCHEME,
  RELAY_PROBE_FLAG, RELAY_PROBE_SENTINEL, CLIENT_HEADER, CLIENT_ENV_VAR,
  PRODUCT_DISPLAY_NAME, LEGACY_NAMESPACES,
} from 'waykeep-contract';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENV } from '../src/constants/env.js';
import { FILES, BACKUP_SUFFIX, MIGRATION_MARKER } from '../src/constants/paths.js';
import { TOOL, RESOURCE_URI, qualifiedToolName } from '../src/constants/mcp.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('namespace golden — every externally visible identifier', () => {
  it('the legacy-namespace list is pinned — the flip populated it', () => {
    assert.deepEqual([...LEGACY_NAMESPACES], ['cairn'],
      'the v6.0.0 flip retired cairn; removing it here blinds the guards to stragglers');
  });

  it('brand and slug are distinct, and only the slug is an identifier', () => {
    // Since v6.0.0 brand and slug agree; they remain distinct constants
    // because only the slug may appear in identifiers.
    assert.equal(PRODUCT_DISPLAY_NAME, 'Waykeep');
    assert.equal(NAMESPACE, 'waykeep');
  });

  it('derived primitives', () => {
    assert.equal(ENV_PREFIX, 'WAYKEEP');
    assert.equal(DATA_DIR_NAME, '.waykeep');
    assert.equal(DB_FILENAME, 'waykeep.db');
    assert.equal(MCP_SERVER_NAME, 'waykeep');
    assert.equal(MCP_TOOL_PREFIX, 'waykeep_');
    assert.equal(MCP_URI_SCHEME, 'waykeep');
  });

  it('relay handshake — both halves, which must never diverge', () => {
    assert.equal(RELAY_PROBE_FLAG, '--waykeep-probe');
    assert.equal(RELAY_PROBE_SENTINEL, 'waykeep-relay');
    assert.equal(CLIENT_HEADER, 'x-waykeep-client');
    assert.equal(CLIENT_ENV_VAR, 'WAYKEEP_CLIENT');
  });

  it('every environment variable name', () => {
    assert.deepEqual({ ...ENV }, {
      DB_PATH: 'WAYKEEP_DB_PATH',
      DIR: 'WAYKEEP_DIR',
      CONFIG_PATH: 'WAYKEEP_CONFIG_PATH',
      STATE_PATH: 'WAYKEEP_STATE_PATH',
      CLIENT: 'WAYKEEP_CLIENT',
      NODE: 'WAYKEEP_NODE',
      CLAUDE_SETTINGS: 'WAYKEEP_CLAUDE_SETTINGS',
      CODEX_DIR: 'WAYKEEP_CODEX_DIR',
      CODEX_SESSIONS_DIR: 'WAYKEEP_CODEX_SESSIONS_DIR',
      GOVERNANCE_TIMEOUT_MS: 'WAYKEEP_GOVERNANCE_TIMEOUT_MS',
      DAEMON_TIMEOUT_MS: 'WAYKEEP_DAEMON_TIMEOUT_MS',
      EMBEDDING_MODEL: 'WAYKEEP_EMBEDDING_MODEL',
      RERANK: 'WAYKEEP_RERANK',
      RERANK_MODEL: 'WAYKEEP_RERANK_MODEL',
      QUERY_CWD: 'WAYKEEP_QUERY_CWD',
      PERSIST_RAW_COMMAND: 'WAYKEEP_PERSIST_RAW_COMMAND',
      ALLOW_TMP_TRANSCRIPTS: 'WAYKEEP_ALLOW_TMP_TRANSCRIPTS',
      ROLLUP: 'WAYKEEP_ROLLUP',
      TAILER: 'WAYKEEP_TAILER',
      TZ: 'WAYKEEP_TZ',
      VERBOSE: 'WAYKEEP_VERBOSE',
      LOG_LEVEL: 'WAYKEEP_LOG_LEVEL',
      INSPECTOR_TEST: 'WAYKEEP_INSPECTOR_TEST',
      RUN_SHADOW_BENCHMARK: 'WAYKEEP_RUN_SHADOW_BENCHMARK',
      RUN_WARN_RELAY_BENCHMARK: 'WAYKEEP_RUN_WARN_RELAY_BENCHMARK',
    }, 'an env var was added, removed or respelled — update every consumer, then this golden');
  });

  it('every MCP tool name, as agents call them', () => {
    assert.deepEqual({ ...TOOL }, {
      RECALL: 'waykeep_recall',
      LEARN: 'waykeep_learn',
      CORRECT: 'waykeep_correct',
      FORGET: 'waykeep_forget',
      STRENGTHEN: 'waykeep_strengthen',
      WEAKEN: 'waykeep_weaken',
      EXPAND: 'waykeep_expand',
      CLEANUP: 'waykeep_cleanup',
      PLAN: 'waykeep_plan',
      REMIND: 'waykeep_remind',
      REMINDER_LIST: 'waykeep_reminder_list',
      REMINDER_DELETE: 'waykeep_reminder_delete',
      INGEST: 'waykeep_ingest',
      EXPORT: 'waykeep_export',
      PROMOTE: 'waykeep_promote',
      STATS: 'waykeep_stats',
      GOVERNANCE_OVERRIDE: 'waykeep_governance_override',
    }, 'a tool name changed — every agent integration and prompt referencing it breaks');
  });

  it('the Phase-B migration marker filename', () => {
    // The relays, launcher and resolveStateRoot all key "migrated" off this
    // exact name across TS, C and shell — a rename here silently strands
    // every migrated install on the legacy root. Hardcoded on purpose.
    assert.equal(MIGRATION_MARKER, 'waykeep-migrated.json');
  });

  it('namespaced FILENAMES and suffixes — easy to forget, all agent- or disk-visible', () => {
    assert.equal(FILES.CLIENT_STATE, 'waykeep-state.json');
    assert.equal(FILES.TRUST_SHADOW, '.waykeep-trust-shadow.json');
    assert.equal(BACKUP_SUFFIX, '.waykeep-backup');
    // Read from the GENERATED artifact, not rebuilt from NAMESPACE: the latter
    // reduces to 'waykeep' + '-hook' === 'waykeep-hook', which asserts nothing.
    const generated = JSON.parse(readFileSync(
      join(REPO, 'dist', 'generated', 'identity.json'), 'utf-8')) as { TMP_PREFIX: string };
    assert.equal(generated.TMP_PREFIX, 'waykeep-hook', 'shell relay mktemp prefix');
  });

  it('resource URIs and the client-qualified form', () => {
    assert.deepEqual({ ...RESOURCE_URI }, {
      ACTIVE_PLAN: 'waykeep://plan/{project}/active',
      FULL_BRIEFING: 'waykeep://briefing/{project}',
    });
    assert.equal(qualifiedToolName(TOOL.PLAN), 'mcp__waykeep__waykeep_plan');
  });
});
