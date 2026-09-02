/**
 * Step-4 remediation of the truncation-polluted rows (plan of record:
 * docs/plans/2026-09-02-memory-remediation-plan.md, mechanism M4).
 *
 * The 88 rows: content EXACTLY 200 chars ending '...' — the old extractors'
 * `slice(0,197) + '...'` signature. They are prefixes of pasted text, not
 * lessons; 70 of the 83 decisions carry no capture trigger at all (there is
 * nothing to recover — an update would fabricate), so the action of record
 * is INVALIDATE (tombstone-journaled soft delete via the repository API).
 * `cairn_correct update` is FORBIDDEN by the plan: it would preserve the
 * contaminated recall telemetry under fresh content (a strengthened husk).
 *
 * Modes (dry by default — NOTHING writes to the live store without --live):
 *   --manifest out.json            build the classification manifest from a
 *                                  fresh READ-ONLY snapshot of the live DB
 *   --manifest out.json --db P     ...from an explicit snapshot path
 *   --apply manifest.json          DRY-RUN the application against live
 *   --apply manifest.json --live   apply for real (per-row guards: id must
 *                                  exist, content sha must match, row still
 *                                  active; drifted rows are SKIPPED loudly)
 *   --verify manifest.json         post-apply check on a fresh snapshot
 *
 * Classification (mechanical, current post-step-1 shapes):
 *   kind=correction                    → invalidate (raw prompts stored as corrections)
 *   isPastedShape(content)             → invalidate (attribution envelope / glyphs)
 *   decision + no extractor output     → invalidate (trigger absent — nothing to keep)
 *   decision + extractor still fires   → hand_review (a human judgment call,
 *                                        recorded per row in the manifest)
 */
import { mkdtempSync } from 'node:fs';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import DatabaseCtor from 'better-sqlite3';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const { openDatabase } = await import(join(REPO, 'dist', 'src', 'db', 'connection.js'));
const { MemoryRepository } = await import(join(REPO, 'dist', 'src', 'db', 'memory-repository.js'));
const { isPastedShape } = await import(join(REPO, 'dist', 'src', 'hooks', 'shared', 'capture-shapes.js'));
const { extractDecision } = await import(join(REPO, 'dist', 'src', 'hooks', 'handlers', 'prompt', 'extractors.js'));
const { extractAssistantDecision } = await import(join(REPO, 'dist', 'src', 'hooks', 'shared', 'transcript', 'decision-extraction.js'));
const { DATA_DIR_NAME, DB_FILENAME } = await import(join(REPO, 'packages', 'contract', 'dist', 'identity.js'));

const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const has = (f) => args.includes(f);

const LIVE_PATH = join(homedir(), DATA_DIR_NAME, DB_FILENAME);
/** The one length-matching row that is NOT truncated (verified complete in
 *  the M4 analysis) — a hard guard, never remediated. */
const COMPLETE_ROW_PREFIX = 'e7b4cb84';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

const SIGNATURE_SQL = `
  SELECT id, kind, project, confidence, source, recall_count, last_recalled,
         created_at, content
  FROM memories
  WHERE invalidated = 0
    AND length(content) = 200
    AND substr(content, 198, 3) = '...'
  ORDER BY created_at`;

