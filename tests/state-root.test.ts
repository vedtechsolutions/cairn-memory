/**
 * The coherent state-root decision (Phase B, codex B1 review).
 *
 * One process, ONE root: database, config, state files and the hook socket
 * all derive from `resolveStateRoot()`, chosen once per process — no
 * combination of independent existence checks may split a process across
 * namespaces (the failure mode where the DB came from the legacy store
 * while the legacy privacy config silently read as absent).
 *
 * These gates run REAL subprocesses with a controlled HOME so the actual
 * module-load path — env bootstrap included — is exercised, not a
 * re-implementation of it.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATA_DIR_NAME, DB_FILENAME } from 'waykeep-contract';

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'state-root-home-'));
});

afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Run a probe subprocess under the controlled HOME with a CLEAN env (no
 *  hermetic overrides — the point is exercising the real resolution). */
function probe(script: string, extraEnv: Record<string, string> = {}): string {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', HOME: home, ...extraEnv };
  return execFileSync('node', ['--input-type=module', '-e', script], { encoding: 'utf8', env }).trim();
}

const ROOT_PROBE = `
  const { resolveStateRoot, configPath, dataDir } = await import('${process.cwd()}/dist/src/constants/paths.js');
  const { resolveDbPath } = await import('${process.cwd()}/dist/src/db/db-path.js');
  const root = resolveStateRoot();
  console.log(JSON.stringify({ dir: root.dir, db: resolveDbPath(), config: configPath(), dataDir: dataDir(), legacy: root.legacy }));
`;

