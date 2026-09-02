/**
 * Namespace centralization guards (Phase A steps 1-3).
 *
 * Every machine-visible identifier Waykeep owns derives from the contract's
 * `NAMESPACE`, so completing the rename is a one-line change. That property
 * holds only while it is ENFORCED — one new inline env name silently
 * re-fragments what centralization just gathered.
 *
 * Modelled on contract-surface.test.ts, which guards the same class of drift.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ENV_PREFIX, DATA_DIR_NAME, DB_FILENAME, MCP_TOOL_PREFIX, MCP_URI_SCHEME,
  MCP_SERVER_NAME, NAMESPACE, RELAY_PROBE_FLAG, RELAY_PROBE_SENTINEL, CLIENT_HEADER,
  LEGACY_NAMESPACES,
} from 'waykeep-contract';
import { ENV } from '../src/constants/env.js';
import { listSourceFiles, stripComments, scanForInlineValues, scanForTokens } from '../src/utils/structural-scan.js';
import { TOOL, ALL_TOOL_NAMES, qualifiedToolName } from '../src/constants/mcp.js';

// Compiled tests run from dist/tests — the repo root is two levels up.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(REPO, 'src');
/** `src/constants/` is where these values are ALLOWED to be spelled. */
const CONSTANTS_DIR = join(SRC, 'constants');

// Step 8: the scanning primitives are SHARED and validated — the
// three-gate harness in structural-scanner-validation.test.ts proves they
// find known positives, cross-file spreads, and that defective variants
// fail. An audit rolled on private primitives is an unvalidated instrument.
const SCANNED = listSourceFiles(SRC).filter(f => !f.startsWith(CONSTANTS_DIR));

/**
 * Every value that CONTAINS the namespace, and so must never be written by
 * hand anywhere. An earlier version checked only env names and the data dir —
 * which is precisely why it missed the relay probe handshake being split
 * between the generator and its detectors (review finding).
 */
const NAMESPACED_VALUES = [
  DATA_DIR_NAME, DB_FILENAME, RELAY_PROBE_FLAG, RELAY_PROBE_SENTINEL,
  CLIENT_HEADER, `${NAMESPACE}-hook`, `${NAMESPACE}-state.json`,
  // Suffix forms: the data-dir rule above deliberately stops at '/' or end of
  // literal, so these are covered here by exact value instead.
  `.${NAMESPACE}-backup`, `.${NAMESPACE}-trust-shadow.json`,
  ...Object.values(ENV),
  // Case-insensitive: env names carry the namespace UPPERCASED — the old
  // case-sensitive filter silently dropped every one of them (a vacuous
  // target set, the exact species GATE 3 of the scanner harness names).
].filter(v => v.toLowerCase().includes(NAMESPACE));



/**
 * The exact env names Waykeep owns. Matching whole tokens against this set —
 * rather than pattern-matching a prefix — is what makes the check both
 * complete and false-positive-free: it catches `process.env.X`, aliased
 * (`const e = process.env; e.X`), destructured, object-literal keys and bare
 * strings inside messages, while ignoring unrelated identifiers that merely
 * begin with the same prefix (e.g. CAIRN_HOOK_DIR_MARKER, a path fragment
 * constant, not an environment variable).
 *
 * Known limit: an env name that is not yet in the ENV table cannot be
 * recognized, and string-concatenation obfuscation ('.'+'cairn') defeats any
 * regex. Both are review concerns, not drift of already-centralized names.
 */
const OWNED_ENV_NAMES = new Set<string>(Object.values(ENV));
const TOKEN = /\b[A-Z][A-Z0-9_]{2,}\b/g;

describe('environment variable names are never spelled inline', () => {
  it('no scanned source file names an owned env var by literal', () => {
    // Runs on the VALIDATED scanner (structural-scanner-validation.test.ts
    // proves its known-positive, cross-file and mutation gates) — an inline
    // re-implementation here would be an unvalidated instrument.
    assert.ok(SCANNED.length > 0 && OWNED_ENV_NAMES.size > 0, 'vacuous-instrument guard');
    const hits = scanForTokens(SCANNED, OWNED_ENV_NAMES, TOKEN);
    const offenders = [...new Set(hits.map(h => `${relative(REPO, h.file)} -> ${h.value}`))];
    assert.deepEqual(offenders, [],
      `these files name an env var literally — import it from src/constants/env.ts:\n  ${offenders.join('\n  ')}`);
  });

  it('every ENV entry derives from the contract prefix', () => {
    for (const [key, value] of Object.entries(ENV)) {
      assert.equal(value, `${ENV_PREFIX}_${key}`, `ENV.${key} must be built by envName()`);
    }
  });
});

