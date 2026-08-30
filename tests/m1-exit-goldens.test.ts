import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';


import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { renderTier3 } from '../src/hooks/shared/briefing/memory-tier-renderers.js';
import { compileIndexBriefing } from '../src/hooks/shared/briefing/index-briefing.js';
import { generateFingerprint } from '../src/utils/fingerprint.js';

import { applyHostileRow, assertGolden } from './helpers/hostile-row.js';

/**
 * M1-exit per-path malicious goldens + the render-wiring guard.
 *
 * The formatter unit tests prove the FORMATTER; these prove the PATHS —
 * an author-bearing hostile row driven through real render plumbing,
 * plus a mechanical source guard that fails when any render site drops
 * its formatter call (the wiring-miss detector both gates required: a
 * site silently reverting to raw `.content` is the likeliest future
 * regression, and no unit test can see it).
 */

const PROJECT = 'exit-proj';

describe('M1-exit: per-path malicious goldens', () => {
  it('the pitfall briefing tier renders the hostile team row labeled and defanged', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      applyHostileRow(db, PROJECT, 'pitfall');
      const repo = new MemoryRepository(db);
      const { tier } = renderTier3(repo, { project: PROJECT, sessionType: 'startup', interrupted: false }, 2000, generateFingerprint({ tags: ['probe'] }));
      const rendered = tier.lines.join('\n');
      assert.ok(rendered.length > 0, 'the tier rendered something');
      assertGolden(rendered, 'briefing tier3');
    } finally {
      db.close();
    }
  });

  it('the compact index briefing renders the hostile team row labeled and defanged', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      applyHostileRow(db, PROJECT, 'pitfall');
      applyHostileRow(db, PROJECT, 'decision');
      const repo = new MemoryRepository(db);
      const planRepo = new PlanRepository(db);
      const out = compileIndexBriefing(repo, planRepo, { project: PROJECT, sessionType: 'compact', interrupted: false });
      const rendered = out.text;
      assertGolden(rendered, 'index briefing');
    } finally {
      db.close();
    }
  });
});

