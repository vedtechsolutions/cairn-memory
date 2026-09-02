#!/usr/bin/env node
/**
 * Store-mutation-free recall replay (remediation plan, step 0b).
 *
 * Replays a query against a SNAPSHOT of a store and prints, per retrieval
 * path, the ordinal rank, full-precision score, and row identity — the three
 * things the MCP output historically collapsed.
 *
 * Guarantees (scoped precisely):
 *  - The SOURCE database cannot be written: it is opened `{readonly:true}`
 *    and copied via the SQLite online-backup API, which takes shared locks
 *    and restarts if a live WAL writer interferes — a completed snapshot is
 *    consistent.
 *  - The SNAPSHOT cannot be written past setup: `PRAGMA query_only=ON` makes
 *    any write attempt THROW (enforcement), and table fingerprints for
 *    memories + co-recall/session/user-model tables are compared before and
 *    after (verification). Both must hold or the tool exits 1.
 *  - NOT covered by "side-effect-free": `--embed` may populate the local
 *    HuggingFace model cache on first use. That is a filesystem cache, not
 *    store state.
 *
 * Fidelity note — this replays the RANKING stages only. It deliberately does
 * NOT replay MCP post-processing: project resolution, private-scope policy,
 * cross-project fingerprint guard, reranking, or graph enrichment. Ranks
 * printed here are `repo.recall` / `repo.recallHybrid` order under the same
 * candidate arithmetic as production (limit × FINGERPRINT.CANDIDATE_MULTIPLIER)
 * — compare like with like, and do not quote these as end-to-end MCP output.
 *
 * Why it exists: live `waykeep_recall` mutates recall telemetry, which feeds
 * decay stability — measuring the store through MCP changes the store (it
 * did, during the incident investigation). All remediation measurement goes
 * through THIS tool.
 *
 * Usage:
 *   node scripts/recall-replay.mjs --query "text"            # live store snapshot, FTS path
 *   node scripts/recall-replay.mjs --query "text" --embed    # + real hybrid path (loads model)
 *   node scripts/recall-replay.mjs --query "text" --db /path/to.db --project <id> --limit 10
 *   node scripts/recall-replay.mjs --query "text" --pin /path/snapshot.db   # freeze a snapshot for reuse
 *
 * Reproducibility: --pin writes the snapshot to a STABLE path and keeps it;
 * later runs pass it via --db, so a measurement series shares one frozen
 * store instead of re-snapshotting a moving live DB. The display --limit
 * never changes the candidate pool (fixed at the reference arithmetic), so
 * ranks are comparable across invocations; --pool exists only for
 * deliberately studying pool-size effects.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import DatabaseCtor from 'better-sqlite3';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const { openDatabase } = await import(join(REPO, 'dist', 'src', 'db', 'connection.js'));
const { MemoryRepository } = await import(join(REPO, 'dist', 'src', 'db', 'memory-repository.js'));
const { FINGERPRINT } = await import(join(REPO, 'dist', 'src', 'constants', 'index.js'));
// THE coherent state root (Phase B): defaulting to the CURRENT dir would
// measure an empty/absent ~/.waykeep while the user's real store still lives
// under the un-migrated ~/.cairn — the same fork hazard the resolver exists to
// prevent (codex B1 review). Resolve the marker-aware root every process uses.
const { resolveStateRoot } = await import(join(REPO, 'dist', 'src', 'constants', 'paths.js'));

const args = process.argv.slice(2);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const query = val('--query');
if (!query) { console.error('usage: recall-replay.mjs --query "text" [--db path] [--project id] [--limit n] [--embed]'); process.exit(2); }
const _root = resolveStateRoot();
const srcPath = val('--db') ?? join(_root.dir, _root.dbFilename);
if (!existsSync(srcPath)) { console.error(`recall-replay: no store at ${srcPath} — pass --db at an existing store.`); process.exit(1); }
const project = val('--project');
const limit = Number(val('--limit') ?? 10);
// The candidate POOL is fixed independently of the display limit: pool size
// changes FTS candidate admission and therefore ranks, so tying it to
// --limit made measurements incomparable across invocations (review F3 —
// the lesson ranked #3 at --limit 3 but #5 at --limit 5). Default mirrors
// the production arithmetic at the reference limit of 10; override with
// --pool only when deliberately studying pool-size effects.
const REFERENCE_LIMIT = 10;
const pool = Number(val('--pool') ?? NaN);
const wantEmbed = args.includes('--embed');

/** Tables whose mutation would falsify a measurement. */
const GUARDED_TABLES = ['memories', 'memory_corecall', 'session_memories', 'user_model'];