describe('coherent state root (Phase B)', () => {
  it('fresh install: everything under the CURRENT root', () => {
    const r = JSON.parse(probe(ROOT_PROBE));
    assert.equal(r.dir, join(home, DATA_DIR_NAME));
    assert.equal(r.db, join(home, DATA_DIR_NAME, DB_FILENAME));
    assert.ok(r.config.startsWith(join(home, DATA_DIR_NAME)));
    assert.equal(r.legacy, false);
  });

  it('un-migrated legacy install: EVERYTHING stays together under ~/.cairn', () => {
    mkdirSync(join(home, '.cairn'));
    writeFileSync(join(home, '.cairn', 'cairn.db'), '');
    const r = JSON.parse(probe(ROOT_PROBE));
    assert.equal(r.dir, join(home, '.cairn'), 'root is the legacy dir');
    assert.equal(r.db, join(home, '.cairn', 'cairn.db'), 'db under its legacy filename');
    assert.ok(r.config.startsWith(join(home, '.cairn')), 'config follows the SAME root — never split');
    assert.equal(r.dataDir, join(home, '.cairn'), 'state files and socket follow too');
    assert.equal(r.legacy, true);
  });

  it('HALF-MIGRATED hazard: a bare mkdir ~/.waykeep does NOT shadow a populated legacy store', () => {
    mkdirSync(join(home, DATA_DIR_NAME)); // something ran mkdir — no marker, no db
    mkdirSync(join(home, '.cairn'));
    writeFileSync(join(home, '.cairn', 'cairn.db'), '');
    const r = JSON.parse(probe(ROOT_PROBE));
    assert.equal(r.dir, join(home, '.cairn'),
      'an empty current dir must not make the user\'s store look empty');
    assert.equal(r.legacy, true);
  });

  it('the migration marker makes the current root authoritative even beside a legacy dir', () => {
    mkdirSync(join(home, DATA_DIR_NAME));
    writeFileSync(join(home, DATA_DIR_NAME, `waykeep-migrated.json`), '{}');
    mkdirSync(join(home, '.cairn'));
    writeFileSync(join(home, '.cairn', 'cairn.db'), '');
    const r = JSON.parse(probe(ROOT_PROBE));
    assert.equal(r.dir, join(home, DATA_DIR_NAME));
    assert.equal(r.legacy, false);
  });

  it('a current DB FILE alone does NOT beat a populated legacy store — only the marker does', () => {
    // The forked-store hazard, pinned: a current waykeep.db (even a real
    // one) beside a legacy store with NO migration marker resolves to
    // LEGACY. A current db file is not proof migration happened; the marker
    // is. Erring toward legacy never abandons the user's data.
    mkdirSync(join(home, DATA_DIR_NAME));
    writeFileSync(join(home, DATA_DIR_NAME, DB_FILENAME), '');
    mkdirSync(join(home, '.cairn'));
    writeFileSync(join(home, '.cairn', 'cairn.db'), '');
    const r = JSON.parse(probe(ROOT_PROBE));
    assert.equal(r.dir, join(home, '.cairn'), 'no marker → legacy wins over a bare current db');
    assert.equal(r.legacy, true);
  });

  it('an empty leftover legacy DIR (no db file) does not capture a fresh install', () => {
    mkdirSync(join(home, '.cairn')); // dir exists, but no cairn.db
    const r = JSON.parse(probe(ROOT_PROBE));
    assert.equal(r.dir, join(home, DATA_DIR_NAME), 'legacy trigger is the DB FILE, not the dir');
    assert.equal(r.legacy, false);
  });

  it('a DIRECTORY named like the marker does not count as migrated', () => {
    mkdirSync(join(home, DATA_DIR_NAME));
    mkdirSync(join(home, DATA_DIR_NAME, 'waykeep-migrated.json')); // a dir, not a file
    mkdirSync(join(home, '.cairn'));
    writeFileSync(join(home, '.cairn', 'cairn.db'), '');
    const r = JSON.parse(probe(ROOT_PROBE));
    assert.equal(r.legacy, true, 'the marker must be a regular FILE to count');
  });

  it('explicit env overrides win regardless of the root decision', () => {
    mkdirSync(join(home, '.cairn'));
    writeFileSync(join(home, '.cairn', 'cairn.db'), '');
    const r = JSON.parse(probe(ROOT_PROBE, {
      WAYKEEP_DB_PATH: '/x/custom.db',
      WAYKEEP_DIR: '/x/dir',
      WAYKEEP_CONFIG_PATH: '/x/config.json',
    }));
    // db override is consumed by openDatabase callers, not resolveDbPath's
    // no-arg default — but DIR and CONFIG_PATH must override directly:
    assert.equal(r.dataDir, '/x/dir');
    assert.equal(r.config, '/x/config.json');
  });

  it('the REAL env bootstrap inherits legacy CAIRN_* values in a fresh process', () => {
    const out = probe(`
      process.env.CAIRN_GOVERNANCE_TIMEOUT_MS = '4321';
      const { ENV } = await import('${process.cwd()}/dist/src/constants/env.js');
      console.log(process.env[ENV.GOVERNANCE_TIMEOUT_MS] ?? 'UNSET');
    `);
    assert.equal(out, '4321', 'module-load bootstrap must copy legacy → current');
  });

  it('the REAL env bootstrap never overrides an explicitly set current value', () => {
    const out = probe(`
      process.env.CAIRN_GOVERNANCE_TIMEOUT_MS = '111';
      process.env.WAYKEEP_GOVERNANCE_TIMEOUT_MS = '999';
      const { ENV } = await import('${process.cwd()}/dist/src/constants/env.js');
      console.log(process.env[ENV.GOVERNANCE_TIMEOUT_MS]);
    `);
    assert.equal(out, '999');
  });

  // codex B1 review — empty-variable parity: the TS bootstrap and the relays
  // MUST agree that `WAYKEEP_DIR=""` is unset and falls through to the legacy
  // name. If they disagree, the daemon and its relays bind different sockets
  // and a legacy privacy config is silently ignored.
  it('an EMPTY current DIR override inherits the legacy DIR, matching the relays', () => {
    const r = JSON.parse(probe(ROOT_PROBE, { WAYKEEP_DIR: '', CAIRN_DIR: '/x/legacy-dir' }));
    assert.equal(r.dataDir, '/x/legacy-dir',
      'empty WAYKEEP_DIR must fall through to CAIRN_DIR, not to the state root');
  });

  it('an EMPTY current CONFIG_PATH inherits the legacy CONFIG_PATH (privacy config not lost)', () => {
    const r = JSON.parse(probe(ROOT_PROBE, {
      WAYKEEP_CONFIG_PATH: '', CAIRN_CONFIG_PATH: '/y/legacy-config.json',
    }));
    assert.equal(r.config, '/y/legacy-config.json',
      'empty WAYKEEP_CONFIG_PATH must honor the legacy privacy config, not silently default');
  });

  // codex B1 review — legacy compat must follow a legacy STORE env override,
  // not only a ~/.cairn home DB. A user with CAIRN_DB_PATH=/mnt/x.db and no
  // home store is un-migrated; their prompts still call cairn_* / cairn://.
  const COMPAT_PROBE = `
    const { legacyCompatActive } = await import('${process.cwd()}/dist/src/constants/paths.js');
    console.log(legacyCompatActive());
  `;

  it('legacyCompatActive is true under a legacy DB-path override with no home store', () => {
    assert.equal(probe(COMPAT_PROBE, { CAIRN_DB_PATH: '/mnt/nonexistent-memory.db' }), 'true');
  });

  it('legacyCompatActive is false on a plain fresh install (no legacy store, no legacy env)', () => {
    assert.equal(probe(COMPAT_PROBE), 'false');
  });

  it('a stray legacy STORE env does NOT resurrect compat once migrated (marker wins)', () => {
    mkdirSync(join(home, DATA_DIR_NAME), { recursive: true });
    writeFileSync(join(home, DATA_DIR_NAME, `waykeep-migrated.json`), '{}');
    assert.equal(probe(COMPAT_PROBE, { CAIRN_DB_PATH: '/mnt/x.db' }), 'false');
  });

  it('an unrelated legacy env (TZ) does NOT trigger compat — only store/config overrides do', () => {
    assert.equal(probe(COMPAT_PROBE, { CAIRN_TZ: 'UTC' }), 'false');
  });
});

