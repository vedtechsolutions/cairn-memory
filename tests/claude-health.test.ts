/**
 * `waykeep doctor`'s `claude mcp` check — the one that would have caught
 * the inert settings.json block a pre-fix `waykeep init` wrote while
 * reporting success. Hermetic: both files live in a temp dir via ENV.
 */
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NAMESPACE } from 'waykeep-contract';

import { ENV } from '../src/constants/env.js';
import { MCP_SERVER_NAME } from '../src/constants/mcp.js';
import { claudeMcpHealth } from '../src/cli/claude-health.js';
import { waykeepMcpServerEntry } from '../src/cli/mcp-entry.js';

const SERVER = '/install/dist/src/mcp/server.js';
const OTHER = '/elsewhere/dist/src/mcp/server.js';

let dir: string;
let registry: string;
let settings: string;
const saved = { config: process.env[ENV.CLAUDE_CONFIG], settings: process.env[ENV.CLAUDE_SETTINGS] };
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cairn-claude-health-'));
  registry = join(dir, 'claude.json');
  settings = join(dir, 'settings.json');
  process.env[ENV.CLAUDE_CONFIG] = registry;
  process.env[ENV.CLAUDE_SETTINGS] = settings;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved.config === undefined) delete process.env[ENV.CLAUDE_CONFIG]; else process.env[ENV.CLAUDE_CONFIG] = saved.config;
  if (saved.settings === undefined) delete process.env[ENV.CLAUDE_SETTINGS]; else process.env[ENV.CLAUDE_SETTINGS] = saved.settings;
});
const seed = (servers: Record<string, unknown> | null, settingsBody: Record<string, unknown> | null): void => {
  if (servers !== null) writeFileSync(registry, JSON.stringify({ mcpServers: servers }));
  if (settingsBody !== null) writeFileSync(settings, JSON.stringify(settingsBody));
};

describe('claude mcp doctor check', () => {
  it('is ok when Claude Code is not detected (neither file exists)', () => {
    assert.equal(claudeMcpHealth(SERVER).status, 'ok');
    assert.match(claudeMcpHealth(SERVER).detail, /not detected/u);
  });

  it('is ok when our exact entry is registered at user scope', () => {
    seed({ [MCP_SERVER_NAME]: waykeepMcpServerEntry(SERVER) }, {});
    const h = claudeMcpHealth(SERVER);
    assert.equal(h.status, 'ok', h.detail);
    assert.match(h.detail, /registered with Claude Code at user scope/u);
  });

  it('warns when nothing is registered and the plugin is not enabled — the pre-fix shape', () => {
    // Exactly what a pre-fix init produced: hooks in settings.json, an inert
    // mcpServers block beside them, nothing in ~/.claude.json.
    seed(null, { hooks: {}, mcpServers: { [MCP_SERVER_NAME]: { command: 'node', args: [SERVER] } } });
    const h = claudeMcpHealth(SERVER);
    assert.equal(h.status, 'warn');
    assert.match(h.detail, /NOT registered/u);
    assert.match(h.detail, /inert mcpServers/u, 'and names the inert block');
    assert.match(h.detail, /waykeep init/u);
  });

  it('is ok when the plugin provides the server (enabled in settings, no user-scope entry)', () => {
    seed({}, { enabledPlugins: { [`${NAMESPACE}@${NAMESPACE}`]: true, 'other@market': true } });
    const h = claudeMcpHealth(SERVER);
    assert.equal(h.status, 'ok', h.detail);
    assert.match(h.detail, /plugin-managed/u);
    // A DISABLED plugin provides nothing.
    seed({}, { enabledPlugins: { [`${NAMESPACE}@${NAMESPACE}`]: false } });
    assert.equal(claudeMcpHealth(SERVER).status, 'warn');
  });

  it('warns when the user-scope entry runs a different install, or is not a Waykeep server at all', () => {
    seed({ [MCP_SERVER_NAME]: { command: 'node', args: [OTHER] } }, {});
    let h = claudeMcpHealth(SERVER);
    assert.equal(h.status, 'warn');
    assert.match(h.detail, /DIFFERENT install/u);
    seed({ [MCP_SERVER_NAME]: { command: 'something-else' } }, {});
    h = claudeMcpHealth(SERVER);
    assert.equal(h.status, 'warn');
    assert.match(h.detail, /not a Waykeep server/u);
  });

  it('downgrades a registered install to warn while an inert block lingers in settings.json', () => {
    seed({ [MCP_SERVER_NAME]: waykeepMcpServerEntry(SERVER) }, { mcpServers: { [MCP_SERVER_NAME]: { command: 'node', args: [OTHER] } } });
    const h = claudeMcpHealth(SERVER);
    assert.equal(h.status, 'warn');
    assert.match(h.detail, /registered .* inert mcpServers/u);
  });

  it('warns — never crashes — on a corrupt registry', () => {
    writeFileSync(registry, '{nope');
    const h = claudeMcpHealth(SERVER);
    assert.equal(h.status, 'warn');
    assert.match(h.detail, /could not be read/u);
  });
});
