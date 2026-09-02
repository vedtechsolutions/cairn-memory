/**
 * Rename doc/deploy sweep (Phase B — codex re-review gap).
 *
 * The namespace-centralization guards scan src/ and derive names from the
 * contract. Operator- and agent-facing TEXT files (README, docs, deploy
 * units, shipped plugin manifests) cannot import the contract, so a retired
 * name left in them lies to users without failing any src guard. This
 * sweep is the negative check: no ACTIVE legacy token in those files,
 * while legitimate transition references (LEGACY_NAMESPACES-derived paths,
 * env names, the deprecated-package note, 'Formerly Cairn') stay allowed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEGACY_NAMESPACES } from 'waykeep-contract';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Recursively collect shipped-source files, skipping generated/vendored trees
 *  and test files (tests legitimately construct legacy `cairn_*` fixtures). */
function walkSource(dir: string, exts: readonly string[], acc: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkSource(full, exts, acc);
    else if (exts.some(e => name.endsWith(e)) && !name.endsWith('.test.ts')) acc.push(full);
  }
  return acc;
}

/** A line that frames a legacy token as legacy/transition is allowed. The words
 *  are STRONG legacy signals only, and WORD-BOUNDED so an unrelated word cannot
 *  contain one as a substring (codex B1 review: "incompatible" contains "compat"
 *  and wrongly excused a residue). */
const LEGACY_FRAMING = /\blegacy\b|\bun-migrated\b|until you migrate|\bdeprecated\b|\bFormerly\b|keeps? reading|\brenamed\b|\bmigrat|\bcompat/i;

/** The line of text containing byte `index`. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1;
  const end = text.indexOf('\n', index);
  return text.slice(start, end < 0 ? undefined : end);
}

/** True when the retired token at `index` is framed as legacy ON ITS OWN LINE.
 *  A window approach let an UNRELATED nearby line (e.g. "database migration
 *  helper" near a real `cairn-tap-`) excuse a residue (codex B1 review). Framing
 *  must apply to the token itself, so every legit legacy reference self-frames
 *  with a strong signal on its own line. */
function framedOnLine(text: string, index: number): boolean {
  return LEGACY_FRAMING.test(lineAt(text, index));
}

const FILES = [
  'README.md',
  // Top-level shipped docs an operator or contributor reads directly — these
  // were outside the allowlist before (codex B1 review): the sweep passed
  // while SECURITY.md/CONTRIBUTING.md still said "Cairn".
  'SECURITY.md', 'CONTRIBUTING.md', 'CLA.md', 'CODE_OF_CONDUCT.md',
  // GitHub-facing templates a contributor sees when filing (codex B1 review
  // caught `cairn doctor` here).
  '.github/ISSUE_TEMPLATE/bug_report.md', '.github/ISSUE_TEMPLATE/feature_request.md',
  'docs/development.md', 'docs/INSTALL.md', 'docs/daemon.md',
  'docs/governance-inspector.md', 'docs/memory-tool-adapter.md',
  'deploy/waykeep-daemon.service',
  'deploy/codex-hooks.json',
  // Shipped, operator-runnable relay scripts — their usage/help comments are
  // as operator-facing as any doc (codex B1 review flagged `/opt/cairn` here).
  'src/hooks/hook-relay.sh', 'src/hooks/statusline-relay.sh',
  'plugins/claude/waykeep/.mcp.json',
  'plugins/claude/waykeep/.claude-plugin/plugin.json',
  'plugins/codex/waykeep/.codex-plugin/plugin.json',
  '.claude/rules/waykeep.md',
];

/** Active legacy forms an agent or operator would actually see as current. */
function activeLegacyHits(ns: string, text: string): string[] {
  const U = ns.toUpperCase();
  const forms: Array<[string, RegExp]> = [
    [`${ns}_ tool`, new RegExp(`\\b${ns}_[a-z]`, 'g')],
    [`${ns}:// URI`, new RegExp(`${ns}://`, 'g')],
    [`mcp__${ns}__`, new RegExp(`mcp__${ns}__`, 'g')],
    [`${U}_ env`, new RegExp(`\\b${U}_[A-Z]`, 'g')],
    // state dir / db filename / rule file — paths an operator would run
    [`~/.${ns} path`, new RegExp(`~/\\.${ns}\\b`, 'g')],
    // bare .cairn/ project dir (e.g. .cairn/gates.json) — NOT only the ~/ home
    // form (codex B1 review): a project-relative legacy path also lies.
    [`.${ns}/ path`, new RegExp(`(?<![\\w~])\\.${ns}/`, 'g')],
    [`${ns}.db`, new RegExp(`\\b${ns}\\.db\\b`, 'g')],
    [`rules/${ns}.md`, new RegExp(`rules/${ns}\\.md`, 'g')],
    // CLI commands + MCP server key + daemon unit
    [`${ns} <cmd>`, new RegExp(`\\b${ns} (init|doctor|import|export|pack|serve|report|migrate)\\b`, 'g')],
    [`"${ns}" server key`, new RegExp(`"${ns}"\\s*:`, 'g')],
    [`${ns}-daemon`, new RegExp(`\\b${ns}-daemon\\b`, 'g')],
    // bracket status/warning tag the memory tool + nudges render ([cairn: …], [CAIRN])
    [`[${ns}] tag`, new RegExp(`\\[${ns}[:\\]]`, 'gi')],
    // absolute dev-machine install path an operator would copy verbatim
    [`/opt/${ns} path`, new RegExp(`/opt/${ns}\\b`, 'g')],
    // brand word as a standalone noun (allow 'Formerly Cairn' + legacy framing via the line filter)
    [`${ns[0].toUpperCase()+ns.slice(1)} brand`, new RegExp(`\\b${ns[0].toUpperCase()+ns.slice(1)}\\b`, 'g')],
  ];
  const hits: string[] = [];
  for (const [label, re] of forms) {
    for (const m of text.matchAll(re)) {
      // Allow lines that explicitly frame the token as legacy/transition.
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      const lineEnd = text.indexOf('\n', m.index);
      const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
      if (LEGACY_FRAMING.test(line)) continue;
      hits.push(`${label}: "${line.trim().slice(0, 80)}"`);
    }
  }
  return hits;
}

