/**
 * A stand-in for the `claude` CLI, for tests of `waykeep init`'s MCP
 * registration. Implements the two subcommands init uses — `mcp add-json`
 * and `mcp remove` — against a JSON registry file with the real CLI's
 * semantics (verified against Claude Code 2.1.258): add-json REFUSES an
 * existing name (exit 1) rather than overwriting, removing an absent name
 * exits 1, `-s user` is accepted anywhere, and every invocation is appended
 * to a log for assertions. `fail` makes every call exit 1 and `failOn` only
 * the named subcommand, to exercise init's failure paths; `lie` reports
 * success (exit 0, the real message) WITHOUT writing — the real CLI did
 * exactly that against a registry it could not modify (validation). The bin is a `#!/bin/sh` wrapper so spawnSync finds it
 * without a shell and without depending on `node` being on PATH.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeClaudeCli {
  /** Path to pass as ENV.CLAUDE_BIN. */
  bin: string;
  /** The registry file — pass as ENV.CLAUDE_CONFIG. */
  registry: string;
  /** Every invocation's argv (after the binary), in order. */
  calls(): string[][];
  /** The registry's `mcpServers` map ({} when the file was never written). */
  servers(): Record<string, unknown>;
}

const SCRIPT = String.raw`
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
const [REGISTRY, LOG, FAIL] = process.argv.slice(2, 5);
const argv = process.argv.slice(5);
appendFileSync(LOG, JSON.stringify(argv) + '\n');
if (FAIL === '1' || FAIL === argv[1]) { process.stderr.write('simulated failure\n'); process.exit(1); }
const LIE = FAIL === 'lie';
const positional = [];
let scope = 'local';
for (let i = 2; i < argv.length; i++) {
  if (argv[i] === '-s' || argv[i] === '--scope') scope = argv[++i];
  else positional.push(argv[i]);
}
if (argv[0] !== 'mcp' || scope !== 'user') { process.stderr.write('fake claude: unsupported invocation\n'); process.exit(2); }
const cfg = existsSync(REGISTRY) ? JSON.parse(readFileSync(REGISTRY, 'utf-8')) : {};
cfg.mcpServers ??= {};
const save = () => writeFileSync(REGISTRY, JSON.stringify(cfg, null, 2) + '\n');
const [name, json] = positional;
if (argv[1] === 'add-json') {
  if (cfg.mcpServers[name]) { process.stdout.write('MCP server ' + name + ' already exists in user config\n'); process.exit(1); }
  cfg.mcpServers[name] = JSON.parse(json);
  if (!LIE) save();
  process.stdout.write('Added stdio MCP server ' + name + ' to user config\n');
  process.exit(0);
}
if (argv[1] === 'remove') {
  if (!cfg.mcpServers[name]) { process.stdout.write('No MCP server named "' + name + '" in user scope\n'); process.exit(1); }
  delete cfg.mcpServers[name];
  if (!LIE) save();
  process.stdout.write('Removed MCP server ' + name + ' from user config\n');
  process.exit(0);
}
process.stderr.write('fake claude: unsupported subcommand\n');
process.exit(2);
`;

export function installFakeClaudeCli(dir: string, options: { fail?: boolean; failOn?: 'add-json' | 'remove'; lie?: boolean } = {}): FakeClaudeCli {
  const registry = join(dir, 'claude.json');
  const log = join(dir, 'claude-calls.log');
  const script = join(dir, 'fake-claude.mjs');
  const bin = join(dir, 'claude');
  writeFileSync(script, SCRIPT);
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${script}" "${registry}" "${log}" "${options.fail ? '1' : options.lie ? 'lie' : (options.failOn ?? '0')}" "$@"\n`);
  chmodSync(bin, 0o755);
  return {
    bin,
    registry,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l) as string[]) : []),
    servers: () => (existsSync(registry)
      ? ((JSON.parse(readFileSync(registry, 'utf-8')) as { mcpServers?: Record<string, unknown> }).mcpServers ?? {})
      : {}),
  };
}
