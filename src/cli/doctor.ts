/**
 * `waykeep doctor` — post-install health check.
 *
 * Verifies the pieces an install needs before the hooks or MCP server can
 * work: the Node runtime, the native SQLite stack, the compiled hook relay,
 * the embedding model pin, the database schema, and the hook socket. Each
 * check prints one actionable line; a failed critical check exits non-zero so
 * `waykeep doctor` can gate CI and setup scripts. Diagnostic only — it never
 * creates or migrates the database.
 */
import { existsSync, readFileSync , realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { SCHEMA_VERSION } from '../db/schema.js';
import { resolveDbPath } from '../db/db-path.js';
import { CAIRN_HOOK_DIR_MARKER } from '../constants/index.js';
import { SYNC_ROUTES, ASYNC_ROUTES, CONTRACT_REVISION } from 'waykeep-contract';
import { getEmbeddingModelConfig } from '../utils/embeddings.js';
import { verifyModelPackage, ArtifactVerificationError } from '../utils/artifact-verification.js';
import { probeHookSocket, socketPath, pidPath } from '../mcp/socket-ownership.js';
import { binaryUsable, relayShellPath } from './relay.js';
import {
  codexDir, codexHooksPath, codexConfigPath, codexHookCount,
  countTrustedHooksIn, hasCairnMcpServer, cairnCommandSet,
  LEGACY_POST_TOOL_ROUTE, type CodexHooksFile,
} from './codex-init.js';

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
    const msg = (err as Error).message;
    // npm >= 11.5 blocks dependency install scripts by default
    // (allowScripts); better-sqlite3 then ships with no native binding
    // and fails exactly here on a fresh global install. npm's own
    // warning suggests a fix command that OMITS the package name (it
    // ENOENTs in an empty cwd), so print the working one.
    if (/better_sqlite3\.node|bindings file|No native build|different Node\.js version|ERR_DLOPEN/i.test(msg)) {
      return {
        status: 'fail',
        detail:
          `native SQLite addon missing (npm likely blocked its install script): ${msg.split('\n')[0]} — ` +
          `fix: npm install -g waykeep --allow-scripts=better-sqlite3,onnxruntime-node,sharp,protobufjs`,
      };
    }
    return { status: 'fail', detail: `native SQLite stack failed to load: ${msg}` };
  }
}

function checkRelay(): CheckResult {
  // The compiled relay is a fast-path optimization; the shell relay is a
  // complete fallback, so a missing binary is a warning, not a failure.
  if (binaryUsable(HOOK_DIR)) {
    return { status: 'ok', detail: `compiled hook relay present and executable` };
  }
  if (existsSync(relayShellPath(HOOK_DIR))) {
    return { status: 'warn', detail: `compiled relay not usable here — using shell fallback; run \`waykeep build-relay\` for the fast path` };
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
    // A daemon left running across a package upgrade serves the OLD route
    // table; async hooks aimed at a route it lacks fail silently (the
    // relay's direct-node fallback catches the 404, but capture should
    // not be living on the fallback path).
    // Absent metadata is itself the oldest form of drift: every daemon of
    // this contract era serves routes + contract_revision, so a null on
    // either means the owner PREDATES both fields — exactly the daemon
    // this check exists to catch. Null must warn, never pass as healthy.
    if (live.routes === null || live.contractRevision === null) {
      return { status: 'warn', detail: `hook socket owner (PID ${live.pid}) predates contract metadata (/health lacks routes/contract_revision) — restart it: \`systemctl restart cairn-daemon\` (or restart the agent that owns the socket)` };
    }
    const missingRoutes = [...SYNC_ROUTES, ...ASYNC_ROUTES].filter((r) => !live.routes!.includes(`/${r}`));
    const revisionDrift = live.contractRevision !== CONTRACT_REVISION;
    if (missingRoutes.length > 0 || revisionDrift) {
      const what = missingRoutes.length > 0
        ? `missing routes: ${missingRoutes.join(', ')}`
        : `contract revision ${live.contractRevision} vs this build's ${CONTRACT_REVISION}`;
      return { status: 'warn', detail: `hook socket owner (PID ${live.pid}) predates this install (${what}) — restart it: \`systemctl restart cairn-daemon\` (or restart the agent that owns the socket)` };
    }
    return { status: 'ok', detail: `hook socket served by PID ${live.pid} at ${socketPath()}` };
  }
  // A socket file whose HTTP probe fails has two very different causes; the
  // PID file discriminates them: a live owner PID means the probe itself
  // was blocked (typically an agent sandbox — seen live from a Codex
  // shell), while a dead/absent PID means the owner crashed and left the
  // socket behind (releaseSocketClaim only unlinks on clean exit).
  if (existsSync(socketPath())) {
    let ownerAlive = false;
    let pid: number | null = null;
    try {
      pid = Number(readFileSync(pidPath(), 'utf-8').trim());
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          ownerAlive = true;
        } catch (err) {
          // EPERM = the process EXISTS but this context may not signal it —
          // exactly what a sandbox reports for a live daemon. Only ESRCH
          // (and an absent PID file) mean the owner is actually gone.
          ownerAlive = (err as NodeJS.ErrnoException).code === 'EPERM';
        }
      }
    } catch { /* absent/unreadable PID file — ownerAlive stays false */ }
    if (ownerAlive) {
      return { status: 'warn', detail: `hook socket exists and its owner (PID ${pid}) is alive, but the probe could not reach it — likely a sandboxed environment; re-run doctor from an unsandboxed shell to confirm` };
    }
    return { status: 'warn', detail: `stale hook socket at ${socketPath()} (its owner exited uncleanly) — self-healing: the next agent client reclaims it on start` };
  }
  return { status: 'ok', detail: `no live hook-socket owner (an agent client starts one on demand at ${socketPath()})` };
}

