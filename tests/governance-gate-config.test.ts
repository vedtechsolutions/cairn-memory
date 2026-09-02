import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DATA_DIR_NAME } from 'waykeep-contract';
import {
  canonicalGateConfigJson, GateConfigError, loadGateConfig, parseGateConfig,
} from '../src/governance/gate-config.js';
import {
  GATE_CONFIG_LIMITS, generateGateConfigJsonSchema,
} from '../src/governance/gates-schema.js';

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempProject(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `cairn-gates-${label}-`));
  tempDirs.push(root);
  mkdirSync(join(root, DATA_DIR_NAME));
  return root;
}

function baseConfig(): Record<string, unknown> {
  return {
    version: 1,
    defaults: {
      level: 'advise', evaluationTimeoutMs: 250,
      retention: { evidenceDays: 30 },
    },
    gates: {
      'test-core': {
        argv: ['npm', 'test'], cwd: '.', parser: 'node-test', timeoutMs: 900_000,
        skips: { max: 3, requireReasons: true },
      },
      build: {
        argv: ['npm', 'run', 'build'], cwd: '.', parser: 'exit-only', timeoutMs: 300_000,
      },
    },
    pathRules: [
      { paths: ['src/**', 'tests/**'], require: ['test-core', 'build'] },
      { paths: ['**'], require: ['test-core'] },
    ],
  };
}

function writeConfig(root: string, value: unknown): string {
  const path = join(root, DATA_DIR_NAME, 'gates.json');
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value), 'utf8');
  return path;
}

function errorCode(action: () => unknown): string | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    assert.ok(error instanceof GateConfigError);
    return error.code;
  }
}

