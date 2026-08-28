/**
 * Codex parity Slice A — client adapter, v29 provenance, and guards.
 * Covers: payload normalization (client stamp + SessionStart source→type),
 * origin_client threading through create/storeMemory, the v29 migration
 * (fresh DB + upgrade + idempotent re-run), and MCP clientInfo mapping.
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { migrateToV29 } from '../src/db/migrations/v29-origin-client.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import {
  normalizeHookInput,
  isCodexClient,
  deriveOriginClient,
  originClientOf,
  wrapContextOutput,
  registerClientAdapter,
  capabilitiesOf,
} from '../src/hooks/shared/client-adapter.js';
import { CLIENT_CLAUDE, CLIENT_CODEX, CLIENT_UNKNOWN } from '../src/constants/clients.js';

describe('normalizeHookInput', () => {
  it('stamps the declared client when the payload has none', () => {
    const input: Record<string, unknown> = { session_id: 's1' };
    normalizeHookInput(input, CLIENT_CODEX);
    assert.equal(input.client_name, CLIENT_CODEX);
  });

  it('declared identity overrides any client_name the payload asserts', () => {
    const input: Record<string, unknown> = { session_id: 's1', client_name: 'claude' };
    normalizeHookInput(input, CLIENT_CODEX);
    assert.equal(input.client_name, CLIENT_CODEX);
  });

  it('leaves client_name absent when no client is declared', () => {
    const input: Record<string, unknown> = { session_id: 's1' };
    normalizeHookInput(input, undefined);
    assert.equal('client_name' in input, false);
  });

  it('maps SessionStart source to type when type is absent', () => {
    const input: Record<string, unknown> = {
      hook_event_name: 'SessionStart',
      source: 'compact',
    };
    normalizeHookInput(input, CLIENT_CODEX);
    assert.equal(input.type, 'compact');
  });

  it('an explicit type always wins over source', () => {
    const input: Record<string, unknown> = {
      hook_event_name: 'SessionStart',
      source: 'startup',
      type: 'resume',
    };
    normalizeHookInput(input, CLIENT_CODEX);
    assert.equal(input.type, 'resume');
  });

  it('does not map source outside SessionStart or for unknown values', () => {
    const other: Record<string, unknown> = { hook_event_name: 'Stop', source: 'startup' };
    normalizeHookInput(other, CLIENT_CODEX);
    assert.equal('type' in other, false);

    const bogus: Record<string, unknown> = { hook_event_name: 'SessionStart', source: 'weird' };
    normalizeHookInput(bogus, CLIENT_CODEX);
    assert.equal('type' in bogus, false);
  });

  it('NEVER maps source→type for Claude sessions — sessionType stays inference-derived', () => {
    // Claude Code sends `source` on SessionStart and never `type`; mapping it
    // would silently replace the deliberate tracker/snapshot inference.
    const undeclared: Record<string, unknown> = { hook_event_name: 'SessionStart', source: 'compact' };
    normalizeHookInput(undeclared, undefined);
    assert.equal('type' in undeclared, false);

    const declaredClaude: Record<string, unknown> = { hook_event_name: 'SessionStart', source: 'compact' };
    normalizeHookInput(declaredClaude, CLIENT_CLAUDE);
    assert.equal('type' in declaredClaude, false);
  });
});

describe('isCodexClient / deriveOriginClient', () => {
  it('identifies codex only when declared', () => {
    assert.equal(isCodexClient({ client_name: CLIENT_CODEX }), true);
    assert.equal(isCodexClient({ client_name: CLIENT_CLAUDE }), false);
    assert.equal(isCodexClient({}), false);
  });

  it('maps MCP clientInfo names to canonical clients', () => {
    assert.equal(deriveOriginClient('codex'), CLIENT_CODEX);
    assert.equal(deriveOriginClient('Codex CLI (rmcp)'), CLIENT_CODEX);
    assert.equal(deriveOriginClient('claude-code'), CLIENT_CLAUDE);
    assert.equal(deriveOriginClient('some-agent'), CLIENT_UNKNOWN);
    assert.equal(deriveOriginClient(undefined), CLIENT_UNKNOWN);
  });

  it('originClientOf: hook-path provenance defaults to claude, canonicalizes declared clients', () => {
    assert.equal(originClientOf({}), CLIENT_CLAUDE);
    assert.equal(originClientOf({ client_name: CLIENT_CODEX }), CLIENT_CODEX);
    assert.equal(originClientOf({ client_name: 'claude-code' }), CLIENT_CLAUDE);
  });
});

describe('wrapContextOutput', () => {
  it('wraps codex output in the hookSpecificOutput envelope', () => {
    const wrapped = wrapContextOutput({ client_name: CLIENT_CODEX }, 'SessionStart', 'briefing text');
    const parsed = JSON.parse(wrapped ?? '') as {
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.equal(parsed.hookSpecificOutput.additionalContext, 'briefing text');
  });

  it('passes claude and null outputs through unchanged', () => {
    assert.equal(wrapContextOutput({}, 'SessionStart', 'plain'), 'plain');
    assert.equal(wrapContextOutput({ client_name: CLIENT_CLAUDE }, 'UserPromptSubmit', 'plain'), 'plain');
    assert.equal(wrapContextOutput({ client_name: CLIENT_CODEX }, 'SessionStart', null), null);
  });
});

describe('origin_client provenance (schema v29)', () => {
  let db: Database.Database;
  let repo: MemoryRepository;

  beforeEach(() => {
    db = openDatabase({ dbPath: ':memory:' });
    repo = new MemoryRepository(db);
  });

  function originOf(id: string): string {
    const row = db.prepare('SELECT origin_client FROM memories WHERE id = ?').get(id) as { origin_client: string };
    return row.origin_client;
  }

  it('create() defaults origin_client to claude', () => {
    const { id } = repo.create({ content: 'origin default check — unique alpha', kind: 'fact' });
    assert.equal(originOf(id), CLIENT_CLAUDE);
  });

  it('create() stores a declared codex origin', () => {
    const { id } = repo.create({
      content: 'origin codex check — unique beta',
      kind: 'fact',
      originClient: CLIENT_CODEX,
    });
    assert.equal(originOf(id), CLIENT_CODEX);
  });

  it('storeDecision gateway threads origin_client through', () => {
    const { id } = repo.storeDecision({
      content: 'chose adapter-thin codex port because payloads are wire-compatible — unique gamma',
      project: 'codex-adapter-test',
      originClient: CLIENT_CODEX,
    });
    assert.equal(originOf(id), CLIENT_CODEX);
  });

  it('storePitfall gateway threads origin_client through', () => {
    const { id } = repo.storePitfall({
      content: 'codex tool_response carries no failure signal — demux via rollout lookup — unique delta',
      project: 'codex-adapter-test',
      originClient: CLIENT_CODEX,
    });
    assert.equal(originOf(id), CLIENT_CODEX);
  });
});

describe('migrateToV29', () => {
  it('adds the column to a pre-v29 table and is idempotent', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    // Simulate a pre-v29 memories table: rebuild without the column
    db.exec(`
      DROP TABLE memories;
      CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, kind TEXT NOT NULL);
    `);
    const before = (db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>);
    assert.equal(before.some((c) => c.name === 'origin_client'), false);

    migrateToV29(db);
    const after = (db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>);
    assert.equal(after.some((c) => c.name === 'origin_client'), true);

    // Re-run must be a no-op, not a duplicate-column error
    migrateToV29(db);
    const version = (db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number }).version;
    assert.equal(version, 29);
  });

  it('backfills existing rows with the claude default', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    db.exec(`
      DROP TABLE memories;
      CREATE TABLE memories (id TEXT PRIMARY KEY, content TEXT NOT NULL, kind TEXT NOT NULL);
      INSERT INTO memories (id, content, kind) VALUES ('m1', 'pre-v29 row', 'fact');
    `);
    migrateToV29(db);
    const row = db.prepare('SELECT origin_client FROM memories WHERE id = ?').get('m1') as { origin_client: string };
    assert.equal(row.origin_client, CLIENT_CLAUDE);
  });
});

describe('the extension seam (registerClientAdapter)', () => {
  it('a registered adapter takes over capabilities, wrapping, and gated dialect mapping', () => {
    const NAME = 'seam-test-agent';
    registerClientAdapter({
      name: NAME,
      capabilities: {
        toolFailureSignal: 'event',
        contextOutput: 'envelope',
        emitsPermissionDecision: false,
        crossAgentFraming: true,
        sigilNudges: false,
      },
      normalizeInput: (input, declared) => {
        if (declared !== NAME) return;
        if (input.type === undefined && typeof input.origin === 'string') input.type = input.origin;
      },
      wrapContextOutput: (event, output) => `[${event}] ${output}`,
    });

    const input = normalizeHookInput({ hook_event_name: 'SessionStart', origin: 'startup' }, NAME);
    assert.equal(input.client_name, NAME);
    assert.equal(input.type, 'startup', 'its own dialect mapping ran');
    assert.equal(capabilitiesOf(input).sigilNudges, false, 'its capabilities dispatch');
    assert.equal(wrapContextOutput(input, 'SessionStart', 'ctx'), '[SessionStart] ctx', 'its wrapper dispatches');
  });

  it('LOCK-IN: an UNREGISTERED declared client gets no Codex dialect mapping and Claude defaults', () => {
    // Before the registry, `clientName !== claude` mapped source→type for
    // ANY non-Claude name; a dialect now belongs to its adapter alone.
    const input = normalizeHookInput(
      { hook_event_name: 'SessionStart', source: 'startup' }, 'gemini');
    assert.equal(input.client_name, 'gemini');
    assert.equal(input.type, undefined, 'Codex source→type mapping must not leak to other clients');
    assert.equal(capabilitiesOf(input).contextOutput, 'plain', 'unknown names degrade to the Claude default');
  });

  it('declared names are canonicalized to lowercase — "Codex" must not get Claude capabilities', () => {
    const input = normalizeHookInput(
      { hook_event_name: 'SessionStart', source: 'resume' }, 'Codex');
    assert.equal(input.client_name, CLIENT_CODEX);
    assert.equal(input.type, 'resume', 'dialect mapping applies after canonicalization');
    assert.equal(capabilitiesOf(input).contextOutput, 'envelope');
  });
});