describe('the state directory name is never spelled inline', () => {
  it('no scanned source file writes the data-dir name in a string literal', () => {
    // Only string literals: `.cairn` is also a PROPERTY access on client
    // config objects (`(existing.mcpServers ?? {}).cairn`, `[mcp_servers.cairn]`),
    // which is the MCP SERVER NAME, not the state directory. That form is
    // owned by MCP_SERVER_NAME and guarded by the MCP suite below — both the
    // TOML `mcp_servers.<name>` and the JSON `mcpServers.<name>` spellings.
    const literals = (code: string): string[] =>
      code.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];
    // A state-directory segment is followed by '/' or ends the literal —
    // never by '-' or '.'. That distinguishes it from the BRAND-named pack
    // extensions (PACK_EXT '.waykeep.md', PACK_MANIFEST '.waykeep-pack.json'),
    // which deliberately do not track NAMESPACE and would otherwise turn this
    // gate red on the rename it exists to certify.
    const dirRe = new RegExp(`(?<![A-Za-z0-9_])\\${DATA_DIR_NAME}(?:/|$)`);
    const offenders: string[] = [];
    for (const file of SCANNED) {
      const code = stripComments(readFileSync(file, 'utf-8'));
      if (literals(code).some(lit => dirRe.test(lit.slice(1, -1)))) offenders.push(relative(REPO, file));
    }
    assert.deepEqual(offenders, [],
      `these files build a path from the literal directory name — use src/constants/paths.ts:\n  ${offenders.join('\n  ')}`);
  });
});