/** Per-agent parity: is Codex wired, and has the one-time trust happened?
 *  Exported for direct unit testing (CAIRN_CODEX_DIR makes it hermetic). */
export function checkCodexParity(): CheckResult {
  if (!existsSync(codexDir())) {
    return { status: 'ok', detail: 'Codex CLI not detected (nothing to wire)' };
  }
  const hooksPath = codexHooksPath();
  if (!existsSync(hooksPath)) {
    return { status: 'warn', detail: 'Codex CLI detected but Waykeep hooks are not installed — run `waykeep init`' };
  }
  let file: CodexHooksFile;
  let total: number;
  try {
    const parsed = JSON.parse(readFileSync(hooksPath, 'utf-8')) as unknown;
    // A wrong-shape file is a config problem, not a doctor crash: the cast
    // alone let `{}`/`null` throw TypeErrors that failed CI unactionably.
    if (parsed === null || typeof parsed !== 'object'
      || typeof (parsed as { hooks?: unknown }).hooks !== 'object'
      || (parsed as { hooks?: unknown }).hooks === null) {
      throw new Error('not a hooks file');
    }
    file = parsed as CodexHooksFile;
    // Counting walks the full nested shape — a group without a hooks
    // array surfaced a raw TypeError instead of this warn (review).
    total = codexHookCount(file);
  } catch {
    return { status: 'warn', detail: `${hooksPath} is not a valid hooks file (bad JSON or shape) — re-run \`waykeep init\`` };
  }
  const wired = JSON.stringify(file).includes(CAIRN_HOOK_DIR_MARKER);
  if (!wired || total === 0) {
    return { status: 'warn', detail: 'Codex hooks.json exists but carries no Waykeep hooks — run `waykeep init`' };
  }
  // Stale-install detection: hook commands pin the ABSOLUTE install path
  // of whichever install wrote them. Two failure shapes (review): the
  // wired dir no longer exists (moved/removed install — hooks die
  // silently), or it exists but is NOT the install running doctor (an
  // old nvm tree left behind — hooks silently run outdated code while
  // everything looks healthy). Anchored on hook-relay so a foreign
  // command that merely contains dist/src/hooks/ cannot false-positive.
  const wiredDir = cairnCommandSet(file)
    .map((c) => /(\/[^ ]+\/dist\/src\/hooks)\/hook-relay/.exec(c)?.[1])
    .find((d): d is string => d !== undefined);
  if (wiredDir !== undefined && !existsSync(wiredDir)) {
    return { status: 'warn', detail: `Codex hooks point at a moved or removed install (${wiredDir}) — re-run \`waykeep init\` (one re-trust)` };
  }
  // realpath BOTH sides: the same install reached through a symlink must
  // not read as different (review) — that prompted needless re-trust.
  const canonical = (d: string): string => { try { return realpathSync(d); } catch { return resolve(d); } };
  if (wiredDir !== undefined && canonical(wiredDir) !== canonical(HOOK_DIR)) {
    return { status: 'warn', detail: `Codex hooks run a DIFFERENT install (${wiredDir}) than this one (${HOOK_DIR}) — re-run \`waykeep init\` from the install you want (one re-trust)` };
  }
  const config = existsSync(codexConfigPath()) ? readFileSync(codexConfigPath(), 'utf-8') : '';
  const mcp = hasCairnMcpServer(config) ? 'MCP registered' : 'MCP NOT registered (run `waykeep init`)';
  const trust = countTrustedHooksIn(config, hooksPath, file);
  // Deprecated-route note (D3 window): status stays as-is while the alias
  // is served; this line escalates to a warn when a removal window opens.
  const legacyRoute = cairnCommandSet(file).some((c) => c.endsWith(` ${LEGACY_POST_TOOL_ROUTE}`))
    ? `; deprecated '${LEGACY_POST_TOOL_ROUTE}' route wiring — modernize with \`waykeep init --migrate-routes\` (one re-trust)`
    : '';
  if (trust.disabled > 0 && trust.trusted < total) {
    return { status: 'warn', detail: `Codex wired but ${trust.disabled} hook(s) are DISABLED and ${total - trust.trusted - trust.disabled} untrusted (${trust.trusted}/${total} active; ${mcp}) — review with /hooks in codex${legacyRoute}` };
  }
  if (trust.trusted >= total) {
    return { status: 'ok', detail: `Codex wired and trusted (${trust.trusted}/${total} hooks; ${mcp}; governance advisory is Claude Code-only — expected)${legacyRoute}` };
  }
  return { status: 'warn', detail: `Codex wired, awaiting one-time trust review (${trust.trusted}/${total} hooks trusted; ${mcp}) — start \`codex\` and accept the Waykeep hooks${legacyRoute}` };
}

const CHECKS: Check[] = [
  { name: 'node runtime', run: checkNode },
  { name: 'native sqlite', run: checkNativeModules },
  { name: 'hook relay', run: checkRelay },
  { name: 'embedding model', run: checkEmbeddingModel },
  { name: 'database', run: checkDatabase },
  { name: 'hook socket', run: checkSocket },
  { name: 'codex parity', run: checkCodexParity },
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
  console.log(`\nwaykeep doctor: ${summary}`);
  return failed > 0 ? 1 : 0;
}
