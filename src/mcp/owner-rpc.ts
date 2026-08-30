import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import Database from 'better-sqlite3';
import { canonicalJson, type SyncEvent } from 'waykeep-contract';

import { OWNER_RPC, SYNC_APPLY } from '../constants/index.js';
import { applyEventBatch, readGeneration, type ApplyBatchResult } from '../db/sync-apply/index.js';
import { ApplyValidationError, ProtocolInvariantError } from '../db/sync-apply/errors.js';
import type { SessionCache } from '../hooks/shared/session-cache.js';

/**
 * Owner-control RPC (brief D3) — the non-hook route registry served by
 * the hook socket's OWNER process. Deliberately SEPARATE from the hook
 * route table: these routes never appear in hook wiring or generated
 * hook config, and adding one can never widen what agents' hooks call.
 *
 * Served routes:
 *   POST /owner/apply  — apply one ordered sync-event batch for one
 *     project. Strict pre-buffer Content-Length + streaming byte caps;
 *     batch idempotency by caller-stable batch_id (a retry returns the
 *     ORIGINALLY COMMITTED result, recorded in the same transaction as
 *     the batch); synchronous structured response (committed cursor,
 *     generation, per-op outcomes, stable error code + retryability).
 *   GET  /owner/health — capability revision + limits.
 *
 * Apply runs on a DEDICATED connection with busy_timeout=0: a hook
 * request on the main connection can never block behind a long apply
 * (the 5-second-block class is structurally impossible); contention is
 * short synchronous attempts with ASYNC backoff between them, then a
 * retryable BUSY to the caller.
 *
 * Free standalone use (documented, tested): bounded local incremental
 * restore — a caller supplies its own local project binding and a batch
 * of upsert events; core stays enrollment-ignorant (D2/X27). No owner
 * socket ⇒ the paid worker pauses (worker-side behavior, M3).
 *
 * Error taxonomy (M3 caller contract):
 *   VALIDATION      400  retryable=false  — malformed/forged/oversized;
 *                                           fix the batch, never retry.
 *   PROTOCOL_HALT   409  retryable=false  — T8a-class invariant breach;
 *                                           stop sync for the project,
 *                                           snapshot-rebootstrap (D1-R).
 *   BUSY            503  retryable=true   — transient contention.
 *   TOO_LARGE       413  retryable=false.
 */

export const OWNER_RPC_ROUTES = ['/owner/apply', '/owner/health'] as const;

interface OwnerRpcDeps {
  /** The socket owner's main DB (path source + idempotency reads). */
  db: Database.Database;
  /** In-process cache to bump after a committed batch (D3). */
  cache?: SessionCache;
  /** Test seam only: body-read budget override. */
  bodyTimeoutMs?: number;
}

interface ApplyRequestBody {
  project: string;
  batch_id: string;
  events: SyncEvent[];
}

const BATCH_NS = 'rpc-batch';

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function errorResponse(res: ServerResponse, status: number, code: string, message: string, retryable: boolean): void {
  jsonResponse(res, status, { error: code, message, retryable });
}

/** Body reader with a STREAMING cap and its own TIMEOUT — a body that
 *  exceeds the limit is aborted mid-stream, and a stalled sender is cut
 *  on the same budget the hook path uses (review C3: without this, a
 *  slow-loris on the shared socket held a connection and a pending
 *  promise for Node's 300s default). */