function classify(row) {
  if (row.id.startsWith(COMPLETE_ROW_PREFIX)) {
    throw new Error(`guard: ${COMPLETE_ROW_PREFIX}* matched the signature — it must not (verified complete)`);
  }
  const pasted = isPastedShape(row.content);
  if (row.kind === 'correction') {
    return {
      action: 'invalidate',
      bucket: 'correction',
      rationale: 'raw prompt stored as a correction at conf 0.9 — the trigger phrase lived outside the stored prefix; nothing distilled to keep'
        + (pasted ? ' (also carries pasted-shape markers)' : ''),
    };
  }
  if (pasted) {
    return {
      action: 'invalidate',
      bucket: 'pasted_shape',
      rationale: 'content carries attribution-envelope/transcript markers — pasted material, never an authored decision',
    };
  }
  // Decision rows: would the CURRENT decision extractors still capture this
  // content? extractCorrectionLesson is deliberately NOT consulted here: it
  // assumes its caller already matched a correction trigger (intent-router
  // gates it on CORRECTION_TRIGGER_PATTERNS) and returns the whole text for
  // anything ≤200 chars — every signature row is exactly 200, so using it
  // standalone marks everything trigger-present (first manifest build made
  // exactly that mistake: 60 false trigger_present rows).
  const userHit = extractDecision(row.content);
  const assistantHit = extractAssistantDecision(row.content);
  const trigger = userHit ?? assistantHit;
  if (!trigger) {
    return {
      action: 'invalidate',
      bucket: 'trigger_absent',
      rationale: 'no current capture pattern fires on the stored content — a 197-char prefix of unrelated text with no decision/rationale to recover',
    };
  }
  return {
    action: 'hand_review',
    bucket: 'trigger_present',
    rationale: `a current extractor still fires on the stored content (extracted: ${JSON.stringify(trigger.slice(0, 120))}) — human judgment recorded below`,
    extracted: trigger,
  };
}

function snapshot(srcPath) {
  const workDir = mkdtempSync(join(tmpdir(), 'remediate-'));
  const snapPath = join(workDir, 'snapshot.db');
  const src = new DatabaseCtor(srcPath, { readonly: true });
  return src.backup(snapPath).then(() => { src.close(); return snapPath; })
    .catch((e) => { src.close(); throw e; });
}

// ---------------------------------------------------------------------------
if (val('--manifest')) {
  const srcPath = val('--db') ?? LIVE_PATH;
  const snapPath = await snapshot(srcPath);
  const db = openDatabase({ dbPath: snapPath });
  db.pragma('query_only = ON');
  const rows = db.prepare(SIGNATURE_SQL).all();
  const manifest = {
    built_at: new Date().toISOString(),
    source_db: srcPath,
    signature: 'length(content)=200 AND content ends "..." AND invalidated=0',
    rows: rows.map((r) => ({
      id: r.id, kind: r.kind, project: r.project, confidence: r.confidence,
      source: r.source, recall_count: r.recall_count, last_recalled: r.last_recalled,
      created_at: r.created_at, content: r.content, content_sha256: sha(r.content),
      ...classify(r),
    })),
  };
  const counts = {};
  for (const r of manifest.rows) counts[r.bucket] = (counts[r.bucket] ?? 0) + 1;
  manifest.summary = { total: manifest.rows.length, by_bucket: counts };
  writeFileSync(val('--manifest'), JSON.stringify(manifest, null, 2));
  console.log(`manifest: ${manifest.rows.length} rows → ${val('--manifest')}`);
  console.log('buckets:', JSON.stringify(counts));
  db.close();
  process.exit(0);
}