describe('legacy tool aliases (Phase B window)', () => {
  it('an UN-MIGRATED root serves cairn_* aliases; a migrated root does not', async () => {
    const { resetStateRootForTests } = await import('../src/constants/paths.js');
    const { openDatabase } = await import('../src/db/connection.js');
    const { MemoryRepository } = await import('../src/db/memory-repository.js');
    const { registerMemoryTools } = await import('../src/mcp/tools/memory-tools.js');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

    const savedHome = process.env.HOME;
    const listNames = async (): Promise<string[]> => {
      const db = openDatabase({ dbPath: ':memory:' });
      try {
        const server = new McpServer({ name: 'alias-test', version: '0.0.0' });
        registerMemoryTools(server, new MemoryRepository(db), () => 'normal');
        const client = new Client({ name: 'alias-client', version: '0.0.0' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);
        const tools = await client.listTools();
        await client.close();
        return tools.tools.map(t => t.name);
      } finally {
        db.close();
      }
    };

    try {
      // Legacy root: ~/.cairn with a db, no current dir.
      process.env.HOME = home;
      mkdirSync(join(home, '.cairn'), { recursive: true });
      writeFileSync(join(home, '.cairn', 'cairn.db'), '');
      resetStateRootForTests();
      const legacyNames = await listNames();
      assert.ok(legacyNames.includes('waykeep_recall'), 'current names always served');
      assert.ok(legacyNames.includes('cairn_recall'),
        'the un-migrated window must keep old prompts/rules working');
      const alias = await (async () => {
        const db = openDatabase({ dbPath: ':memory:' });
        try {
          const server = new McpServer({ name: 'alias-test2', version: '0.0.0' });
          registerMemoryTools(server, new MemoryRepository(db), () => 'normal');
          const client = new Client({ name: 'alias-client2', version: '0.0.0' });
          const [ct, st] = InMemoryTransport.createLinkedPair();
          await Promise.all([client.connect(ct), server.connect(st)]);
          const res = await client.callTool({ name: 'cairn_learn', arguments: { kind: 'fact', content: 'alias probe row content here', project: 'alias-proj' } }) as { isError?: boolean };
          await client.close();
          return res.isError !== true;
        } finally { db.close(); }
      })();
      assert.ok(alias, 'the alias must actually delegate, not just exist');

      // Migrated root: marker present → aliases vanish automatically.
      mkdirSync(join(home, DATA_DIR_NAME), { recursive: true });
      writeFileSync(join(home, DATA_DIR_NAME, 'waykeep-migrated.json'), '{}');
      resetStateRootForTests();
      const migratedNames = await listNames();
      assert.ok(migratedNames.includes('waykeep_recall'));
      assert.ok(!migratedNames.includes('cairn_recall'),
        'aliases cost tokens only while needed — gone after migration');
    } finally {
      process.env.HOME = savedHome;
      resetStateRootForTests();
    }
  });

  it('an UN-MIGRATED root serves cairn:// resource aliases; a migrated root does not', async () => {
    // codex B1 review: tool-name compat is not enough — existing consumers of
    // cairn://plan/… and cairn://briefing/… must not get "resource not found".
    const { resetStateRootForTests } = await import('../src/constants/paths.js');
    const { openDatabase } = await import('../src/db/connection.js');
    const { MemoryRepository } = await import('../src/db/memory-repository.js');
    const { PlanRepository } = await import('../src/db/plan-repository.js');
    const { registerResources } = await import('../src/mcp/resources.js');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

    const savedHome = process.env.HOME;
    const listUriTemplates = async (): Promise<string[]> => {
      const db = openDatabase({ dbPath: ':memory:' });
      try {
        const server = new McpServer({ name: 'res-test', version: '0.0.0' });
        registerResources(server, new PlanRepository(db), new MemoryRepository(db), () => 'normal');
        const client = new Client({ name: 'res-client', version: '0.0.0' });
        const [ct, st] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(ct), server.connect(st)]);
        const res = await client.listResourceTemplates();
        await client.close();
        return res.resourceTemplates.map(t => t.uriTemplate);
      } finally {
        db.close();
      }
    };

    try {
      process.env.HOME = home;
      mkdirSync(join(home, '.cairn'), { recursive: true });
      writeFileSync(join(home, '.cairn', 'cairn.db'), '');
      resetStateRootForTests();
      const legacy = await listUriTemplates();
      assert.ok(legacy.some(u => u.startsWith('waykeep://')), 'current URIs always served');
      assert.ok(legacy.some(u => u.startsWith('cairn://')),
        'the un-migrated window must keep cairn:// consumers working');

      mkdirSync(join(home, DATA_DIR_NAME), { recursive: true });
      writeFileSync(join(home, DATA_DIR_NAME, 'waykeep-migrated.json'), '{}');
      resetStateRootForTests();
      const migrated = await listUriTemplates();
      assert.ok(migrated.some(u => u.startsWith('waykeep://')));
      assert.ok(!migrated.some(u => u.startsWith('cairn://')),
        'resource aliases retire after migration, like the tool aliases');
    } finally {
      process.env.HOME = savedHome;
      resetStateRootForTests();
    }
  });
});
