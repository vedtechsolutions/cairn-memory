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
import { FILES, BACKUP_SUFFIX } from '../src/constants/paths.js';
import { TOOL, RESOURCE_URI, qualifiedToolName } from '../src/constants/mcp.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('namespace golden — every externally visible identifier', () => {
  it('the legacy-namespace list is pinned — the flip must populate it', () => {
    assert.deepEqual([...LEGACY_NAMESPACES], [],
      'renaming means adding the OUTGOING name here, or the guards go blind to stragglers');
  });

  it('brand and slug are distinct, and only the slug is an identifier', () => {
    // The BRAND already renamed; the technical slug has not. Conflating them is
    // what makes the remaining work look larger than it is.
    assert.equal(PRODUCT_DISPLAY_NAME, 'Waykeep');
    assert.equal(NAMESPACE, 'cairn');
  });

  it('derived primitives', () => {
    assert.equal(ENV_PREFIX, 'CAIRN');
    assert.equal(DATA_DIR_NAME, '.cairn');
    assert.equal(DB_FILENAME, 'cairn.db');
    assert.equal(MCP_SERVER_NAME, 'cairn');
    assert.equal(MCP_TOOL_PREFIX, 'cairn_');
    assert.equal(MCP_URI_SCHEME, 'cairn');
  });

  it('relay handshake — both halves, which must never diverge', () => {
    assert.equal(RELAY_PROBE_FLAG, '--cairn-probe');
    assert.equal(RELAY_PROBE_SENTINEL, 'cairn-relay');
    assert.equal(CLIENT_HEADER, 'x-cairn-client');
    assert.equal(CLIENT_ENV_VAR, 'CAIRN_CLIENT');
  });

  it('every environment variable name', () => {
    assert.deepEqual({ ...ENV }, {
      DB_PATH: 'CAIRN_DB_PATH',
      DIR: 'CAIRN_DIR',
      CONFIG_PATH: 'CAIRN_CONFIG_PATH',
      STATE_PATH: 'CAIRN_STATE_PATH',
      CLIENT: 'CAIRN_CLIENT',
      NODE: 'CAIRN_NODE',
      CLAUDE_SETTINGS: 'CAIRN_CLAUDE_SETTINGS',
      CODEX_DIR: 'CAIRN_CODEX_DIR',
      CODEX_SESSIONS_DIR: 'CAIRN_CODEX_SESSIONS_DIR',
      GOVERNANCE_TIMEOUT_MS: 'CAIRN_GOVERNANCE_TIMEOUT_MS',
      DAEMON_TIMEOUT_MS: 'CAIRN_DAEMON_TIMEOUT_MS',
      EMBEDDING_MODEL: 'CAIRN_EMBEDDING_MODEL',
      RERANK: 'CAIRN_RERANK',
      RERANK_MODEL: 'CAIRN_RERANK_MODEL',
      QUERY_CWD: 'CAIRN_QUERY_CWD',
      PERSIST_RAW_COMMAND: 'CAIRN_PERSIST_RAW_COMMAND',
      ALLOW_TMP_TRANSCRIPTS: 'CAIRN_ALLOW_TMP_TRANSCRIPTS',
      ROLLUP: 'CAIRN_ROLLUP',
      TAILER: 'CAIRN_TAILER',
      TZ: 'CAIRN_TZ',
      VERBOSE: 'CAIRN_VERBOSE',
      LOG_LEVEL: 'CAIRN_LOG_LEVEL',
      INSPECTOR_TEST: 'CAIRN_INSPECTOR_TEST',
      RUN_SHADOW_BENCHMARK: 'CAIRN_RUN_SHADOW_BENCHMARK',
      RUN_WARN_RELAY_BENCHMARK: 'CAIRN_RUN_WARN_RELAY_BENCHMARK',
    }, 'an env var was added, removed or respelled — update every consumer, then this golden');
  });

  it('every MCP tool name, as agents call them', () => {
    assert.deepEqual({ ...TOOL }, {
      RECALL: 'cairn_recall',
      LEARN: 'cairn_learn',
      CORRECT: 'cairn_correct',
      FORGET: 'cairn_forget',
      STRENGTHEN: 'cairn_strengthen',
      WEAKEN: 'cairn_weaken',
      EXPAND: 'cairn_expand',
      CLEANUP: 'cairn_cleanup',
      PLAN: 'cairn_plan',
      REMIND: 'cairn_remind',
      REMINDER_LIST: 'cairn_reminder_list',
      REMINDER_DELETE: 'cairn_reminder_delete',
      INGEST: 'cairn_ingest',
      EXPORT: 'cairn_export',
      PROMOTE: 'cairn_promote',
      STATS: 'cairn_stats',
      GOVERNANCE_OVERRIDE: 'cairn_governance_override',
    }, 'a tool name changed — every agent integration and prompt referencing it breaks');
  });

  it('namespaced FILENAMES and suffixes — easy to forget, all agent- or disk-visible', () => {
    assert.equal(FILES.CLIENT_STATE, 'cairn-state.json');
    assert.equal(FILES.TRUST_SHADOW, '.cairn-trust-shadow.json');
    assert.equal(BACKUP_SUFFIX, '.cairn-backup');
    // Read from the GENERATED artifact, not rebuilt from NAMESPACE: the latter
    // reduces to 'cairn' + '-hook' === 'cairn-hook', which asserts nothing.
    const generated = JSON.parse(readFileSync(
      join(REPO, 'dist', 'generated', 'identity.json'), 'utf-8')) as { TMP_PREFIX: string };
    assert.equal(generated.TMP_PREFIX, 'cairn-hook', 'shell relay mktemp prefix');
  });

  it('resource URIs and the client-qualified form', () => {
    assert.deepEqual({ ...RESOURCE_URI }, {
      ACTIVE_PLAN: 'cairn://plan/{project}/active',
      FULL_BRIEFING: 'cairn://briefing/{project}',
    });
    assert.equal(qualifiedToolName(TOOL.PLAN), 'mcp__cairn__cairn_plan');
  });
});