// ---------------------------------------------------------------------------
if (val('--apply')) {
  const manifest = JSON.parse(readFileSync(val('--apply'), 'utf8'));
  const live = has('--live');
  // --target overrides the write target (hermetic tests use a fixture DB);
  // without it, --live writes THE live store — the one sanctioned write of
  // this remediation.
  const TARGET = val('--target') ?? LIVE_PATH;
  const targets = manifest.rows.filter((r) => r.action === 'invalidate');
  const pending = manifest.rows.filter((r) => r.action === 'hand_review');
  if (pending.length > 0) {
    console.error(`REFUSED: ${pending.length} rows still marked hand_review — resolve them to 'invalidate' or 'keep' (with hand_review_reason) first`);
    process.exit(2);
  }
  const db = live ? openDatabase({ dbPath: TARGET }) : null;
  const check = live ? db : openDatabase({ dbPath: await snapshot(TARGET) });
  if (!live) check.pragma('query_only = ON');
  const repo = live ? new MemoryRepository(db) : null;

  // Preflight (codex review, drift item): the store may have grown NEW
  // signature rows since the manifest — refuse rather than remediate blind.
  const manifestIds = new Set(manifest.rows.map((r) => r.id));
  const liveSignature = check.prepare(SIGNATURE_SQL).all();
  const unknown = liveSignature.filter((r) => !manifestIds.has(r.id));
  if (unknown.length > 0) {
    for (const u of unknown) console.error(`UNKNOWN signature row not in manifest: ${u.id} [${u.kind}]`);
    console.error('REFUSED: re-run --manifest against the current store first');
    process.exit(2);
  }

  const receipt = { applied_at: new Date().toISOString(), target: TARGET, live, rows: [] };
  let applied = 0, drifted = 0, gone = 0, replaced = 0;
  // Per-row IMMEDIATE transaction (codex review, atomicity item): the CAS
  // re-read, the invalidation, and the replacement insert commit together
  // or not at all — a crash can never leave an invalidated ancestor with
  // its replacement missing, and the CAS covers content AND scope (project,
  // kind), not content alone. Nested repo transactions become savepoints.
  const applyRow = live ? db.transaction((r) => {
    const row = db.prepare('SELECT content, project, kind, invalidated, confidence FROM memories WHERE id = ?').get(r.id);
    if (!row) return { status: 'gone' };
    if (row.invalidated !== 0) return { status: 'already' };
    if (sha(row.content) !== r.content_sha256 || row.project !== r.project || row.kind !== r.kind) {
      return { status: 'drifted' };
    }
    if (!repo.invalidate(r.id)) return { status: 'failed' };
    let replacement = null;
    if (r.replacement) {
      // Fresh row, zero telemetry, LIVE confidence and LIVE project (no
      // resurrection, no stale scope); skipDedup + skipConflictDetection:
      // a sanctioned manifest apply writes NOTHING outside the manifest —
      // no merges into active rows, no supersessions, no edges.
      const created = repo.create({
        content: r.replacement.content,
        kind: 'decision',
        project: row.project,
        source: 'learned',
        confidence: row.confidence,
        skipDedup: true,
        skipConflictDetection: true,
      });
      replacement = { id: created.id, content: r.replacement.content, project: row.project, confidence: row.confidence };
    }
    return { status: 'applied', replacement };
  }).immediate : null;

  try {
    for (const r of targets) {
      if (live) {
        const res = applyRow(r);
        if (res.status === 'gone') { console.log(`GONE     ${r.id}`); gone++; }
        else if (res.status === 'already') { console.log(`ALREADY  ${r.id}`); gone++; }
        else if (res.status === 'drifted') { console.log(`DRIFTED  ${r.id} — content/project/kind changed since manifest; SKIPPED`); drifted++; }
        else if (res.status === 'failed') { console.log(`FAILED   ${r.id}`); }
        else {
          console.log(`INVALID  ${r.id} [${r.bucket}]`);
          applied++;
          if (res.replacement) {
            console.log(`REPLACED ${r.id} → ${res.replacement.id} conf=${res.replacement.confidence}`);
            replaced++;
          }
        }
        receipt.rows.push({ ancestor: r.id, bucket: r.bucket, status: res.status, replacement: res.replacement ?? null });
      } else {
        const row = check.prepare('SELECT content, project, kind, invalidated, confidence FROM memories WHERE id = ?').get(r.id);
        if (!row) { console.log(`GONE     ${r.id}`); gone++; continue; }
        if (row.invalidated !== 0) { console.log(`ALREADY  ${r.id}`); gone++; continue; }
        if (sha(row.content) !== r.content_sha256 || row.project !== r.project || row.kind !== r.kind) {
          console.log(`DRIFTED  ${r.id} — content/project/kind changed since manifest; SKIPPED`); drifted++; continue;
        }
        console.log(`WOULD    ${r.id} [${r.bucket}] conf=${row.confidence} recalls=${r.recall_count}`);
        if (r.replacement) { console.log(`  +REPLACE @conf=${row.confidence}: ${JSON.stringify(r.replacement.content.slice(0, 100))}…`); replaced++; }
        applied++;
      }
    }
  } finally {
    if (live) {
      const receiptPath = val('--receipt') ?? join(dirname(val('--apply')), 'receipt.json');
      writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
      console.log(`receipt → ${receiptPath}`);
    }
  }
  const kept = manifest.rows.filter((r) => r.action === 'keep');
  console.log(`\n${live ? 'APPLIED' : 'DRY-RUN'}: ${applied} invalidated, ${replaced} replacements stored, ${kept.length} kept (hand review), ${drifted} drifted-skipped, ${gone} gone/already`);
  (live ? db : check).close();
  process.exit(drifted > 0 ? 1 : 0);
}