describe('the MCP surface is never spelled inline', () => {
  const literals = (code: string): string[] =>
    code.match(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g) ?? [];

  it('no scanned source file writes a tool name, the URI scheme, or a qualified name', () => {
    // The MCP surface is the most externally-visible identity Waykeep has:
    // the server name lands in other tools' config files and the tool names
    // appear in every agent's prompt. A stale literal here means the server
    // registers one name while its own prompts and transcript scanning
    // reference another.
    //
    // Scanned across ALL code, not just string literals: these needles are
    // distinctive enough not to collide with property access, and restricting
    // to strings would let a REGEX literal through — which is exactly how a
    // live `mcp__cairn__` matcher in prompt/helpers.ts initially escaped.
    const needles = [
      ...ALL_TOOL_NAMES,
      `${MCP_URI_SCHEME}://`,
      `mcp__${MCP_SERVER_NAME}__`,
      `mcp_servers.${MCP_SERVER_NAME}`,
      `mcpServers.${MCP_SERVER_NAME}`,
    ];
    const offenders: string[] = [];
    for (const file of SCANNED) {
      const code = stripComments(readFileSync(file, 'utf-8'));
      const hits = new Set<string>();
      for (const n of needles) if (code.includes(n)) hits.add(n);
      // Any tool-prefixed token, not just the ones we register today — a
      // newly hardcoded `cairn_probe` is drift the known-names list misses.
      for (const m of code.matchAll(new RegExp(`\\b${MCP_TOOL_PREFIX}[a-z][a-z_]*\\b`, 'g'))) hits.add(m[0]);
      // The bare server name, as in `new McpServer({ name: 'cairn' })`. Only
      // an exact whole-literal match — the token alone is far too common.
      for (const lit of literals(code)) {
        if (lit.slice(1, -1) === MCP_SERVER_NAME) hits.add(`bare '${MCP_SERVER_NAME}'`);
      }
      if (hits.size) offenders.push(`${relative(REPO, file)} -> ${[...hits].join(', ')}`);
    }
    assert.deepEqual(offenders, [],
      `these files spell an MCP identifier literally — import it from src/constants/mcp.ts:\n  ${offenders.join('\n  ')}`);
  });

  it('no scanned source file hardcodes any namespaced value', () => {
    // Broader than the tool-name needles: this covers the relay probe flag and
    // sentinel, the client header, the client-state filename and the db
    // filename. The probe is the cautionary case — it lives in the compiled
    // binary AND in two detectors, and when the two sides disagree the probe
    // simply fails and every hook silently degrades to the slower shell relay.
    // DATA_DIR_NAME is excluded here and checked by its own test above:
    // a plain substring match on `.cairn` also hits `mcpServers.cairn`, the
    // MCP server name, which needs the boundary rule that test applies.
    // Runs on the VALIDATED scanner (see structural-scanner-validation).
    const targets = NAMESPACED_VALUES.filter(v => v !== DATA_DIR_NAME);
    assert.ok(SCANNED.length > 0 && targets.length > 0, 'vacuous-instrument guard');
    const hits = scanForInlineValues(SCANNED, targets);
    const offenders = [...new Set(hits.map(h => `${relative(REPO, h.file)} -> ${h.value}`))];
    assert.deepEqual(offenders, [],
      `these files hardcode a namespaced value — derive it from the contract:\n  ${offenders.join('\n  ')}`);
  });

  it('no scanned source file still carries a LEGACY namespace', () => {
    // The counterpart to every other check here. Those all derive their needles
    // from the CURRENT namespace, so after a rename they hunt the new name and
    // cannot see what was left behind. This one looks backwards.
    //
    // Vacuous until LEGACY_NAMESPACES is populated — which the flip commit must
    // do, or the guards silently stop being able to find stragglers.
    const offenders: string[] = [];
    for (const file of SCANNED) {
      const code = stripComments(readFileSync(file, 'utf-8'));
      const hits = LEGACY_NAMESPACES.filter(ns => new RegExp(`\\b${ns}[_.-]`).test(code));
      if (hits.length) offenders.push(`${relative(REPO, file)} -> ${hits.join(', ')}`);
    }
    assert.deepEqual(offenders, [],
      `these files still carry a retired namespace:\n  ${offenders.join('\n  ')}`);
  });

  it('the constants modules derive rather than restate the namespace', () => {
    // The TOOL/ENV derivation assertions compare a value against a prefix that
    // is itself derived, so hardcoded CURRENT values would satisfy them. This
    // closes that: identity.ts is the ONLY file allowed to spell the namespace,
    // so if the others contain no literal copy, they can only be deriving it.
    const offenders: string[] = [];
    for (const f of readdirSync(CONSTANTS_DIR).filter(n => n.endsWith('.ts'))) {
      const raw = readFileSync(join(CONSTANTS_DIR, f), 'utf-8');
      // Drop module specifiers first. The PACKAGE is named for the brand
      // ('waykeep-contract'), which is not the namespace slug — after the
      // rename every import would otherwise look like a restatement and this
      // gate would go red on the very change it exists to certify.
      const code = stripComments(raw)
        .replace(/from\s+'[^']*'/g, '')
        .replace(/import\(\s*'[^']*'\s*\)/g, '');
      if (literals(code).some(lit => lit.includes(NAMESPACE))) offenders.push(`src/constants/${f}`);
    }
    assert.deepEqual(offenders, [],
      `these constants modules restate the namespace instead of deriving it:\n  ${offenders.join('\n  ')}`);
  });

  it('identity.ts spells the namespace exactly once — it is the sole source', () => {
    const code = stripComments(readFileSync(
      join(REPO, 'packages', 'contract', 'src', 'identity.ts'), 'utf-8'));
    const copies = literals(code).filter(lit => lit.slice(1, -1) === NAMESPACE);
    assert.equal(copies.length, 1,
      `identity.ts must contain exactly one '${NAMESPACE}' literal (the NAMESPACE definition); found ${copies.length}`);
  });

  it('every TOOL entry derives from the contract tool prefix', () => {
    for (const [key, value] of Object.entries(TOOL)) {
      assert.equal(value, `${MCP_TOOL_PREFIX}${key.toLowerCase()}`,
        `TOOL.${key} must be built by toolName()`);
    }
  });

  it('the namespace is regex-safe, so interpolating it unescaped is sound', () => {
    // codex-init.ts builds TOML detection patterns by interpolating the server
    // name into `new RegExp` without escaping. That is safe only while the
    // namespace carries no regex metacharacters — asserted here rather than
    // argued in a comment.
    assert.match(NAMESPACE, /^[a-z][a-z0-9]*$/,
      'NAMESPACE must be a bare lowercase slug: it is interpolated unescaped into regexes');
  });

  it('qualified names embed the current server name', () => {
    assert.equal(qualifiedToolName(TOOL.PLAN), `mcp__${MCP_SERVER_NAME}__${TOOL.PLAN}`);
  });
});

describe('artifacts that cannot import TypeScript derive their names', () => {
  /**
   * The compiled relay, the shell relays and the JS harnesses cannot import
   * waykeep-contract, so `scripts/gen-identity.mjs` emits the namespace for
   * them at build time (dist/generated/identity.{h,sh,json}).
   *
   * Before that generator these files spelled the names by hand, and their
   * staleness failed SILENTLY — a relay pointing at a directory nobody
   * writes, or a test preload that stops redirecting and lets the whole
   * suite operate on the developer's real home while still passing. These
   * assertions require the derivation and forbid a hardcoded copy.
   */
  const GENERATED = join(REPO, 'dist', 'generated');

  /** Comment-strip per language so prose mentioning a name is not a finding.
   *  JS/C branch uses the shared VALIDATED string-aware stripper (step 8);
   *  the shell branch stays local — '#' comments are outside its lexicon. */
  function stripFor(file: string, text: string): string {
    if (file.endsWith('.sh')) return text.replace(/^\s*#.*$/gm, '');
    return stripComments(text);
  }

  const DERIVED: ReadonlyArray<{
    path: string[]; marker: string; allow?: readonly string[]; why?: string;
  }> = [
    { path: ['src', 'hooks', 'hook-relay.c'], marker: 'identity.h' },
    { path: ['src', 'hooks', 'hook-relay.sh'], marker: 'identity.sh' },
    { path: ['src', 'hooks', 'statusline-relay.sh'], marker: 'identity.sh' },
    { path: ['tests', 'hermetic-env.cjs'], marker: 'identity.json' },
    { path: ['scripts', 'golden-hooks.mjs'], marker: 'identity.json' },
    { path: ['scripts', 'inspect-gates.mjs'], marker: 'identity.json' },
    {
      // 'waykeep' here is the BRAND (already renamed), not the namespace slug.
      path: ['plugins', 'claude', 'waykeep', 'bin', 'waykeep-relay.sh'],
      marker: 'identity.sh',
      // The cache directory is resolved BEFORE the hook dir is known, so it
      // cannot be sourced from identity.sh — a bootstrap ordering constraint,
      // not an oversight. After a rename it becomes a cold cache: the launcher
      // re-resolves through the CLI, so behaviour is correct, only the location
      // is stale. Tracked for B3.
      allow: [`${DATA_DIR_NAME}`],
      why: 'cache dir is needed before the hook dir is resolvable',
    },
  ];

  for (const { path, marker, allow = [] } of DERIVED) {
    const rel = path.join('/');
    it(`${rel} derives from ${marker} and hardcodes no namespaced value`, () => {
      const raw = readFileSync(join(REPO, ...path), 'utf-8');
      assert.ok(raw.includes(marker),
        `${rel} must take its names from ${marker}, not spell them`);
      const code = stripFor(rel, raw);
      const bad = NAMESPACED_VALUES.filter(v => !allow.includes(v) && code.includes(v));
      assert.deepEqual(bad, [],
        `${rel} hardcodes ${bad.join(', ')} — these must come from ${marker}`);
    });
  }

  it('the COMPILED relay answers the contract probe with the contract sentinel', () => {
    // The strongest check available: it runs the actual artifact rather than
    // reading source. Both reviewers noted this alone would have caught the
    // generator/detector probe split — the source-level checks did not,
    // because each side was internally consistent.
    const bin = join(REPO, 'dist', 'src', 'hooks', 'hook-relay');
    if (!existsSync(bin)) return; // no compiler on this machine; build tests cover that
    const out = spawnSync(bin, [RELAY_PROBE_FLAG], { encoding: 'utf-8', timeout: 10_000 });
    assert.equal(out.status, 0, `probe exited ${out.status}: ${out.stderr}`);
    assert.equal((out.stdout ?? '').trim(), RELAY_PROBE_SENTINEL,
      'the compiled relay does not answer the contract probe — every install would ' +
      'silently fall back to the slower shell relay');
  });

  it('the relay probe handshake is identical on both sides', () => {
    // The binary answers the flag with the sentinel; the CLI and the plugin
    // launcher decide from that whether to use the fast path. If the two
    // sides disagree the probe just fails and every hook silently degrades
    // to the slower shell relay, with nothing reporting it.
    const sh = readFileSync(join(REPO, 'dist', 'generated', 'identity.sh'), 'utf-8');
    assert.ok(sh.includes(`WK_PROBE_FLAG='${RELAY_PROBE_FLAG}'`), 'identity.sh probe flag drifted');
    assert.ok(sh.includes(`WK_PROBE_SENTINEL='${RELAY_PROBE_SENTINEL}'`), 'identity.sh probe sentinel drifted');
    const h = readFileSync(join(REPO, 'dist', 'generated', 'identity.h'), 'utf-8');
    assert.ok(h.includes(`#define WK_PROBE_FLAG "${RELAY_PROBE_FLAG}"`), 'identity.h probe flag drifted');
  });

  /**
   * Machine-visible files that CANNOT derive: JSON manifests, and shell that
   * needs the state dir before the hook dir is resolvable. They are what the
   * clients actually read — `.mcp.json` is how Claude Code starts the server,
   * and the Codex defaultPrompt tells agents which tools to call. No codegen
   * reaches them, so the guarantee here is the inverse of the one above:
   * assert they carry the CURRENT names, so a rename turns them red and
   * forces the update instead of silently leaving clients pointed at a
   * server and tools that no longer exist.
   */
  const CLIENT_FACING: ReadonlyArray<{ path: string[]; must: string[] }> = [
    { path: ['plugins', 'claude', 'waykeep', '.mcp.json'],
      must: [`"${MCP_SERVER_NAME}"`, ENV.LOG_LEVEL] },
    { path: ['plugins', 'codex', 'waykeep', '.codex-plugin', 'plugin.json'],
      must: [`"${MCP_SERVER_NAME}"`, TOOL.RECALL, TOOL.LEARN] },
    { path: ['plugins', 'claude', 'waykeep', 'bin', 'waykeep-mcp.sh'],
      must: [DATA_DIR_NAME] },
    { path: ['scripts', 'repair-confidence.mjs'],
      must: [DATA_DIR_NAME, DB_FILENAME] },
  ];

  for (const { path, must } of CLIENT_FACING) {
    const rel = path.join('/');
    it(`${rel} still names the current server/tools`, () => {
      const text = readFileSync(join(REPO, ...path), 'utf-8');
      const missing = must.filter(v => !text.includes(v));
      assert.deepEqual(missing, [],
        `${rel} is a client-facing artifact that cannot derive its names. ` +
        `It no longer mentions ${missing.join(', ')} — the namespace changed and this file ` +
        'was left behind, so clients would start the wrong server or call tools that do not exist.');
    });
  }

  it('the generated artifacts match the contract', () => {
    const h = readFileSync(join(GENERATED, 'identity.h'), 'utf-8');
    const sh = readFileSync(join(GENERATED, 'identity.sh'), 'utf-8');
    const jsonId = JSON.parse(readFileSync(join(GENERATED, 'identity.json'), 'utf-8')) as {
      NAMESPACE: string; DATA_DIR: string; ENV: Record<string, string>;
    };
    assert.ok(h.includes(`#define WK_DATA_DIR "${DATA_DIR_NAME}"`), 'identity.h data dir drifted');
    assert.ok(h.includes(`#define WK_ENV_CLIENT "${ENV_PREFIX}_CLIENT"`), 'identity.h client env drifted');
    assert.ok(sh.includes(`WK_DATA_DIR='${DATA_DIR_NAME}'`), 'identity.sh data dir drifted');
    assert.equal(jsonId.NAMESPACE, NAMESPACE, 'identity.json namespace drifted');
    assert.equal(jsonId.DATA_DIR, DATA_DIR_NAME, 'identity.json data dir drifted');
    assert.deepEqual(jsonId.ENV, { ...ENV, CLIENT: ENV.CLIENT }, 'identity.json env table drifted');
  });
});