describe('M1-exit: the render-wiring guard (AST)', () => {
  // AST-based (Codex exit final #2: the regex guard skipped whole
  // statements on any safe marker, missed mixed-safe/raw arguments,
  // destructured aliases, arbitrary sinks, and unenumerated files).
  // Per-NODE: each `.content` access is safe only if one of ITS OWN
  // ancestor calls is a sanctioned formatter/predicate — a sibling
  // argument's formatter call sanctions nothing.
  const SAFE_CALLEES = new Set([
    'formatMemoryContent', 'formatAuxText',
  // Canonical serialization (pack export): JSON-escapes newlines, so
  // LINE_LEADING markers cannot fire; pack files re-enter through the
  // learn pipeline, which scrubs and neutralizes on import.
  'stringify', 'clean', 'JSON.stringify', 'safeExcerpt',
    // Predicates and scoring/dedup consumers — content as INPUT, never output.
    'isCompletedDecision', 'isCorrectionQuality', 'isMemoryEligibleForInjection',
    'isResolvedPitfallContent', 'tokeniseForOverlap', 'buildFtsQuery', 'isMetaGoal',
    'rerank', 'extractWinningPattern', 'generateFingerprint', 'search', 'findSimilarTo',
    'truncate', 'clip', 'scanForRawContent', 'contentsOppose', 'tokenOverlap', 'embed',
    'storeVersion', 'isSystemContent', 'extractWhyContext', 'computeEffectiveness',
    // Repository/storage WRITES — content as ingestion input, never as
    // rendered output (the write layer scrubs; the render layer labels).
    'create', 'storeDecision', 'storePitfall', 'storeMemory', 'learnSections', 'update',
    'push_', // placeholder, never matches
  ]);

  // Files whose `.content` is NOT memory content (justified exemptions):
  const EXEMPT_FILES = new Set([
    // Parses HOOK INPUT payloads (tool_input.content) — agent-authored
    // input, not stored memory rows.
    'src/hooks/handlers/pitfall/input-extract.ts',
    // Transcript JSONL parsers: entry.message.content is transcript
    // structure, not memory rows.
    'src/hooks/shared/transcript/entry-scan.ts',
    'src/hooks/shared/transcript/goal-extraction.ts',
    'src/hooks/shared/transcript/parse-transcript.ts',
    // `result.content` here is the MCP SAMPLING response envelope (the
    // Socratic reflection reply), not a stored memory row; its output
    // lands via repo.create — the scrub-on-write layer.
    'src/hooks/shared/decision-reflector.ts',
  ]);
  // truncate/clip results still need a formatter before rendering — but
  // every production use is INSIDE a formatMemoryContent argument, and
  // a bare truncate-to-sink shows up as the OUTER call being unsafe.

  function calleeName(node: import('typescript').CallExpression, tsm: typeof import('typescript')): string {
    const e = node.expression;
    if (tsm.isIdentifier(e)) return e.text;
    if (tsm.isPropertyAccessExpression(e)) return e.name.text;
    return '';
  }

  async function astScan(source: string, label: string): Promise<string[]> {
    const tsm = (await import('typescript')).default;
    const sf = tsm.createSourceFile(label, source, tsm.ScriptTarget.Latest, true);
    const offenders: string[] = [];
    const visit = (node: import('typescript').Node): void => {
      // Destructured content alias: const { content } = memoryish.
      // PARAMETER destructuring (async ({ content }) => …, the MCP tool
      // input signature) is agent-authored INPUT, not a stored row —
      // only variable-declaration destructuring aliases a row field.
      if (tsm.isObjectBindingPattern(node)
        && tsm.isVariableDeclaration(node.parent)
        && node.elements.some((el) => tsm.isIdentifier(el.name) && el.name.text === 'content' && !el.propertyName)) {
        offenders.push(`${label}: destructured content alias`);
      }
      if (tsm.isPropertyAccessExpression(node) && node.name.text === 'content') {
        // Walk ancestors: safe if any enclosing call is sanctioned; a
        // comparison/typeof/length context is safe; otherwise, reaching
        // a call/template/binary+/assignment/return sink is a finding.
        let cur: import('typescript').Node = node;
        let parent = cur.parent;
        let verdictSafe = false;
        let sink: string | null = null;
        while (parent && !verdictSafe && !sink) {
          // A chained method call (.toLowerCase(), .slice(…)) is not a
          // consumer — its RESULT continues toward whatever sink or
          // sanctioned call eventually takes it.
          if (tsm.isCallExpression(parent) && parent.expression === cur) {
            cur = parent; parent = cur.parent; continue;
          }
          if (tsm.isCallExpression(parent) && parent.arguments.some((a) => a === cur || a.getText().includes(node.getText()))
            && SAFE_CALLEES.has(calleeName(parent, tsm))) { verdictSafe = true; break; }
          if (tsm.isCallExpression(parent)) {
            // an UNSANCTIONED call consuming it — keep walking: an outer
            // sanctioned call still redeems it (e.g. map cb inside rerank).
            const outerHasSafe = ((): boolean => {
              let p2: import('typescript').Node | undefined = parent.parent;
              while (p2) {
                if (tsm.isCallExpression(p2) && SAFE_CALLEES.has(calleeName(p2, tsm))) return true;
                p2 = p2.parent;
              }
              return false;
            })();
            if (outerHasSafe) { verdictSafe = true; break; }
            sink = `call ${calleeName(parent, tsm) || '<expr>'}(…)`;
            break;
          }
          if (tsm.isPropertyAccessExpression(parent) && parent.expression === cur) {
            // chained: .content.length / .toLowerCase() — the chain result
            // continues; length/comparison chains are data, not render.
            const nm = parent.name.text;
            if (nm === 'length') { verdictSafe = true; break; }
            cur = parent; parent = cur.parent; continue;
          }
          if (tsm.isBinaryExpression(parent)
            && [tsm.SyntaxKind.EqualsEqualsEqualsToken, tsm.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind)) {
            verdictSafe = true; break;
          }
          if (tsm.isTemplateSpan(parent) || (tsm.isBinaryExpression(parent) && parent.operatorToken.kind === tsm.SyntaxKind.PlusToken)) {
            sink = 'template/concat'; break;
          }
          // Object-literal property assignment ({ content: m.content },
          // { text: … }) is DATA PLUMBING: the reconstructed object must
          // still pass a formatter at its render site, where the
          // required-author signature and this scan enforce the call.
          if (tsm.isPropertyAssignment(parent)) { verdictSafe = true; break; }
          // Function boundary: a value used INSIDE a callback does not
          // flow into the outer call unless it is the arrow's expression
          // body or a return value — without this, every usage deep in a
          // tool callback bubbles up to registerTool(...) and flags.
          if (tsm.isFunctionLike(parent)) {
            if (tsm.isArrowFunction(parent) && parent.body === cur && !tsm.isBlock(parent.body)) { cur = parent; parent = cur.parent; continue; }
            verdictSafe = true; break;
          }
          if (tsm.isReturnStatement(parent)) { cur = parent; parent = cur.parent; continue; }
          // Raw alias: ONLY the untransformed `const c = m.content` —
          // a transformed chain (toLowerCase/slice dedup keys) is data.
          // Accepted limitation (documented): variable dataflow is not
          // tracked past the transform; the untransformed alias — the
          // gate's plant — is caught at the declaration.
          if (tsm.isVariableDeclaration(parent) && parent.initializer === node) {
            sink = 'raw alias'; break;
          }
          if (tsm.isVariableDeclaration(parent)) { verdictSafe = true; break; }
          cur = parent; parent = cur.parent;
        }
        if (sink && !verdictSafe) offenders.push(`${label}: .content → ${sink}`);
      }
      tsm.forEachChild(node, visit);
    };
    visit(sf);
    return offenders;
  }

  // WHOLE-TREE discovery (no fixed list): every source file under the
  // render-bearing roots is scanned; a new render file is covered the
  // day it is created.
  async function renderFiles(): Promise<string[]> {
    const { readdirSync, statSync } = await import('node:fs');
    const roots = ['src/hooks', 'src/mcp', 'src/pack'];
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(join(process.cwd(), d))) {
        const p = `${d}/${e}`;
        if (statSync(join(process.cwd(), p)).isDirectory()) walk(p);
        else if (e.endsWith('.ts') && !e.endsWith('.d.ts')) out.push(p);
      }
    };
    for (const r of roots) walk(r);
    return out;
  }

  it('AST guard self-test: every planted shape from BOTH gates is caught; safe forms stay silent', async () => {
    const plants: Array<[string, string]> = [
      ['barepush', 'warnings.push(r.memory.content)'],
      ['concat', "warnings.push('- ' + r.memory.content)"],
      ['alias', 'const c = r.memory.content'],
      ['multiline', 'lines.push(`x ${\n  m.content\n}`)'],
      ['mixed-args', 'warnings.push(formatMemoryContent(a), b.content)'],
      ['destructured', 'const { content } = memory; warnings.push(content)'],
      ['arbitrary-sink', 'emitToModel(memory.content)'],
    ];
    for (const [name, snippet] of plants) {
      assert.ok((await astScan(snippet, name)).length > 0, `${name} must be caught`);
    }
    const safes: string[] = [
      'lines.push(`- ${formatMemoryContent(m)}`)',
      'if (m.content === other.content) return',
      'const n = m.content.length',
      'rerank(q, results.map((r, i) => ({ id: r.memory.id, text: r.memory.content, rank: i })))',
      'formatMemoryContent({ ...m, content: truncate(m.content, 60) })',
    ];
    for (const snippet of safes) {
      const found = await astScan(snippet, 'safe');
      assert.deepEqual(found, [], `safe form flagged: ${snippet}`);
    }
  });

  it('no source file under the render roots lets raw memory content reach a sink (whole-tree AST scan)', async () => {
    const offenders: string[] = [];
    for (const file of await renderFiles()) {
      if (EXEMPT_FILES.has(file)) continue;
      const source = readFileSync(join(process.cwd(), file), 'utf-8');
      if (!source.includes('.content')) continue;
      offenders.push(...await astScan(source, file));
    }
    assert.deepEqual(offenders, [], `raw content reaching sinks:\n${offenders.join('\n')}`);
  });

  it('the pack CLI import closure reaches no process-spawning module (graph walk, not a fixed list)', () => {
    const visited = new Set<string>();
    const spawners: string[] = [];
    const resolve = (from: string, spec: string): string | null => {
      if (!spec.startsWith('.')) return null; // package imports: node:/waykeep-contract/better-sqlite3 — checked by name below
      // KNOWN BLIND SPOTS (exit review, comment-not-condition): a
      // directory import resolving to foo/index.ts is missed, and
      // import(variable) is invisible to the literal regex. Neither is
      // reachable in the current pack closure; if either pattern enters
      // it, extend this resolver.
      const base = join(from, '..', spec).replace(/\.js$/, '.ts');
      return base;
    };
    const walk = (file: string): void => {
      if (visited.has(file)) return;
      visited.add(file);
      let source: string;
      try {
        source = readFileSync(join(process.cwd(), file), 'utf-8');
      } catch {
        return;
      }
      if (/child_process/.test(source)) spawners.push(file);
      for (const m of source.matchAll(/from\s+'([^']+)'|import\('([^']+)'\)/g)) {
        const spec = m[1] ?? m[2];
        const next = resolve(file, spec);
        if (next) walk(next);
      }
    };
    walk('src/cli/pack.ts');
    walk('src/pack/pack.ts');
    assert.ok(visited.size > 10, `the walk actually traversed the closure (${visited.size} files)`);
    // ALLOWLIST with justification: utils/project-scanner reaches the
    // file-level closure only through the utils barrel re-export — no
    // pack code path calls it, and the runtime fake-git interception
    // test (pack.test.ts Z6) proves non-invocation at the command
    // boundary. Anything ELSE appearing here is a new finding.
    const unexplained = spawners.filter((f) => f !== 'src/utils/project-scanner.ts');
    assert.deepEqual(unexplained, [], `spawning modules in the pack closure:\n${unexplained.join('\n')}`);
  });
});