// ---------------------------------------------------------------------------
if (val('--verify')) {
  const manifest = JSON.parse(readFileSync(val('--verify'), 'utf8'));
  const snapPath = await snapshot(val('--target') ?? LIVE_PATH);
  const db = openDatabase({ dbPath: snapPath });
  db.pragma('query_only = ON');
  let ok = 0, bad = 0;
  for (const r of manifest.rows) {
    const row = db.prepare('SELECT invalidated FROM memories WHERE id = ?').get(r.id);
    const expectInvalid = r.action === 'invalidate';
    const isInvalid = !row || row.invalidated !== 0;
    if (expectInvalid === isInvalid) ok++;
    else { console.log(`MISMATCH ${r.id}: action=${r.action} live_invalidated=${row ? row.invalidated : 'gone'}`); bad++; }
    // Tombstone: every applied invalidation must have journaled one.
    if (expectInvalid && isInvalid) {
      const tomb = db.prepare('SELECT COUNT(*) AS n FROM memory_tombstones WHERE memory_id = ?').get(r.id);
      if (!tomb || tomb.n === 0) { console.log(`NO-TOMBSTONE ${r.id}`); bad++; }
    }
  }
  // Receipt verification (codex review): --verify alone cannot see a missing
  // or wrong replacement; the receipt written by --apply --live can.
  const receiptPath = val('--receipt');
  if (receiptPath) {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    for (const row of receipt.rows) {
      if (row.status !== 'applied' || !row.replacement) continue;
      const live = db.prepare('SELECT content, project, source, confidence, invalidated, superseded_by, recall_count FROM memories WHERE id = ?').get(row.replacement.id);
      if (!live) { console.log(`REPL-MISSING ${row.replacement.id} (ancestor ${row.ancestor})`); bad++; continue; }
      if (live.invalidated !== 0) { console.log(`REPL-INVALIDATED ${row.replacement.id}`); bad++; continue; }
      // Active means the full eligibility definition — a concurrently
      // superseded replacement is NOT serving (codex v2 review).
      if (live.superseded_by) { console.log(`REPL-SUPERSEDED ${row.replacement.id} by ${live.superseded_by}`); bad++; continue; }
      if (live.content !== row.replacement.content) { console.log(`REPL-CONTENT-DRIFT ${row.replacement.id}`); bad++; continue; }
      if (live.project !== row.replacement.project) { console.log(`REPL-PROJECT ${row.replacement.id}`); bad++; continue; }
      if (Math.abs(live.confidence - row.replacement.confidence) > 1e-6) { console.log(`REPL-CONFIDENCE ${row.replacement.id}: ${live.confidence} vs ${row.replacement.confidence}`); bad++; continue; }
      ok++;
    }
  }
  const residue = db.prepare(SIGNATURE_SQL).all();
  console.log(`verify: ${ok} match, ${bad} mismatch; signature rows still active: ${residue.length}`);
  for (const r of residue) console.log(`  RESIDUE ${r.id} [${r.kind}]`);
  db.close();
  // Residue is a failure too (codex review): new signature rows mean the
  // capture path regressed or the manifest is stale — never exit 0 on it.
  process.exit(bad > 0 || residue.length > 0 ? 1 : 0);
}

console.error('usage: remediate-truncated.mjs --manifest out.json [--db path] | --apply manifest.json [--live] | --verify manifest.json');
process.exit(2);