describe('rename doc/deploy sweep (no lying legacy tokens)', () => {
  for (const rel of FILES) {
    it(`${rel} presents no legacy token as current`, () => {
      const path = join(REPO, rel);
      if (!existsSync(path)) return; // file optional
      const text = readFileSync(path, 'utf-8');
      const offenders = LEGACY_NAMESPACES.flatMap(ns => activeLegacyHits(ns, text));
      assert.deepEqual(offenders, [],
        `${rel} presents retired names as current — update or frame as legacy:\n  ${offenders.join('\n  ')}`);
    });
  }

  it('the sweep is non-vacuous: it FLAGS planted lies of every shape', () => {
    // One planted line per form the sweep claims to catch — a self-test that
    // would notice if a form silently stopped matching (the failure mode that
    // lets residue slip past a green sweep).
    const planted = [
      'Call cairn_recall before starting work and set CAIRN_DB_PATH.',
      'The view renders as [cairn: 3 records unrenderable — see logs].',
      'Install at /opt/cairn/dist and run cairn init to wire it up.',
      'Point clients at mcp__cairn__ over cairn://memory.',
      'The checked-in .cairn/gates.json is the versioned example.',
    ].join('\n');
    const hits = LEGACY_NAMESPACES.flatMap(ns => activeLegacyHits(ns, planted));
    // tool, env, bracket-tag, /opt path, cli-cmd, mcp prefix, uri, .cairn/ → >2.
    assert.ok(hits.length >= 7,
      `the sweep must catch every unframed legacy shape, got ${hits.length}:\n  ${hits.join('\n  ')}`);
    assert.ok(hits.some(h => h.startsWith('[cairn] tag')), 'bracket-tag form must fire');
    assert.ok(hits.some(h => h.startsWith('/opt/cairn path')), '/opt path form must fire');
    assert.ok(hits.some(h => h.startsWith('.cairn/ path')), 'bare .cairn/ path form must fire');
  });
});

/**
 * A STRUCTURAL guard (codex B1 review): rather than enumerating individual
 * files, scan all shipped source for the retired brand word presented as
 * current. This is what catches published JSDoc (npm IntelliSense) and
 * operator-facing CLI/CI output that a hardcoded allowlist keeps missing.
 */