describe('governance gate config v1', () => {
  it('loads the sole canonical project config and applies bounded defaults', () => {
    const root = tempProject('defaults');
    const config = baseConfig();
    delete config.defaults;
    const gates = config.gates as Record<string, Record<string, unknown>>;
    delete gates.build;
    delete gates['test-core'].cwd;
    delete gates['test-core'].skips;
    config.pathRules = [{ paths: ['**'], require: ['test-core'] }];
    writeConfig(root, config);

    const loaded = loadGateConfig(root);
    assert.equal(loaded.projectRoot, root);
    assert.equal(loaded.configPath, join(root, DATA_DIR_NAME, 'gates.json'));
    assert.deepEqual(loaded.config.defaults, {
      level: 'advise', evaluationTimeoutMs: 250, retention: { evidenceDays: 30 },
    });
    assert.deepEqual(loaded.config.gates['test-core'].skips, { max: 0, requireReasons: false });
    assert.equal(loaded.config.gates['test-core'].cwd, '.');
    assert.equal(loaded.enforcement.effective, 'diagnostic');
  });

  it('keeps warn and block as intent while Slice A stays diagnostic', () => {
    const warned = baseConfig();
    (warned.defaults as Record<string, unknown>).level = 'warn';
    assert.deepEqual(parseGateConfig(warned).defaults.level, 'warn');

    const root = tempProject('block-intent');
    const blocked = baseConfig();
    (blocked.defaults as Record<string, unknown>).level = 'block';
    writeConfig(root, blocked);
    const loaded = loadGateConfig(root, {
      fileChanged: { supported: true, observed: true },
    });
    assert.equal(loaded.enforcement.intent, 'block');
    assert.equal(loaded.enforcement.effective, 'diagnostic');
    assert.deepEqual(loaded.enforcement.block, { available: true, reason: null });
  });

  it('requires an explicit catch-all whenever block intent is named', () => {
    const config = baseConfig();
    (config.defaults as Record<string, unknown>).level = 'block';
    config.pathRules = [{ paths: ['src/**'], require: ['test-core'] }];
    assert.equal(errorCode(() => parseGateConfig(config)), 'invalid-config');
  });

  it('reports missing FileChanged support or observation as block unavailable', () => {
    const root = tempProject('filechanged');
    writeConfig(root, baseConfig());
    assert.match(loadGateConfig(root).enforcement.block.reason ?? '', /block unavailable.*unsupported/);
    assert.match(loadGateConfig(root, {
      fileChanged: { supported: true, observed: false },
    }).enforcement.block.reason ?? '', /block unavailable.*not been observed/);
  });

  it('rejects unknown keys at every object boundary', () => {
    const top = { ...baseConfig(), surprise: true };
    assert.equal(errorCode(() => parseGateConfig(top)), 'invalid-config');
    const nested = baseConfig();
    const gates = nested.gates as Record<string, Record<string, unknown>>;
    gates.build.extra = 'no';
    assert.equal(errorCode(() => parseGateConfig(nested)), 'invalid-config');
  });

  it('rejects missing gate refs and duplicate refs, env names, globs, and aliases', () => {
    const missing = baseConfig();
    missing.pathRules = [{ paths: ['**'], require: ['not-a-gate'] }];
    assert.equal(errorCode(() => parseGateConfig(missing)), 'invalid-config');

    const duplicate = baseConfig();
    duplicate.pathRules = [{ paths: ['src/**', './src/**'], require: ['build', 'build'] }];
    assert.equal(errorCode(() => parseGateConfig(duplicate)), 'invalid-config');

    const command = baseConfig();
    const build = (command.gates as Record<string, Record<string, unknown>>).build;
    build.envNames = ['CI', 'CI'];
    build.aliases = [
      { argv: ['npm', 'run', 'build'], cwd: './' },
      { argv: ['npm', 'run', 'compile'], cwd: 'tools/../tools' },
    ];
    assert.equal(errorCode(() => parseGateConfig(command)), 'invalid-config');

    const unstableId = baseConfig();
    unstableId.gates = { Build: { argv: ['x'], parser: 'exit-only', timeoutMs: 1 } };
    unstableId.pathRules = [{ paths: ['**'], require: [] }];
    assert.equal(errorCode(() => parseGateConfig(unstableId)), 'invalid-config');
  });

  it('rejects traversal, NULs, and absolute child paths before filesystem use', () => {
    for (const hostile of ['../outside', 'src/../../outside', '/tmp/outside', 'C:\\outside', 'bad\0cwd']) {
      const config = baseConfig();
      (config.gates as Record<string, Record<string, unknown>>).build.cwd = hostile;
      assert.equal(errorCode(() => parseGateConfig(config)), 'invalid-config', hostile);
    }
    for (const hostile of ['../**', '/absolute/**', 'bad\0glob']) {
      const config = baseConfig();
      config.pathRules = [{ paths: [hostile], require: ['build'] }];
      assert.equal(errorCode(() => parseGateConfig(config)), 'invalid-config', hostile);
    }
  });

  it('rejects symlink escapes for both the config file and command cwd', () => {
    const outside = tempProject('outside');
    const escapedConfig = join(outside, 'external-gates.json');
    writeFileSync(escapedConfig, JSON.stringify(baseConfig()));

    const configRoot = tempProject('config-symlink');
    symlinkSync(escapedConfig, join(configRoot, DATA_DIR_NAME, 'gates.json'));
    assert.equal(errorCode(() => loadGateConfig(configRoot)), 'path-escape');

    const cwdRoot = tempProject('cwd-symlink');
    symlinkSync(outside, join(cwdRoot, 'escaped'));
    const cwdConfig = baseConfig();
    (cwdConfig.gates as Record<string, Record<string, unknown>>).build.cwd = 'escaped';
    writeConfig(cwdRoot, cwdConfig);
    assert.equal(errorCode(() => loadGateConfig(cwdRoot)), 'path-escape');
  });

  it('rejects traversal and alternate locations for the config path', () => {
    const root = tempProject('config-path');
    writeConfig(root, baseConfig());
    assert.equal(errorCode(() => loadGateConfig(root, { configPath: '../gates.json' })), 'invalid-config-path');
    assert.equal(errorCode(() => loadGateConfig(root, {
      configPath: `${DATA_DIR_NAME}/../${DATA_DIR_NAME}/gates.json`,
    })), 'invalid-config-path');
    assert.equal(errorCode(() => loadGateConfig(root, { configPath: 'gates.json' })), 'invalid-config-path');
    // The legacy location is rejected while ABSENT (an alternate path)…
    assert.equal(errorCode(() => loadGateConfig(root, { configPath: '.cairn/gates.json' })), 'invalid-config-path');
    assert.doesNotThrow(() => loadGateConfig(root, { configPath: `${DATA_DIR_NAME}/gates.json` }));
    assert.doesNotThrow(() => loadGateConfig(root, {
      configPath: join(root, DATA_DIR_NAME, 'gates.json'),
    }));
  });

  it('honors a LEGACY .cairn/gates.json when the current path is absent (Phase-B fallback)', () => {
    const root = tempProject('legacy-fallback');
    rmSync(join(root, DATA_DIR_NAME), { recursive: true, force: true });
    mkdirSync(join(root, '.cairn'), { recursive: true });
    writeFileSync(join(root, '.cairn', 'gates.json'), JSON.stringify(baseConfig()));
    assert.doesNotThrow(() => loadGateConfig(root),
      'a repo configured before the flip must not silently lose governance');
    assert.doesNotThrow(() => loadGateConfig(root, { configPath: '.cairn/gates.json' }),
      'the existing legacy path may also be requested explicitly');
  });

  it('rejects duplicate JSON keys before the native parser can discard them', () => {
    const root = tempProject('duplicate-keys');
    writeConfig(root, '{"version":1,"version":1,"gates":{},"pathRules":[]}');
    assert.equal(errorCode(() => loadGateConfig(root)), 'duplicate-json-key');

    writeConfig(root, '{"version":1,"gates":{"build":{"argv":["x"],"argv":["y"]}},"pathRules":[]}');
    assert.equal(errorCode(() => loadGateConfig(root)), 'duplicate-json-key');
  });

  it('enforces config, collection, string, retention, and timeout ceilings', () => {
    const tooManyGates = baseConfig();
    tooManyGates.gates = Object.fromEntries(Array.from(
      { length: GATE_CONFIG_LIMITS.gates + 1 },
      (_, index) => [`g${index}`, { argv: ['x'], parser: 'exit-only', timeoutMs: 1 }],
    ));
    assert.equal(errorCode(() => parseGateConfig(tooManyGates)), 'invalid-config');

    const bounds = baseConfig();
    const build = (bounds.gates as Record<string, Record<string, unknown>>).build;
    build.timeoutMs = GATE_CONFIG_LIMITS.commandTimeoutMs + 1;
    (bounds.defaults as Record<string, unknown>).evaluationTimeoutMs = GATE_CONFIG_LIMITS.evaluationTimeoutMs + 1;
    assert.equal(errorCode(() => parseGateConfig(bounds)), 'invalid-config');

    const retention = baseConfig();
    (retention.defaults as Record<string, unknown>).retention = {
      evidenceDays: 30, auditDays: GATE_CONFIG_LIMITS.retentionDays + 1,
    };
    assert.equal(errorCode(() => parseGateConfig(retention)), 'invalid-config');

    const collectionCases: Array<[string, unknown]> = [
      ['argv items', Array(GATE_CONFIG_LIMITS.argvItems + 1).fill('x')],
      ['argv length', ['x'.repeat(GATE_CONFIG_LIMITS.argvItemChars + 1)]],
      ['aliases', Array(GATE_CONFIG_LIMITS.aliasesPerGate + 1).fill({ argv: ['x'] })],
      ['env names', Array.from({ length: GATE_CONFIG_LIMITS.envNames + 1 }, (_, index) => `E${index}`)],
    ];
    for (const [field, value] of collectionCases) {
      const config = baseConfig();
      const boundedGate = (config.gates as Record<string, Record<string, unknown>>).build;
      boundedGate[field.startsWith('argv') ? 'argv' : field === 'env names' ? 'envNames' : field] = value;
      assert.equal(errorCode(() => parseGateConfig(config)), 'invalid-config', field);
    }

    const tooManyRules = baseConfig();
    tooManyRules.pathRules = Array(GATE_CONFIG_LIMITS.pathRules + 1)
      .fill({ paths: ['src/**'], require: [] });
    assert.equal(errorCode(() => parseGateConfig(tooManyRules)), 'invalid-config');

    const tooManyGlobs = baseConfig();
    tooManyGlobs.pathRules = [{
      paths: Array.from({ length: GATE_CONFIG_LIMITS.globsPerRule + 1 }, (_, index) => `p${index}/**`),
      require: [],
    }];
    assert.equal(errorCode(() => parseGateConfig(tooManyGlobs)), 'invalid-config');

    const root = tempProject('too-large');
    writeConfig(root, `${JSON.stringify(baseConfig())}${' '.repeat(GATE_CONFIG_LIMITS.configBytes)}`);
    assert.equal(errorCode(() => loadGateConfig(root)), 'config-too-large');
  });

  it('normalizes deterministically and hashes canonical normalized JSON', () => {
    const first = baseConfig();
    const gates = first.gates as Record<string, Record<string, unknown>>;
    gates.build.cwd = './tools//.';
    gates.build.envNames = ['NODE_ENV', 'CI'];
    gates.build.aliases = [
      { argv: ['pnpm', 'build'], cwd: './tools' },
      { argv: ['npm', 'run', 'compile'], cwd: 'tools/' },
    ];
    first.pathRules = [{ paths: ['tests/**', './src/**'], require: ['test-core', 'build'] }];

    const second = JSON.parse(JSON.stringify(first)) as Record<string, unknown>;
    second.gates = {
      'test-core': (second.gates as Record<string, unknown>)['test-core'],
      build: (second.gates as Record<string, unknown>).build,
    };
    const secondBuild = (second.gates as Record<string, Record<string, unknown>>).build;
    secondBuild.envNames = ['CI', 'NODE_ENV'];
    secondBuild.aliases = [...(secondBuild.aliases as unknown[])].reverse();
    second.pathRules = [{ paths: ['./src/**', 'tests/**'], require: ['build', 'test-core'] }];

    const normalized = parseGateConfig(first);
    const equivalent = parseGateConfig(second);
    assert.deepEqual(equivalent, normalized);
    assert.equal(normalized.gates.build.cwd, 'tools');
    const canonical = canonicalGateConfigJson(normalized);
    assert.equal(
      createHash('sha256').update(canonical).digest('hex'),
      createHash('sha256').update(canonicalGateConfigJson(equivalent)).digest('hex'),
    );

    const root = tempProject('canonical-hash');
    writeConfig(root, first);
    const loaded = loadGateConfig(root);
    assert.equal(loaded.canonicalJson, canonical);
    assert.equal(loaded.sha256, createHash('sha256').update(canonical).digest('hex'));
  });

  it('never executes package scripts during discovery or validation', () => {
    const root = tempProject('no-exec');
    const marker = join(root, 'script-ran');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      scripts: { test: `node -e "require('fs').writeFileSync('${marker}','bad')"` },
    }));
    writeConfig(root, baseConfig());
    loadGateConfig(root);
    assert.equal(existsSync(marker), false);
  });

  it('keeps the generated JSON Schema byte-identical to the checked-in artifact', () => {
    const checkedIn = readFileSync(
      resolve(process.cwd(), 'schemas', 'waykeep-gates.schema.json'), 'utf8',
    );
    assert.equal(generateGateConfigJsonSchema(), checkedIn);
  });
});