const pinPath = val('--pin');
const workDir = mkdtempSync(join(tmpdir(), 'recall-replay-'));
let db = null;
let exitCode = 0;

try {
  // --- snapshot: read-only source + online backup ---------------------------
  const snapPath = pinPath ?? join(workDir, 'snapshot.db');
  {
    const src = new DatabaseCtor(srcPath, { readonly: true });
    try { await src.backup(snapPath); } finally { src.close(); }
  }

  // openDatabase may run idempotent schema maintenance, so open FIRST, then
  // lock the connection: after this pragma, any write attempt throws.
  db = openDatabase({ dbPath: snapPath });
  db.pragma('query_only = ON');
  const repo = new MemoryRepository(db);

  const tableFingerprint = (t) => {
    try {
      return JSON.stringify(db.prepare(`SELECT COUNT(*) AS n, TOTAL(rowid) AS r FROM "${t}"`).get());
    } catch { return 'absent'; }
  };
  const fingerprints = () => Object.fromEntries(GUARDED_TABLES.map(t => [t, tableFingerprint(t)]));
  const telemetry = () => db.prepare(
    "SELECT COALESCE(SUM(recall_count),0) AS recalls, COUNT(last_recalled) AS stamped, MAX(COALESCE(last_recalled, '')) AS newest FROM memories",
  ).get();

  const render = (label, rows) => {
    console.log(`\n== ${label} ==`);
    rows.slice(0, limit).forEach(({ memory: m, score }, i) => {
      const scope = m.project ? `[${m.project}]` : '[global]';
      console.log(
        `  #${String(i + 1).padStart(2)}  score=${score.toFixed(6)}  conf=${m.confidence.toFixed(3)}  ` +
        `${m.kind}/${m.source}  ${scope}  ${m.id.slice(0, 8)}  ${m.content.replace(/\s+/g, ' ').slice(0, 70)}`,
      );
    });
    if (rows.length === 0) console.log('  (no results)');
  };

  const before = { tel: telemetry(), fp: fingerprints() };
  const poolSize = Number.isFinite(pool) ? pool : REFERENCE_LIMIT * FINGERPRINT.CANDIDATE_MULTIPLIER;
  console.log(`[candidate pool: ${poolSize} (reference limit ${REFERENCE_LIMIT} × multiplier); display limit: ${limit}]`);
  const opts = { project: project ?? null, maxResults: poolSize, readOnly: true };

  render('FTS path (repo.recall — the degraded/cold-start ordering)', repo.recall(query, opts));

  if (wantEmbed) {
    const { warmupEmbeddings, embedQuery, embeddingToBuffer } =
      await import(join(REPO, 'dist', 'src', 'utils', 'embeddings.js'));
    process.stderr.write('[loading embedding model…]\n');
    await warmupEmbeddings();
    const qEmb = embeddingToBuffer(await embedQuery(query));
    render('HYBRID path (recallHybrid — fts+vector, rrf)', repo.recallHybrid(query, qEmb, opts));
  } else {
    console.log('\n(hybrid path skipped — pass --embed to load the local model and compare)');
  }

  console.log('\n[not replayed: scope policy, private filter, fingerprint guard, rerank, graph enrichment]');

  // --- verification (query_only=ON above is the enforcement) ----------------
  const after = { tel: telemetry(), fp: fingerprints() };
  const drift = [];
  if (JSON.stringify(after.tel) !== JSON.stringify(before.tel)) drift.push(`telemetry ${JSON.stringify(before.tel)} -> ${JSON.stringify(after.tel)}`);
  for (const t of GUARDED_TABLES) {
    if (before.fp[t] !== after.fp[t]) drift.push(`table ${t}: ${before.fp[t]} -> ${after.fp[t]}`);
  }
  if (drift.length > 0) {
    console.error('\nFATAL: replay mutated snapshot state despite query_only=ON — fix before trusting ANY measurement:\n  ' + drift.join('\n  '));
    exitCode = 1;
  } else {
    console.log(`[verified: query_only=ON held; telemetry and ${GUARDED_TABLES.join('/')} fingerprints unchanged]`);
  }
} catch (err) {
  console.error(`recall-replay: ${err?.message ?? err}`);
  exitCode = 1;
} finally {
  try { db?.close(); } catch { /* already closed */ }
  rmSync(workDir, { recursive: true, force: true });
}
process.exit(exitCode);