describe('no shipped source presents the retired brand word as current', () => {
  // Per-directory extension sets: code trees carry .ts/.mjs/.c/.sh; the .github
  // tree carries CI/workflow/config surfaces (.json/.yml/.md) that also ship and
  // whose brand text is CI- and contributor-visible (codex B1 review).
  const SCAN_GROUPS = [
    { root: 'src', exts: ['.ts', '.mjs', '.c', '.sh'] },
    { root: 'scripts', exts: ['.ts', '.mjs', '.c', '.sh'] },
    { root: join('packages', 'contract', 'src'), exts: ['.ts', '.mjs', '.c', '.sh'] },
    { root: '.github', exts: ['.json', '.yml', '.yaml', '.md'] },
  ] as const;
  // npm-published front-matter — the MOST user-visible shipped surface (package
  // pages, IntelliSense) — is scanned for the BRAND WORD only, not the full
  // legacy-token forms: these manifests legitimately carry the lowercase `cairn`
  // bin alias and keyword, which \bCairn\b (capitalized) does not match. Closes
  // the walk's .md/.json blind spot (codex B1 review, round-8 reviewer probe).
  const PUBLISHED_FRONTMATTER = [
    'package.json',
    'packages/contract/package.json',
    'packages/contract/README.md',
  ] as const;

  for (const brand of LEGACY_NAMESPACES.map(ns => ns[0].toUpperCase() + ns.slice(1))) {
    it(`no unframed "${brand}" in shipped source, CI config, or published front-matter`, () => {
      const re = new RegExp(`\\b${brand}\\b`, 'g');
      const offenders: string[] = [];
      const files = [
        ...SCAN_GROUPS.flatMap(g => walkSource(join(REPO, g.root), g.exts)),
        ...PUBLISHED_FRONTMATTER.map(rel => join(REPO, rel)).filter(existsSync),
      ];
      for (const file of files) {
        const text = readFileSync(file, 'utf-8');
        for (const m of text.matchAll(re)) {
          const lineStart = text.lastIndexOf('\n', m.index) + 1;
          const lineEnd = text.indexOf('\n', m.index);
          const line = text.slice(lineStart, lineEnd < 0 ? undefined : lineEnd);
          if (LEGACY_FRAMING.test(line)) continue;
          offenders.push(`${file.slice(REPO.length + 1)}: "${line.trim().slice(0, 80)}"`);
        }
      }
      assert.deepEqual(offenders, [],
        `shipped source presents the retired brand as current — rename or frame as legacy:\n  ${offenders.join('\n  ')}`);
    });
  }

  // codex B1 review — lowercase technical tokens (cairn_recall, CAIRN_TZ,
  // cairn://) ship in dist/*.js comments and pass a brand-word-only guard. Scan
  // the code trees for them, allowing legacy-framed lines (window, for JSDoc).
  for (const ns of LEGACY_NAMESPACES) {
    const U = ns.toUpperCase();
    it(`no unframed lowercase legacy token (${ns}_/${U}_/${ns}://) in shipped code`, () => {
      const forms = [
        new RegExp(`\\b${ns}_[a-z]`, 'g'), new RegExp(`\\b${U}_[A-Z]`, 'g'),
        new RegExp(`${ns}://`, 'g'), new RegExp(`mcp__${ns}__`, 'g'),
        // hyphenated file/id names (cairn-state.json, cairn-daemon) + the state
        // dir path (.cairn, ~/.cairn, .cairn/gates.json) — codex B1 review.
        new RegExp(`\\b${ns}-[a-z]`, 'g'), new RegExp(`\\.${ns}\\b`, 'g'),
      ];
      const codeGroups = SCAN_GROUPS.filter(g => g.root !== '.github');
      const offenders: string[] = [];
      for (const g of codeGroups) {
        for (const file of walkSource(join(REPO, g.root), g.exts)) {
          const text = readFileSync(file, 'utf-8');
          for (const re of forms) {
            for (const m of text.matchAll(re)) {
              if (framedOnLine(text, m.index)) continue;
              const line = text.slice(text.lastIndexOf('\n', m.index) + 1, text.indexOf('\n', m.index));
              offenders.push(`${file.slice(REPO.length + 1)}: "${line.trim().slice(0, 80)}"`);
            }
          }
        }
      }
      assert.deepEqual(offenders, [],
        `shipped code carries unframed legacy technical tokens (they ship in dist/*.js):\n  ${offenders.join('\n  ')}`);
    });
  }

  it('the source scan is non-vacuous: it FLAGS a planted brand word', () => {
    // Guard the guard: prove the brand regex fires and the framing filter both
    // passes framed lines and does NOT excuse an unframed one.
    const unframed = 'This function is the heart of Cairn and does the thing.';
    const framed = 'Format not parseable — Formerly Cairn, now Waykeep.';
    assert.equal([...unframed.matchAll(/\bCairn\b/g)].length, 1, 'brand word must match');
    assert.ok(!LEGACY_FRAMING.test(unframed), 'an unframed line is not excused');
    assert.ok(LEGACY_FRAMING.test(framed), 'a framed line is excused');
  });

  it('the lowercase-token scan is non-vacuous AND same-line-framed (no proximity escape)', () => {
    const unframed = 'Live `cairn_recall` mutates recall telemetry every call.';
    const sameLine = 'The legacy `cairn_recall` alias keeps old prompts working.';
    // A strong signal on an ADJACENT line must NOT excuse the token — only its
    // own line counts (codex B1 review: a nearby "migration" fooled the window).
    const adjacentOnly = 'This is a database migration helper.\nLive `cairn_recall` fires here.';
    assert.ok([...unframed.matchAll(/\bcairn_[a-z]/g)].length === 1, 'lowercase token must match');
    assert.ok(!framedOnLine(unframed, unframed.indexOf('cairn_')), 'unframed token is caught');
    assert.ok(framedOnLine(sameLine, sameLine.indexOf('cairn_')), 'a strong signal on the same line excuses it');
    assert.ok(!framedOnLine(adjacentOnly, adjacentOnly.indexOf('cairn_')), 'an adjacent-line signal does NOT excuse the residue');
    // Framing words are WORD-BOUNDED: "incompatible" contains "compat" but must
    // NOT excuse a residue on its line (codex B1 review).
    const substringTrap = 'Use `cairn_recall` because this client is incompatible with API v1.';
    assert.ok(!framedOnLine(substringTrap, substringTrap.indexOf('cairn_')),
      '"incompatible" must not frame-excuse via the "compat" substring');
  });
});