export function readBodyCapped(req: IncomingMessage, maxBytes: number, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    const timer = setTimeout(() => {
      cleanup();
      // No destroy here: the caller still writes a structured 400 with
      // Connection: close, THEN drops the stalled socket.
      reject(Object.assign(new Error('body read timeout'), { timedOut: true }));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > maxBytes) {
        cleanup();
        req.destroy();
        reject(Object.assign(new Error('body exceeds limit'), { tooLarge: true }));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => { cleanup(); resolve(Buffer.concat(chunks).toString('utf-8')); };
    const onError = (err: Error): void => { cleanup(); reject(err); };
    function cleanup(): void {
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
    }
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function parseApplyBody(raw: string): ApplyRequestBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ApplyValidationError('request body is not valid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApplyValidationError('request body must be an object');
  }
  const b = parsed as Record<string, unknown>;
  if (typeof b.project !== 'string' || b.project.length === 0 || b.project.length > SYNC_APPLY.MAX_ID_LENGTH) {
    throw new ApplyValidationError('project must be a bounded non-empty string');
  }
  if (typeof b.batch_id !== 'string' || b.batch_id.length === 0 || b.batch_id.length > SYNC_APPLY.MAX_ID_LENGTH) {
    throw new ApplyValidationError('batch_id must be a bounded non-empty string');
  }
  if (!Array.isArray(b.events)) throw new ApplyValidationError('events must be an array');
  return parsed as ApplyRequestBody;
}

export class OwnerRpc {
  private readonly deps: OwnerRpcDeps;
  /** Dedicated apply connection, opened lazily. For an in-memory main
   *  DB (tests, ephemeral runs) a second connection would be a
   *  DIFFERENT database — the main connection is reused there.
   *  FILE-DB-ONLY properties (untestable on :memory:, do not mistake an
   *  in-memory test for coverage of them): busy_timeout=0 isolation,
   *  the BUSY/backoff loop, and hook-vs-apply connection separation. */
  private applyConn: Database.Database | null = null;

  constructor(deps: OwnerRpcDeps) {
    this.deps = deps;
  }

  private connection(): Database.Database {
    if (this.applyConn) return this.applyConn;
    const path = this.deps.db.name;
    if (path === '' || path === ':memory:') {
      this.applyConn = this.deps.db;
      return this.applyConn;
    }
    const conn = new Database(path);
    conn.pragma('journal_mode = WAL');
    conn.pragma('foreign_keys = ON');
    conn.pragma('busy_timeout = 0');
    conn.pragma('synchronous = NORMAL');
    this.applyConn = conn;
    return conn;
  }

  close(): void {
    if (this.applyConn && this.applyConn !== this.deps.db) this.applyConn.close();
    this.applyConn = null;
  }

  /** Returns true when the request was an owner route (handled here). */
  async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url ?? '';
    if (!url.startsWith('/owner/')) return false;

    if (req.method === 'GET' && url === '/owner/health') {
      jsonResponse(res, 200, {
        status: 'ok',
        capability_revision: OWNER_RPC.CAPABILITY_REVISION,
        max_body_bytes: OWNER_RPC.MAX_BODY_BYTES,
        max_events_per_batch: SYNC_APPLY.MAX_EVENTS_PER_BATCH,
      });
      return true;
    }

    if (req.method !== 'POST' || url !== '/owner/apply') {
      errorResponse(res, 404, 'VALIDATION', `unknown owner route ${url}`, false);
      return true;
    }

    // Pre-buffer gate: a declared oversized body is refused before any
    // byte is read; an undeclared or lying one is cut by the streaming
    // cap in readBodyCapped.
    const declared = Number(req.headers['content-length']);
    if (!Number.isFinite(declared) || declared <= 0) {
      errorResponse(res, 411, 'VALIDATION', 'Content-Length is required', false);
      return true;
    }
    if (declared > OWNER_RPC.MAX_BODY_BYTES) {
      errorResponse(res, 413, 'TOO_LARGE', `body exceeds ${OWNER_RPC.MAX_BODY_BYTES} bytes`, false);
      return true;
    }

    let raw: string;
    try {
      raw = await readBodyCapped(req, OWNER_RPC.MAX_BODY_BYTES, this.deps.bodyTimeoutMs ?? OWNER_RPC.BODY_TIMEOUT_MS);
    } catch (err) {
      if ((err as { tooLarge?: boolean }).tooLarge) {
        errorResponse(res, 413, 'TOO_LARGE', `body exceeds ${OWNER_RPC.MAX_BODY_BYTES} bytes`, false);
      } else if ((err as { timedOut?: boolean }).timedOut) {
        res.writeHead(400, { 'Content-Type': 'application/json', Connection: 'close' });
        res.end(JSON.stringify({ error: 'VALIDATION', message: 'body read timeout', retryable: false }));
        res.once('close', () => req.destroy());
      } else {
        errorResponse(res, 400, 'VALIDATION', `body read failed: ${err}`, false);
      }
      return true;
    }

    let body: ApplyRequestBody;
    try {
      body = parseApplyBody(raw);
    } catch (err) {
      errorResponse(res, 400, 'VALIDATION', String((err as Error).message), false);
      return true;
    }

    const conn = this.connection();
    // The request digest binds the batch_id to THIS semantic request —
    // project AND events (reviews C4 + Codex H1): the batch key is
    // global, so a reused id with a different body OR a different
    // project caller is a loud VALIDATION, never a silent no-apply
    // masquerading as a replay. CANONICAL JSON, not raw bytes (review
    // D1): a retry re-serialized with different key order is the SAME
    // semantic request and must replay, not be told "fix the batch".
    const eventsHash = createHash('sha256')
      .update(canonicalJson({ project: body.project, events: body.events }), 'utf8').digest('hex');

    for (let attempt = 1; ; attempt++) {
      try {
        // The idempotency check runs INSIDE the immediate transaction
        // (review C1): an outside read raced a concurrent duplicate
        // through the backoff window into a UNIQUE-constraint 500 for a
        // batch that had COMMITTED. Under the write lock the check is
        // authoritative, and each retry attempt naturally re-checks.
        const genBefore = readGeneration(conn);
        const outcome = conn.transaction((): { replayedRecord?: string; result?: ApplyBatchResult } => {
          const prior = conn.prepare('SELECT v FROM sync_state WHERE ns = ? AND k = ?').get(BATCH_NS, body.batch_id) as { v: string } | undefined;
          if (prior) return { replayedRecord: prior.v };
          const r = applyEventBatch(conn, body.project, body.events);
          conn.prepare(`
            INSERT INTO sync_state (ns, k, v, updated_at) VALUES (?, ?, ?, datetime('now'))
          `).run(BATCH_NS, body.batch_id, JSON.stringify({ batch_id: body.batch_id, cursor: r.cursor, generation: r.generation, outcomes: r.outcomes, events_hash: eventsHash }));
          return { result: r };
        }).immediate();

        if (outcome.replayedRecord !== undefined) {
          const recorded = JSON.parse(outcome.replayedRecord) as { events_hash?: string };
          if (recorded.events_hash !== undefined && recorded.events_hash !== eventsHash) {
            errorResponse(res, 400, 'VALIDATION', `batch_id ${body.batch_id} was committed with a different body`, false);
            return true;
          }
          jsonResponse(res, 200, { ...recorded, replayed: true });
          return true;
        }
        const result = outcome.result!;
        // In-process peer visibility (D3): bump only when the durable
        // generation actually moved — outcome labels are not write
        // evidence (the Y4 lesson), and an all-replay batch must not
        // flush the owner's own caches (review C5).
        if (result.generation > genBefore) this.deps.cache?.bumpMemoryVersion();
        jsonResponse(res, 200, { batch_id: body.batch_id, cursor: result.cursor, generation: result.generation, outcomes: result.outcomes, events_hash: eventsHash, replayed: false });
        return true;
      } catch (err) {
        if (err instanceof ProtocolInvariantError) {
          errorResponse(res, 409, 'PROTOCOL_HALT', err.message, false);
          return true;
        }
        if (err instanceof ApplyValidationError) {
          errorResponse(res, 400, 'VALIDATION', err.message, false);
          return true;
        }
        const code = (err as { code?: string }).code;
        if (code === 'SQLITE_BUSY' && attempt < OWNER_RPC.BUSY_ATTEMPTS) {
          // Async backoff: the event loop stays free for hook traffic
          // between short synchronous attempts (D3).
          await delay(OWNER_RPC.BUSY_BACKOFF_MS * attempt);
          continue;
        }
        if (code === 'SQLITE_BUSY') {
          errorResponse(res, 503, 'BUSY', 'apply connection contended — retry', true);
          return true;
        }
        errorResponse(res, 500, 'INTERNAL', String(err), false);
        return true;
      }
    }
  }
}

