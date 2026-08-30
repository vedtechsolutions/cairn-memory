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
  // Sanctioned callees: name → constraints. `receiver` pins the call to
  // a receiver expression (JSON.stringify — 'stringify' alone redeems
  // nothing). `home` names the ONE file allowed to declare the name
  // locally (pack's own clean); ANY other file that declares a safe name
  // locally forfeits redemption for it — a local shadow named
  // formatMemoryContent must not launder (Codex e129fd3 #2).
  const SAFE_CALLEES = new Map<string, { receiver?: string; home?: string }>([
    ['formatMemoryContent', {}], ['formatAuxText', {}],
    // The neutralization PRIMITIVE itself (marker stripping) — what
    // formatMemoryContent calls internally; used directly on ingest.
    ['neutralizeMemoryText', {}],
    // JSON escaping neutralizes newlines (LINE_LEADING cannot fire);
    // pack files re-enter through the learn pipeline (scrub-on-import).
    ['stringify', { receiver: 'JSON' }],
    ['clean', { home: 'src/pack/pack.ts' }],
    ['safeExcerpt', {}],
    // Predicates and scoring/query consumers — content as INPUT only.
    ['isCompletedDecision', {}], ['isCorrectionQuality', {}], ['isMemoryEligibleForInjection', {}],
    ['isResolvedPitfallContent', {}], ['tokeniseForOverlap', {}], ['buildFtsQuery', {}], ['isMetaGoal', {}],
    ['rerank', {}], ['extractWinningPattern', {}], ['generateFingerprint', {}], ['search', {}], ['findSimilarTo', {}],
    ['scanForRawContent', {}], ['contentsOppose', {}], ['tokenOverlap', {}], ['embed', {}],
    ['storeVersion', {}], ['isSystemContent', {}], ['extractWhyContext', {}], ['computeEffectiveness', {}],
    // Repository/storage WRITES — ingestion input (the write layer scrubs).
    ['create', {}], ['storeDecision', {}], ['storePitfall', {}], ['storeMemory', {}], ['learnSections', {}], ['update', {}],
  ]);
  // TRANSPARENT callees carry their input VALUE into their result — the
  // walk continues to the transform's own consumer instead of stopping.
  // This replaces both truncate/clip-as-safe (they shorten, they do not
  // make text render-safe — Codex e129fd3 #2) and outerHasSafe (which
  // redeemed side-effect sinks like rerank(emitToModel(x))).
  const TRANSPARENT_CALLEES = new Set(['map', 'flatMap', 'truncate', 'clip']);

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
    // lands via repo.create — the scrub-on-write layer. NOTE (Claude
    // gate): because the whole file is exempt, a future RENDER of a
    // memory row from this file would be invisible to the guard — if
    // decision-reflector ever renders, narrow this to SAFE_SITES.
    'src/hooks/shared/decision-reflector.ts',
  ]);
  // LINE-LEVEL exemptions (narrower than EXEMPT_FILES): the exact source
  // text of a flagged statement, per file, each with a justification. If
  // the line changes AT ALL the exemption stops matching and the flag
  // returns — a reviewable, self-expiring allowlist.
  const SAFE_SITES: Array<{ file: string; snippet: string; why: string }> = [
    {
      file: 'src/mcp/tools/governance-tools.ts',
      snippet: 'const content = elicited.content as Record<string, unknown> | undefined;',
      why: 'MCP ELICITATION response envelope (confirm/reason dialog), not a stored memory row — same class as decision-reflector\'s sampling envelope.',
    },
    {
      file: 'src/hooks/handlers/error-learning-handler.ts',
      snippet: 'const contentLower = mem.content.toLowerCase();',
      why: 'Word-overlap SCORING between a pitfall and an error message — comparison consumer; nothing from this alias is rendered.',
    },
    {
      file: 'src/hooks/shared/briefing/memory-tier-renderers.ts',
      snippet: 'const prefix = d.content.toLowerCase().replace(/\\s+/g, \' \').slice(0, LIMITS.DECISION_DEDUP_PREFIX);',
      why: 'Dedup KEY (normalized prefix) used only in a Set membership test; the rendered line on the adjacent path goes through formatMemoryContent.',
    },
    {
      file: 'src/hooks/session-end.ts',
      snippet: 'content: row.content,',
      why: 'Consolidation-candidate assembly (row → Memory shape) consumed by scoring + repository writes (scrub-on-write); not a render path.',
    },
    {
      file: 'src/pack/pack.ts',
      snippet: 'content: rec.content,',
      why: 'Pack READ assembling PortableRecord data for the learn pipeline, which scrubs+neutralizes on import (canonicalize-once); not a render path.',
    },
  ];

  function calleeName(node: import('typescript').CallExpression, tsm: typeof import('typescript')): string {
    const e = node.expression;
    if (tsm.isIdentifier(e)) return e.text;
    if (tsm.isPropertyAccessExpression(e)) return e.name.text;
    return '';
  }

  function calleeReceiver(node: import('typescript').CallExpression, tsm: typeof import('typescript')): string {
    const e = node.expression;
    return tsm.isPropertyAccessExpression(e) ? e.expression.getText() : '';
  }

  async function astScan(source: string, label: string, safeSites: readonly { file: string; snippet: string }[] = []): Promise<string[]> {
    const tsm = (await import('typescript')).default;
    const sf = tsm.createSourceFile(label, source, tsm.ScriptTarget.Latest, true);
    const siteSnippets = safeSites.filter((x) => x.file === label).map((x) => x.snippet.trim());
    const offenders: string[] = [];
    const sourceLines = source.split('\n');
    // LINE-EXACT (Codex e129fd3 #1: the old top-level-statement
    // `includes` let the benign text shield every sink in the same
    // function — even from inside a comment): the flagged node's OWN
    // trimmed line must EQUAL the snippet, so a line that exempts
    // cannot also contain a sink.
    const atSafeSite = (n: import('typescript').Node): boolean => {
      const line = sourceLines[sf.getLineAndCharacterOfPosition(n.getStart()).line]?.trim() ?? '';
      return siteSnippets.includes(line);
    };
    // ANY local binding of a sanctioned name forfeits redemption for it
    // file-wide (Codex 943d023 #1: a PARAMETER, an object-literal
    // METHOD/function-valued property, or a class member named
    // formatMemoryContent launders exactly like a shadowing const —
    // and `const JSON = { stringify(x){…} }` forges the receiver pin).
    // The ONE exception: the home file's TOP-LEVEL declaration (pack's
    // own clean); a parameter named clean forfeits even there.
    // Transparent expression wrappers, by the COMPILER'S definition
    // (Codex ef30109 #1 ended the hand-rolled enumeration: parens, both
    // assertion spellings, satisfies, non-null, instantiation
    // expressions, partially-emitted — whatever TypeScript itself
    // treats as an outer expression, today and after grammar additions).
    // skipOuterExpressions is runtime-exported but not in the public
    // .d.ts; the manual loop is the fallback if an upgrade drops it —
    // and the instantiation/angle/satisfies PLANTS fail loudly if
    // either path stops unwrapping a spelling.
    type Unwrapper = (e: import('typescript').Expression, kinds: number) => import('typescript').Expression;
    const skipOuter = (tsm as unknown as { skipOuterExpressions?: Unwrapper }).skipOuterExpressions;
    const unwrap = (e: import('typescript').Expression): import('typescript').Expression => {
      if (skipOuter) return skipOuter(e, tsm.OuterExpressionKinds.All);
      while (tsm.isParenthesizedExpression(e) || tsm.isAsExpression(e)
        || tsm.isSatisfiesExpression(e) || tsm.isNonNullExpression(e)
        || tsm.isTypeAssertionExpression(e)
        || tsm.isExpressionWithTypeArguments(e)) e = e.expression;
      return e;
    };
    const foldKey = (raw: import('typescript').Expression): string | null => {
      const e = unwrap(raw);
      if (tsm.isStringLiteral(e) || tsm.isNoSubstitutionTemplateLiteral(e)) return e.text;
      // Template with literal-only substitutions is static too:
      if (tsm.isTemplateExpression(e)) {
        let out = e.head.text;
        for (const span of e.templateSpans) {
          const f = foldKey(span.expression);
          if (f === null) return null;
          out += f + span.literal.text;
        }
        return out;
      }
      if (tsm.isBinaryExpression(e) && e.operatorToken.kind === tsm.SyntaxKind.PlusToken) {
        const l = foldKey(e.left); const r = foldKey(e.right);
        return l !== null && r !== null ? l + r : null;
      }
      return null; // dynamic keys: KNOWN-UNCOVERED, asserted below
    };
    // Every STATIC spelling of a member/property name (Codex 19b1a89
    // #1: quoted and foldable-computed members are not dynamic keys).
    const staticName = (pn: import('typescript').PropertyName): string | null => {
      if (tsm.isIdentifier(pn) || tsm.isStringLiteral(pn) || tsm.isNoSubstitutionTemplateLiteral(pn)) return pn.text;
      if (tsm.isComputedPropertyName(pn)) return foldKey(pn.expression);
      return null; // PrivateIdentifier cannot collide with a bare call
    };
    const forfeited = new Set<string>();
    const forfeit = (nm: string | null): void => { if (nm !== null && SAFE_CALLEES.has(nm)) forfeited.add(nm); };
    // Recurse binding PATTERNS (Codex 5799d4b #1: `function f({
    // formatMemoryContent })` and `const { formatter: fmc } = deps`
    // bind names the flat identifier checks never saw).
    const forfeitBinding = (bn: import('typescript').BindingName): void => {
      if (tsm.isIdentifier(bn)) { forfeit(bn.text); return; }
      for (const el of bn.elements) {
        if (!tsm.isOmittedExpression(el)) forfeitBinding(el.name);
      }
    };
    const collect = (n: import('typescript').Node): void => {
      if (tsm.isParameter(n)) forfeitBinding(n.name);
      // Members in EVERY static spelling, accessors included (Codex
      // 19b1a89 #1); class FIELDS too (5799d4b #1: a method-to-field
      // refactor must not shed the forfeiture).
      if (tsm.isMethodDeclaration(n) || tsm.isPropertyDeclaration(n)
        || tsm.isGetAccessorDeclaration(n) || tsm.isSetAccessorDeclaration(n)) forfeit(staticName(n.name));
      if (tsm.isPropertyAssignment(n)) {
        const init = unwrap(n.initializer);
        if (tsm.isArrowFunction(init) || tsm.isFunctionExpression(init)) forfeit(staticName(n.name));
      }
      // Shorthand ({ rerank }) is NOT collected: its value IS the
      // in-scope binding of that name, so it launders only when that
      // binding is itself a shadow — which the recursive param/var/
      // function collectors forfeit.
      if (tsm.isFunctionDeclaration(n) && n.name
        && !(n.parent === sf && label === SAFE_CALLEES.get(n.name.text)?.home)) forfeit(n.name.text);
      if (tsm.isVariableDeclaration(n)) {
        if (tsm.isIdentifier(n.name)) {
          if (!(n.parent?.parent?.parent === sf && label === SAFE_CALLEES.get(n.name.text)?.home)) forfeit(n.name.text);
        } else forfeitBinding(n.name); // destructured declarations: no home exception
      }
      tsm.forEachChild(n, collect);
    };
    collect(sf);
    const redeems = (call: import('typescript').CallExpression): boolean => {
      const name = calleeName(call, tsm);
      const entry = SAFE_CALLEES.get(name);
      if (!entry) return false;
      if (entry.receiver && calleeReceiver(call, tsm) !== entry.receiver) return false;
      if (forfeited.has(name)) return false;
      return true;
    };
        // A binding's property name in every static spelling (Codex 943d023
    // #2: identifier, string-literal, and constant-foldable computed).
    const bindsContent = (el: import('typescript').BindingElement): boolean => {
      const pn = el.propertyName;
      if (!pn) return tsm.isIdentifier(el.name) && el.name.text === 'content';
      return staticName(pn) === 'content';
    };
    const visit = (node: import('typescript').Node): void => {
      // Destructured content alias: const { content } = memoryish.
      // PARAMETER destructuring (async ({ content }) => …, the MCP tool
      // input signature) is agent-authored INPUT, not a stored row —
      // only variable-declaration destructuring aliases a row field.
      if (tsm.isObjectBindingPattern(node)
        && tsm.isVariableDeclaration(node.parent)
        && node.elements.some(bindsContent)
        && !atSafeSite(node)) {
        offenders.push(`${label}: destructured content alias`);
      }
      const isContentAccess = (tsm.isPropertyAccessExpression(node) && node.name.text === 'content')
        || (tsm.isElementAccessExpression(node) && foldKey(node.argumentExpression) === 'content');
      if (isContentAccess) {
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
          if (tsm.isCallExpression(parent) && parent.arguments.includes(cur as import('typescript').Expression)) {
            if (redeems(parent)) { verdictSafe = true; break; }
            // TRANSPARENT transform: the value rides the RESULT to the
            // transform's own consumer. Anything else consuming the
            // value is a sink RIGHT HERE — no outer redemption (Codex
            // e129fd3 #2: rerank(emitToModel(x)) must flag at
            // emitToModel, not be laundered by rerank above it).
            if (TRANSPARENT_CALLEES.has(calleeName(parent, tsm))) { cur = parent; parent = cur.parent; continue; }
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
          // Assignment into an existing binding (`t = m.content`,
          // `s += m.content`) is the alias/concat problem in mutable
          // form — a sink, same as the declaration alias.
          if (tsm.isBinaryExpression(parent)
            && [tsm.SyntaxKind.EqualsToken, tsm.SyntaxKind.PlusEqualsToken,
              tsm.SyntaxKind.BarBarEqualsToken, tsm.SyntaxKind.AmpersandAmpersandEqualsToken,
              tsm.SyntaxKind.QuestionQuestionEqualsToken].includes(parent.operatorToken.kind)
            && parent.right === cur) {
            sink = 'assignment'; break;
          }
          if (tsm.isTemplateSpan(parent) || (tsm.isBinaryExpression(parent) && parent.operatorToken.kind === tsm.SyntaxKind.PlusToken)) {
            sink = 'template/concat'; break;
          }
          // Object-literal property assignment is TRANSPARENT, not safe
          // (Codex 7152d46 #1: `{ content: [{ text: m.content }] }` IS
          // the MCP output sink): the object flows onward — keep
          // walking to wherever the object itself goes.
          if (tsm.isPropertyAssignment(parent)) { cur = parent; parent = cur.parent; continue; }
          // A RETURNED value escapes its function (Codex 7152d46 #1:
          // `async () => { return m.content; }` flowed to registerTool
          // unseen): jump to the enclosing function-like node and keep
          // walking from ITS consumer.
          if (tsm.isReturnStatement(parent)) {
            let fn: import('typescript').Node | undefined = parent.parent;
            while (fn && !tsm.isFunctionLike(fn)) fn = fn.parent;
            if (!fn) { verdictSafe = true; break; } // top-level return: no consumer
            // A NAMED function returning raw content escapes to every
            // call site — interprocedural flow this walk cannot follow,
            // so it fails closed (a raw-content-returning helper is
            // exactly how a future render site inherits unwired text).
            const named = tsm.isFunctionDeclaration(fn) || tsm.isMethodDeclaration(fn)
              || tsm.isGetAccessorDeclaration(fn) || tsm.isSetAccessorDeclaration(fn)
              || tsm.isConstructorDeclaration(fn)
              || (tsm.isFunctionExpression(fn) && fn.name !== undefined);
            if (named) {
              sink = 'returned raw from a named function/accessor'; break;
            }
            cur = fn; parent = fn.parent; continue;
          }
          // Function boundary WITHOUT a return/expression-body escape:
          // the value is consumed (or discarded) inside; interior sinks
          // were already judged on the way up.
          if (tsm.isFunctionLike(parent)) {
            if (tsm.isArrowFunction(parent) && parent.body === cur && !tsm.isBlock(parent.body)) { cur = parent; parent = cur.parent; continue; }
            verdictSafe = true; break;
          }
          // ANY alias declaration is a finding — transformed chains too
          // (Codex 7152d46 #1: `const t = m.content.slice(); sink(t)`).
          // Variable dataflow is not tracked, so the declaration itself
          // fails closed; legitimate data-only sites carry a SAFE_SITES
          // entry with a per-line justification instead.
          if (tsm.isVariableDeclaration(parent) && parent.initializer === cur) {
            sink = 'alias declaration'; break;
          }
          if (tsm.isVariableDeclaration(parent)) { verdictSafe = true; break; }
          cur = parent; parent = cur.parent;
        }
        if (sink && !verdictSafe && !atSafeSite(node)) offenders.push(`${label}: .content → ${sink}`);
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
      // Codex 7152d46 #1 — the three demonstrated bypasses:
      ['alias-transform', 'const text = memory.content.slice(); emitToModel(text)'],
      ['callback-return', 'registerTool("x", async () => { return memory.content; })'],
      ['mcp-output-object', 'registerTool("x", async () => { return { content: [{ type: "text", text: memory.content }] }; })'],
      // Self-found classes (closing them before the gate does):
      ['element-access', 'emitToModel(memory["content"])'],
      ['assignment', 'let t = ""; t = memory.content; emitToModel(t)'],
      ['append-assignment', 'out += memory.content'],
      ['named-fn-raw-return', 'function getRaw(m) { return m.content; }'],
      // The Claude gate's 7152d46 blind shapes — closed by the e129fd3
      // hardening (transparent property assignments + all-alias rule):
      ['array-indirection', "warnings.push([m.content].join('\\n'))"],
      ['object-readback', 'const o = { t: m.content }; emitToModel(o.t)'],
      ['local-helper', 'const get = (m) => m.content; emitToModel(get(m))'],
      // Codex e129fd3 #2 — sanctioned-callee laundering:
      ['truncate-launder', 'emitToModel(truncate(memory.content, 60))'],
      ['inner-side-effect', 'rerank(emitToModel(memory.content))'],
      ['shadowed-formatter', 'function formatMemoryContent(x) { return x; }\nemitToModel(formatMemoryContent(memory.content))'],
      ['bare-stringify', 'emitToModel(stringify(memory.content))'],
      // Codex e129fd3 #3 — syntactic escapes:
      ['renamed-destructuring', 'const { content: text } = memory; emitToModel(text)'],
      ['folded-element-key', 'emitToModel(memory["con" + "tent"])'],
      ['template-element-key', 'emitToModel(memory[`content`])'],
      ['logical-assignment', 'let out = ""; out ||= memory.content; emitToModel(out)'],
      ['getter-return', 'class X { get raw() { return memory.content; } }'],
      // Codex 943d023 #1 — local-binding laundering:
      ['param-shadow', 'function f(formatMemoryContent) { emitToModel(formatMemoryContent(memory.content)); }'],
      ['object-method-shadow', 'const local = { formatMemoryContent(x) { return x; } }; emitToModel(local.formatMemoryContent(memory.content))'],
      ['receiver-forgery', 'const JSON = { stringify(x) { return x; } }; emitToModel(JSON.stringify(memory.content))'],
      ['arrow-property-shadow', 'const o = { clean: (x) => x }; emitToModel(o.clean(memory.content))'],
      // Codex 5799d4b #1 — binding-pattern and class-field shadows:
      ['destructured-param-shadow', 'function f({ formatMemoryContent }) { emitToModel(formatMemoryContent(memory.content)); }'],
      ['destructured-var-shadow', 'const { formatter: formatMemoryContent } = deps; emitToModel(formatMemoryContent(memory.content))'],
      ['class-field-shadow', 'class Local { formatMemoryContent = (x) => x; }\nconst local = new Local(); emitToModel(local.formatMemoryContent(memory.content))'],
      // Codex 19b1a89 #1 — quoted/accessor member spellings:
      ['quoted-class-field', 'class Local { "formatMemoryContent" = (x) => x; }\nemitToModel(local.formatMemoryContent(memory.content))'],
      ['quoted-class-method', 'class Local { "formatMemoryContent"(x) { return x; } }\nemitToModel(local.formatMemoryContent(memory.content))'],
      ['accessor-shadow', 'class Local { get formatMemoryContent() { return (x) => x; } }\nemitToModel(local.formatMemoryContent(memory.content))'],
      // Codex 67f6712 — wrapper-transparent static spellings:
      ['asserted-computed-member', 'const local = { ["formatMemoryContent" as const](x) { return x; } }; emitToModel(local.formatMemoryContent(memory.content))'],
      ['template-substitution-key', 'const { [`con${"tent"}`]: text } = memory; emitToModel(text)'],
      ['wrapped-property-fn', 'const local = { formatMemoryContent: ((x) => x) }; emitToModel(local.formatMemoryContent(memory.content))'],
      ['wrapped-receiver-forgery', 'const JSON = { stringify: ((x) => x) }; emitToModel(JSON.stringify(memory.content))'],
      // Codex 352bc11 — angle-bracket assertion spelling:
      ['angle-assert-member', 'const local = { [<const>"formatMemoryContent"](x) { return x; } }; emitToModel(local.formatMemoryContent(memory.content))'],
      ['angle-assert-key', 'const { [<const>"content"]: text } = memory; emitToModel(text)'],
      ['angle-assert-property-fn', 'const JSON = { stringify: <(x: unknown) => unknown>((x) => x) }; emitToModel(JSON.stringify(memory.content))'],
      // Codex ef30109 — instantiation-expression wrappers:
      ['instantiation-property-fn', 'const local = { formatMemoryContent: (<T>(x: T): T => x)<unknown> }; emitToModel(local.formatMemoryContent(memory.content))'],
      ['instantiation-receiver-forgery', 'const JSON = { stringify: (<T>(x: T): T => x)<unknown> }; emitToModel(JSON.stringify(memory.content))'],
      // Codex 943d023 #2 — static property-name spellings:
      ['string-key-destructuring', 'const { "content": text } = memory; emitToModel(text)'],
      ['computed-key-destructuring', 'const { ["con" + "tent"]: text } = memory; emitToModel(text)'],
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
      'const payload = JSON.stringify(m.content)',
    ];
    for (const snippet of safes) {
      const found = await astScan(snippet, 'safe');
      assert.deepEqual(found, [], `safe form flagged: ${snippet}`);
    }
    // The home exception covers ONLY the top-level declaration: a
    // parameter named clean forfeits even inside pack.ts itself.
    const homeParam = await astScan('function g(clean) { emitToModel(clean(memory.content)); }', 'src/pack/pack.ts', SAFE_SITES);
    assert.ok(homeParam.length > 0, 'a parameter named clean must forfeit in the home file');
  });

  it('SAFE_SITES is line-exact: the benign line shields neither a sink beside it nor one behind a comment (Codex e129fd3 #1)', async () => {
    for (const site of SAFE_SITES) {
      const beside = `function f() {\n${site.snippet}\nemitToModel(memory.content);\n}`;
      assert.ok((await astScan(beside, site.file, SAFE_SITES)).length > 0,
        `${site.file}: a sink beside the exempt line must flag`);
      const comment = `function f() { /* ${site.snippet} */ emitToModel(memory.content); }`;
      assert.ok((await astScan(comment, site.file, SAFE_SITES)).length > 0,
        `${site.file}: a comment cannot smuggle the exemption`);
    }
  });

  it('KNOWN-UNCOVERED shapes are stated, not implied closed', async () => {
    // A static per-file walk cannot follow dynamic keys or whole-object
    // escapes; the handler goldens + the required-author formatter
    // signature are the semantic backstop on covered paths. If one of
    // these starts flagging, MOVE it to the plants — do not delete it.
    const uncovered = [
      'const k = "content"; emitToModel(memory[k])',
      'emitToModel(memory)', // the whole row escapes, not the field
    ];
    for (const shape of uncovered) {
      assert.deepEqual(await astScan(shape, 'known-uncovered'), [],
        `documented limitation changed — reclassify: ${shape}`);
    }
  });

  it('no source file under the render roots lets raw memory content reach a sink (whole-tree AST scan)', async () => {
    const offenders: string[] = [];
    for (const file of await renderFiles()) {
      if (EXEMPT_FILES.has(file)) continue;
      const source = readFileSync(join(process.cwd(), file), 'utf-8');
      if (!source.includes('.content')) continue;
      offenders.push(...await astScan(source, file, SAFE_SITES));
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
