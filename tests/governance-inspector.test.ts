import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection.js';
import { inspectGates } from '../src/governance/inspector.js';
import { projectId } from '../src/utils/project-id.js';
import { ENV } from '../src/constants/env.js';
import { DATA_DIR_NAME } from 'waykeep-contract';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const INSPECTOR = join(REPO_ROOT, 'scripts', 'inspect-gates.mjs');
let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDirectory(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `cairn-inspector-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function writeConfig(root: string, input: unknown): void {
  mkdirSync(join(root, DATA_DIR_NAME), { recursive: true });
  writeFileSync(join(root, DATA_DIR_NAME, 'gates.json'), `${JSON.stringify(input, null, 2)}\n`);
}

function validConfig(argv: string[] = ['npm', 'test']): unknown {
  return {
    version: 1,
    defaults: {
      level: 'block', evaluationTimeoutMs: 250,
      retention: { evidenceDays: 14, auditDays: 90, ruleDays: 120 },
    },
    gates: {
      test: {
        argv, cwd: '.', parser: 'node-test', timeoutMs: 60_000,
        skips: { max: 3, requireReasons: true }, aliases: [], envNames: ['API_TOKEN'],
      },
    },
    pathRules: [{ paths: ['**'], require: ['test'] }],
  };
}

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function treeFingerprint(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(directory: string, prefix: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const key = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        const stats = statSync(path);
        result[`${key}/`] = `directory:${stats.mode}:${stats.mtimeMs}`;
        visit(path, key);
      } else if (entry.isFile()) {
        const stats = statSync(path);
        result[key] = `${stats.size}:${stats.mode}:${stats.mtimeMs}:${sha256(readFileSync(path))}`;
      } else {
        result[key] = `other:${entry.isSymbolicLink()}`;
      }
    }
  }
  visit(root, '');
  return result;
}

function runInspector(args: string[], environment: NodeJS.ProcessEnv = process.env) {
  const childEnvironment = { ...environment };
  delete childEnvironment.NODE_TEST_CONTEXT;
  return spawnSync(process.execPath, [INSPECTOR, ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', env: childEnvironment,
  });
}

function runInspectorAsync(args: string[], environment: NodeJS.ProcessEnv): Promise<{
  status: number | null; stdout: string; stderr: string;
}> {
  return new Promise((resolveResult, reject) => {
    const childEnvironment = { ...environment };
    delete childEnvironment.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [INSPECTOR, ...args], {
      cwd: REPO_ROOT, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', status => resolveResult({ status, stdout, stderr }));
  });
}

describe('read-only governance gate inspector', () => {
  it('expands all matching path rules in declaration order with a stable union', () => {
    const project = tempDirectory('paths');
    const gate = (argv: string[]) => ({
      argv, cwd: '.', parser: 'exit-only', timeoutMs: 1_000,
      skips: { max: 0, requireReasons: false }, aliases: [], envNames: [],
    });
    writeConfig(project, {
      version: 1,
      defaults: { level: 'advise', evaluationTimeoutMs: 250, retention: { evidenceDays: 30 } },
      gates: { core: gate(['core']), types: gate(['types']), catchall: gate(['catchall']) },
      pathRules: [
        { paths: ['src/**'], require: ['core'] },
        { paths: ['**/*.ts'], require: ['types', 'core'] },
        { paths: ['**'], require: ['catchall'] },
      ],
    });
    const report = inspectGates({
      projectRoot: project, paths: ['src/nested/file.ts', 'README.md'], dbPath: null,
    });
    assert.deepEqual(report.paths, [
      { path: 'src/nested/file.ts', requiredGates: ['core', 'types', 'catchall'] },
      { path: 'README.md', requiredGates: ['catchall'] },
    ]);
  });

  it('reports redacted diagnostics without command, file, DB, settings, or network writes', async () => {
    const base = tempDirectory('dry-run');
    const project = join(base, 'project');
    const home = join(base, 'home');
    const settings = join(home, '.claude', 'settings.json');
    const marker = join(base, 'command-executed');
    const apiMarker = join(base, 'forbidden-api-used');
    const preload = join(base, 'side-effect-trap.cjs');
    const dbPath = join(base, 'capabilities.db');
    mkdirSync(project);
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, '{"sentinel":"settings-unchanged"}\n');
    writeFileSync(join(project, 'source.ts'), 'export const unchanged = true;\n');

    const trapUrl = 'http://127.0.0.1:9/command-trap';
    const rawPackageCommand = `node -e "require('fs').writeFileSync('${marker}','ran')" && curl ${trapUrl}`;
    writeFileSync(join(project, 'package.json'), JSON.stringify({ scripts: { trap: rawPackageCommand } }));
    writeFileSync(preload, `
const fs = require('node:fs');
const trip = name => { fs.writeFileSync(${JSON.stringify(apiMarker)}, name); throw new Error('forbidden side-effect API: ' + name); };
const patch = (module, names) => { for (const name of names) module[name] = () => trip(name); };
patch(require('node:child_process'), ['exec', 'execFile', 'execFileSync', 'execSync', 'fork', 'spawn', 'spawnSync']);
patch(require('node:http'), ['get', 'request']);
patch(require('node:https'), ['get', 'request']);
patch(require('node:net'), ['connect', 'createConnection']);
patch(require('node:dgram'), ['createSocket']);
patch(require('node:dns'), ['lookup', 'resolve', 'resolve4', 'resolve6']);
globalThis.fetch = () => trip('fetch');
`);
    writeConfig(project, validConfig([
      'node', '--token', 'super-secret-value', 'API_KEY=config-secret-value',
      'https://user:password@example.invalid/repository',
    ]));

    const db = openDatabase({ dbPath });
    db.prepare(`
      INSERT INTO governance_client_state (
        project, client_installation_id, client_name, client_version,
        supports_post_tool_use, supports_post_tool_failure, supports_file_changed,
        supports_structured_output, supports_stop, supports_blocking,
        adapter_version, settings_source, last_heartbeat_at, last_probe_result
      ) VALUES (?, 'installation-secret', 'claude-code', '1.2.3', 1, 1, 1, 1, 1, 1,
                1, '/private/settings/path', '2026-08-26T12:00:00.000Z', 'hook-observation')
    `).run(projectId(resolve(project)));
    db.close();

    const before = treeFingerprint(base);
    const beforeDb = statSync(dbPath);
    const childEnvironment = {
      ...process.env,
      HOME: home,
      [ENV.DIR]: join(home, DATA_DIR_NAME),
      CLAUDE_CONFIG_DIR: join(home, '.claude'),
      API_TOKEN: 'environment-secret-value',
      HTTP_PROXY: trapUrl,
      HTTPS_PROXY: trapUrl,
      NODE_OPTIONS: `--require=${preload}`,
      [ENV.INSPECTOR_TEST]: '1',
    };
    const result = await runInspectorAsync([
      '--project', project, '--paths', 'source.ts', '--db', dbPath, '--json',
    ], childEnvironment);
    const textResult = await runInspectorAsync([
      '--project', project, '--paths', 'source.ts', '--no-db',
    ], childEnvironment);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(textResult.status, 0, textResult.stderr);
    assert.match(textResult.stdout, /diagnostic only — Slice A does not enforce/);
    assert.match(textResult.stdout, /block unavailable: FileChanged is unsupported/);
    const report = JSON.parse(result.stdout) as {
      mode: string;
      enforcement: { block: { available: boolean } };
      paths: Array<{ requiredGates: string[] }>;
      capabilities: { source: string; records: Array<{ installationSha256: string }> };
      packageScriptProposals: Array<{ command: string; sha256: string }>;
    };
    assert.equal(report.mode, 'diagnostic only — Slice A does not enforce');
    assert.equal(report.enforcement.block.available, true);
    assert.deepEqual(report.paths[0]?.requiredGates, ['test']);
    assert.equal(report.capabilities.source, 'database');
    assert.equal(report.capabilities.records[0]?.installationSha256, sha256('installation-secret'));
    assert.equal(report.packageScriptProposals[0]?.command, '[redacted command; proposal only, never executed]');
    assert.equal(report.packageScriptProposals[0]?.sha256, sha256(rawPackageCommand));

    for (const secret of [
      'super-secret-value', 'config-secret-value', 'environment-secret-value',
      'user:password', 'installation-secret', '/private/settings/path', rawPackageCommand,
    ]) {
      assert.equal(result.stdout.includes(secret), false, `leaked ${secret}`);
      assert.equal(result.stderr.includes(secret), false, `leaked ${secret}`);
      assert.equal(textResult.stdout.includes(secret), false, `text leaked ${secret}`);
      assert.equal(textResult.stderr.includes(secret), false, `text leaked ${secret}`);
    }
    assert.equal(existsSync(marker), false, 'package script was executed');
    assert.equal(existsSync(apiMarker), false, 'inspector called an execution/network API');
    assert.deepEqual(treeFingerprint(base), before, 'inspector changed project/DB/settings files');
    const afterDb = statSync(dbPath);
    assert.equal(afterDb.size, beforeDb.size);
    assert.equal(afterDb.mtimeMs, beforeDb.mtimeMs);
  });

  it('uses exit 0/2/1 and refuses the live default store under the test barrier', () => {
    const base = tempDirectory('exits');
    const valid = join(base, 'valid');
    const invalid = join(base, 'invalid');
    const home = join(base, 'home');
    mkdirSync(valid);
    mkdirSync(invalid);
    mkdirSync(home);
    writeConfig(valid, validConfig());
    writeConfig(invalid, { version: 99, gates: {}, pathRules: [] });

    const ok = runInspector(['--project', valid, '--no-db', '--json']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.doesNotThrow(() => JSON.parse(ok.stdout));

    const validation = runInspector(['--project', invalid, '--no-db']);
    assert.equal(validation.status, 2);
    assert.match(validation.stderr, /Gate configuration invalid/);
    assert.doesNotMatch(validation.stderr, /\n\s+at /);

    const pathEscape = runInspector(['--project', valid, '--paths', '../escape', '--no-db']);
    assert.equal(pathEscape.status, 2);
    assert.match(pathEscape.stderr, /escapes project root/);

    const selfError = runInspector(['--project', valid, '--db', join(base, 'missing.db')]);
    assert.equal(selfError.status, 1);
    assert.match(selfError.stderr, /explicit capability database does not exist/);
    assert.doesNotMatch(selfError.stderr, /\n\s+at /);

    const safety = runInspector(['--project', valid], {
      ...process.env, HOME: home, [ENV.INSPECTOR_TEST]: '1',
    });
    assert.equal(safety.status, 1);
    assert.match(safety.stderr, /live default store refused/);
    assert.equal(existsSync(join(home, DATA_DIR_NAME, 'cairn.db')), false);
  });

  it('keeps the inspector implementation free of execution, network, and write APIs', () => {
    const sources = [
      readFileSync(join(REPO_ROOT, 'src', 'governance', 'inspector.ts'), 'utf8'),
      readFileSync(INSPECTOR, 'utf8'),
    ].join('\n');
    assert.doesNotMatch(sources, /node:(?:child_process|http|https|net)/u);
    assert.doesNotMatch(sources, /\b(?:fetch|exec|execFile|spawn|fork)\s*\(/u);
    assert.doesNotMatch(sources, /\b(?:writeFile|appendFile|truncate|rename|unlink|mkdir|rmdir|rm)Sync?\s*\(/u);
    assert.doesNotMatch(sources, /\.(?:run|exec)\s*\(/u);
    assert.doesNotMatch(sources, /openDatabase\s*\(/u);
  });
});
