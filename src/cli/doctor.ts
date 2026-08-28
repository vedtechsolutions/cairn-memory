/**
 * `cairn doctor` — post-install health check.
 *
 * Verifies the pieces an install needs before the hooks or MCP server can
 * work: the Node runtime, the native SQLite stack, the compiled hook relay,
 * the embedding model pin, the database schema, and the hook socket. Each
 * check prints one actionable line; a failed critical check exits non-zero so
 * `cairn doctor` can gate CI and setup scripts. Diagnostic only — it never
 * creates or migrates the database.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SCHEMA_VERSION } from '../db/schema.js';
import { resolveDbPath } from '../db/db-path.js';
import { getEmbeddingModelConfig } from '../utils/embeddings.js';
import { verifyModelPackage, ArtifactVerificationError } from '../utils/artifact-verification.js';
import { probeHookSocket, socketPath } from '../mcp/socket-ownership.js';
import { binaryUsable, relayShellPath } from './relay.js';

const MIN_NODE_MAJOR = 20;
/** Hook dir relative to this module: dist/src/cli/ → dist/src/hooks. */
const HOOK_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'hooks');

type CheckStatus = 'ok' | 'warn' | 'fail';
interface CheckResult { status: CheckStatus; detail: string; }
interface Check { name: string; run: () => CheckResult | Promise<CheckResult>; }

function checkNode(): CheckResult {
  const major = Number(process.versions.node.split('.')[0]);
  return major >= MIN_NODE_MAJOR
    ? { status: 'ok', detail: `Node ${process.versions.node} (>= ${MIN_NODE_MAJOR} required)` }
    : { status: 'fail', detail: `Node ${process.versions.node} is below the required ${MIN_NODE_MAJOR}` };
}

async function checkNativeModules(): Promise<CheckResult> {
  try {
    // Deferred import so a broken/ABI-mismatched native addon is reported by
    // this check rather than thrown at module load (which would abort every
    // check). openDatabase loads sqlite-vec through the same path production
    // uses; :memory: keeps the check free of filesystem side effects.
    const { openDatabase, isSqliteVecAvailable } = await import('../db/connection.js');
    const db = openDatabase({ dbPath: ':memory:' });
    try {
      const sqlite = (db.prepare('select sqlite_version() as v').get() as { v: string }).v;
      if (!isSqliteVecAvailable()) {
        return { status: 'warn', detail: `better-sqlite3 loaded (SQLite ${sqlite}) but sqlite-vec is unavailable — vector search falls back to FTS-only` };
      }
      const vec = (db.prepare('select vec_version() as v').get() as { v: string }).v;
      return { status: 'ok', detail: `better-sqlite3 loaded (SQLite ${sqlite}), sqlite-vec ${vec}` };
    } finally {
      db.close();
    }
  } catch (err) {
    return { status: 'fail', detail: `native SQLite stack failed to load: ${(err as Error).message}` };
  }
}

function checkRelay(): CheckResult {
  // The compiled relay is a fast-path optimization; the shell relay is a
  // complete fallback, so a missing binary is a warning, not a failure.
  if (binaryUsable(HOOK_DIR)) {
    return { status: 'ok', detail: `compiled hook relay present and executable` };
  }
  if (existsSync(relayShellPath(HOOK_DIR))) {
    return { status: 'warn', detail: `compiled relay not usable here — using shell fallback; run \`cairn build-relay\` for the fast path` };
  }
  return { status: 'fail', detail: `no hook relay found under ${HOOK_DIR} — run \`npm run build\`` };
}

async function checkEmbeddingModel(): Promise<CheckResult> {
  const config = getEmbeddingModelConfig();
  try {
    await verifyModelPackage(config, 'embedding');
    return { status: 'ok', detail: `embedding model "${config.hfPath}" pinned and verified (cached)` };
  } catch (err) {
    if (!(err instanceof ArtifactVerificationError)) throw err;
    switch (err.kind) {
      case 'missing':
        return { status: 'ok', detail: `embedding model "${config.hfPath}" pinned; not cached yet (downloads and verifies on first use)` };
      case 'unpinned':
        // Hard boot failure: server.ts assertManifestPinned() exits 1 on this.
        return { status: 'fail', detail: `embedding model "${config.hfPath}" is unpinned — the server refuses to boot on it` };
      default:
        return { status: 'fail', detail: `embedding model "${config.hfPath}" cache failed verification — ${err.message.split('\n')[0]}` };
    }
  }
}

async function checkDatabase(): Promise<CheckResult> {
  // Same resolution the server/hooks use, so doctor inspects the same file.
  const path = resolveDbPath(process.env.CAIRN_DB_PATH);
  if (!existsSync(path)) {
    return { status: 'ok', detail: `no database yet at ${path} (schema v${SCHEMA_VERSION} is created on first use)` };
  }
  try {
    // Deferred native import so a broken addon fails this check cleanly.
    // readonly: a diagnostic never migrates or creates. On a WAL database this
    // still opens the -shm shadow, needing dir write access (normal same-uid).
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(path, { readonly: true });
    try {
      const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined;
      const version = row?.version ?? 0;
      if (version === SCHEMA_VERSION) {
        return { status: 'ok', detail: `database schema v${version} matches this build` };
      }
      return version < SCHEMA_VERSION
        ? { status: 'warn', detail: `database schema v${version} is behind build v${SCHEMA_VERSION} — it migrates on next open` }
        : { status: 'warn', detail: `database schema v${version} is ahead of build v${SCHEMA_VERSION} — this build is older than the database` };
    } finally {
      db.close();
    }
  } catch (err) {
    return { status: 'fail', detail: `database at ${path} could not be read: ${(err as Error).message}` };
  }
}

async function checkSocket(): Promise<CheckResult> {
  const live = await probeHookSocket();
  if (live) {
    return { status: 'ok', detail: `hook socket served by PID ${live.pid} at ${socketPath()}` };
  }
  return { status: 'ok', detail: `no live hook-socket owner (an agent client starts one on demand at ${socketPath()})` };
}

const CHECKS: Check[] = [
  { name: 'node runtime', run: checkNode },
  { name: 'native sqlite', run: checkNativeModules },
  { name: 'hook relay', run: checkRelay },
  { name: 'embedding model', run: checkEmbeddingModel },
  { name: 'database', run: checkDatabase },
  { name: 'hook socket', run: checkSocket },
];

const GLYPH: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗' };

/** Run every check, print a line each, and return the process exit code
 *  (0 when no critical check failed; warnings do not fail). */
export async function runDoctor(): Promise<number> {
  console.log('cairn doctor — install health check\n');
  const results: Array<{ name: string; result: CheckResult }> = [];
  for (const check of CHECKS) {
    let result: CheckResult;
    try {
      result = await check.run();
    } catch (err) {
      result = { status: 'fail', detail: (err as Error).message };
    }
    results.push({ name: check.name, result });
    console.log(`  ${GLYPH[result.status]} ${check.name.padEnd(16)} ${result.detail}`);
  }

  const failed = results.filter(r => r.result.status === 'fail').length;
  const warned = results.filter(r => r.result.status === 'warn').length;
  const summary = failed > 0
    ? `${failed} check(s) failed`
    : warned > 0 ? `all critical checks passed (${warned} warning(s))` : 'all checks passed';
  console.log(`\ncairn doctor: ${summary}`);
  return failed > 0 ? 1 : 0;
}
