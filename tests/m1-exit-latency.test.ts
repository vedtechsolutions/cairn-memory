import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import Database from 'better-sqlite3';
import { canonicalJson } from 'waykeep-contract';
import type { SyncEntityEnvelope, SyncEvent, PortableRecord } from 'waykeep-contract';

import { openDatabase } from '../src/db/connection.js';
import { OwnerRpc } from '../src/mcp/owner-rpc.js';
import { SessionCache } from '../src/hooks/shared/session-cache.js';
import { hashCanonical } from '../src/db/sync-apply/index.js';

/**
 * M1-exit latency matrix (brief §3): hook-path costs measured UNDER
 * concurrent apply, competing writers, injected BUSY, and hostile
 * bodies, on the EMBEDDED (single-process) topology — the worst case,
 * since better-sqlite3 apply work shares this event loop. Numbers are
 * PRINTED for the exit checklist; assertions are deliberately generous
 * sanity bounds (an order of magnitude above expectation) so the matrix
 * documents rather than flakes. Owner-death crash consistency rides at
 * the end.
 */

const PROJECT = 'lat-proj';

function record(id: string, content: string): PortableRecord {
  return {
    id, kind: 'fact', content, confidence: 0.6, source: 'learned',
    tags: [], context: null, fingerprint: null, project: PROJECT,
    expires_at: null, anchor: null, created_at: '2026-08-29T10:00:00.000Z',
  };
}

function envelope(rec: PortableRecord, entityId: string): SyncEntityEnvelope {
  const payload = JSON.stringify(rec);
  return {
    entity_id: entityId, entity_version: 1, payload,
    canonical_content_hash: hashCanonical(canonicalJson(JSON.parse(payload))),
    canonicalization_version: 1, hash_version: 1,
    author: 'acct-a', contributors: ['acct-a'], origin_client: 'claude',
    created_at: rec.created_at, updated_at: rec.created_at, tombstoned: false,
  };
}

function batch(seqBase: number, size: number): SyncEvent[] {
  return Array.from({ length: size }, (_, i) => ({
    type: 'upsert' as const, seq: seqBase + i,
    entity: envelope(record(randomUUID(), `latency batch row ${seqBase + i} ${'x'.repeat(200)}`), `E-${seqBase + i}`),
  }));
}

const pct = (samples: number[], p: number): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

let dir: string;
let db: ReturnType<typeof openDatabase>;
let rpc: OwnerRpc;
let server: Server;
let baseUrl: string;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'waykeep-lat-'));
  db = openDatabase({ dbPath: join(dir, 'lat.db') });
  rpc = new OwnerRpc({ db });
  server = createServer((req, res) => {
    rpc.handle(req, res).then((h) => { if (!h) { res.writeHead(404); res.end(); } }).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end(); } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rpc.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('M1-exit: latency matrix (embedded topology)', () => {
  it('hook-path reads stay inside budget under concurrent apply + competing writer + hostile bodies', async () => {
    const cache = new SessionCache();
    cache.checkDurableGeneration(db);
    const hookSamples: number[] = [];
    const healthSamples: number[] = [];
    let busyResponses = 0;
    let applied = 0;

    // Competing writer: short immediate transactions on its own connection.
    const writer = new Database(join(dir, 'lat.db'));
    writer.pragma('busy_timeout = 50');
    const writerTimer = setInterval(() => {
      try {
        writer.prepare('BEGIN IMMEDIATE').run();
        writer.prepare("INSERT INTO sync_state (ns, k, v, updated_at) VALUES ('lat', ?, 'x', datetime('now')) ON CONFLICT(ns,k) DO UPDATE SET v='x'").run(String(Math.random()));
        writer.prepare('COMMIT').run();
      } catch { try { writer.prepare('ROLLBACK').run(); } catch { /* contended */ } }
    }, 7);

    // Hook-representative reads, measured from the INTENDED schedule
    // time (Codex exit final #3): a sample timed from callback entry
    // hides exactly the cost under test — the event-loop blockage from
    // in-process apply work that delays the callback. Self-chaining
    // schedule; after a blocked stretch the intended time re-baselines
    // (max) so one blockage is counted once, not compounded forever.
    const HOOK_PERIOD_MS = 5;
    let stopHook = false;
    let intendedAt = performance.now() + HOOK_PERIOD_MS;
    const scheduleHook = (): void => {
      if (stopHook) return;
      setTimeout(() => {
        if (stopHook) return;
        cache.checkDurableGeneration(db);
        cache.getSkipGate('lat-key');
        const done = performance.now();
        hookSamples.push(done - intendedAt);
        intendedAt = Math.max(intendedAt + HOOK_PERIOD_MS, done);
        scheduleHook();
      }, Math.max(0, intendedAt - performance.now()));
    };
    scheduleHook();

    const busyRtts: number[] = [];
    try {
      for (let b = 0; b < 20; b++) {
        // Health fired WHILE the apply is in flight (Codex exit #4: an
        // awaited-before health never queued behind apply work — the
        // criterion is the queue). Both promises race on the same loop.
        const applyPromise = fetch(`${baseUrl}/owner/apply`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: PROJECT, batch_id: `lat-${b}`, events: batch(b * 100 + 1, 50) }),
        });
        const t0 = process.hrtime.bigint();
        const healthPromise = fetch(`${baseUrl}/owner/health`).then((h) => {
          healthSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
          return h;
        });
        const [res, health] = await Promise.all([applyPromise, healthPromise]);
        assert.equal(health.status, 200);
        if (res.status === 503) busyResponses++;
        else { assert.equal(res.status, 200); applied++; }

        // Hostile bodies: malformed AND oversized-declared. The 413 is
        // REQUIRED via a raw http.request (Codex exit final #3: fetch
        // refuses the mismatched Content-Length client-side, so the old
        // catch-and-skip asserted nothing).
        const bad = await fetch(`${baseUrl}/owner/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
        assert.equal(bad.status, 400);
        const bigStatus = await new Promise<number>((resolve, reject) => {
          const req = httpRequest(`${baseUrl}/owner/apply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': String(2_000_000) },
          }, (res) => { res.resume(); res.on('end', () => { req.destroy(); resolve(res.statusCode ?? 0); }); });
          req.on('error', reject);
          req.write('x'); // partial body: the server must answer from the DECLARED length, not wait for bytes
        });
        assert.equal(bigStatus, 413, 'oversized declared body → REQUIRED 413');
      }

      // DETERMINISTIC injected BUSY, timed (Codex #4: the probabilistic
      // writer permits zero BUSY samples): a held immediate lock forces
      // the BUSY path, and its RTT is a matrix scenario of its own.
      const blocker = new Database(join(dir, 'lat.db'));
      blocker.pragma('busy_timeout = 0');
      blocker.prepare('BEGIN IMMEDIATE').run();
      try {
        const t0 = process.hrtime.bigint();
        const busy = await fetch(`${baseUrl}/owner/apply`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: PROJECT, batch_id: 'lat-busy', events: batch(70_001, 10) }),
        });
        busyRtts.push(Number(process.hrtime.bigint() - t0) / 1e6);
        assert.equal(busy.status, 503, 'deterministic BUSY');
        busyResponses++;
      } finally {
        blocker.prepare('ROLLBACK').run();
        blocker.close();
      }
    } finally {
      stopHook = true;
      clearInterval(writerTimer);
      writer.close();
    }

    const summary = {
      hook_reads: { n: hookSamples.length, p50: pct(hookSamples, 50).toFixed(3), p95: pct(hookSamples, 95).toFixed(3), max: Math.max(...hookSamples).toFixed(3) },
      health_rtt_concurrent: { n: healthSamples.length, p50: pct(healthSamples, 50).toFixed(3), p95: pct(healthSamples, 95).toFixed(3), max: Math.max(...healthSamples).toFixed(3) },
      injected_busy_rtt_ms: busyRtts.map((r) => r.toFixed(1)),
      applied, busyResponses,
    };
    console.log(`[m1-exit latency matrix] ${JSON.stringify(summary)}`);

    assert.ok(hookSamples.length >= 20, 'enough hook samples under load');
    assert.ok(applied + busyResponses === 21 && applied >= 15, 'applies completed or returned typed BUSY');
    assert.equal(busyRtts.length, 1, 'the deterministic BUSY scenario was timed');
    assert.ok(busyRtts[0] < 500, `BUSY path bounded (${busyRtts[0]}ms — 3 attempts + backoff)`);
    // Generous sanity bounds: the D3 property is no LOCK-WAIT class
    // stalls — CPU sharing on the embedded topology is expected and
    // documented, so bounds sit an order of magnitude above expectation.
    assert.ok(pct(hookSamples, 95) < 250, `hook p95 ${pct(hookSamples, 95)}ms within the embedded budget`);
    assert.ok(pct(healthSamples, 95) < 1000, `health p95 ${pct(healthSamples, 95)}ms — the socket answers during applies`);
  });

  it('STANDALONE owner: cross-process applies work, SIGKILL mid-apply leaves whole batches only, and a restarted owner continues', async () => {
    const { spawn } = await import('node:child_process');
    const { readFileSync: rf, existsSync: ex, rmSync: rm } = await import('node:fs');
    const sdir = mkdtempSync(join(tmpdir(), 'waykeep-standalone-'));
    const dbPath = join(sdir, 'standalone.db');
    const portFile = join(sdir, 'port');
    const spawnOwner = async () => {
      const child = spawn(process.execPath, ['tests/fixtures/standalone-owner.mjs', dbPath, portFile], { cwd: process.cwd(), stdio: 'ignore' });
      for (let i = 0; i < 100 && !ex(portFile); i++) await delay(50);
      assert.ok(ex(portFile), 'the standalone owner came up');
      return { child, url: `http://127.0.0.1:${rf(portFile, 'utf-8').trim()}` };
    };

    let { child, url } = await spawnOwner();
    try {
      // Cross-process applies + RTT (the standalone topology's numbers).
      const rtts: number[] = [];
      for (let b = 0; b < 3; b++) {
        const t0 = process.hrtime.bigint();
        const res = await fetch(`${url}/owner/apply`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project: PROJECT, batch_id: `sa-${b}`,
            events: Array.from({ length: 100 }, (_, i) => ({
              type: 'upsert' as const, seq: b * 1000 + i + 1,
              entity: envelope(record(randomUUID(), `standalone row ${b * 1000 + i}`), `E-sa-${b}-${i}`),
            })),
          }),
        });
        rtts.push(Number(process.hrtime.bigint() - t0) / 1e6);
        assert.equal(res.status, 200);
      }
      console.log(`[m1-exit standalone] apply RTTs ms: ${rtts.map((r) => r.toFixed(1)).join(', ')}`);

      // In-transaction probe: BEGIN IMMEDIATE with busy_timeout=0 from
      // the parent fails BUSY exactly while the child's write
      // transaction holds the lock — the synchronization point Codex
      // exit final #3 required, replacing the fixed 15ms guess. The
      // probe's own microsecond lock-hold can race the child's BEGIN
      // (the child's dedicated connection is busy_timeout=0 and would
      // 503); `refire` re-sends the batch on that collision.
      const probe = new Database(dbPath);
      probe.pragma('busy_timeout = 0');
      const waitForWriteTx = async (isSettled: () => boolean, refire: () => void): Promise<void> => {
        for (let i = 0; i < 2000; i++) {
          try {
            probe.prepare('BEGIN IMMEDIATE').run();
            probe.prepare('ROLLBACK').run();
          } catch {
            return; // BUSY ⇒ the child is inside its write transaction NOW
          }
          if (isSettled()) refire();
          await delay(2);
        }
        assert.fail('never observed the child inside a write transaction');
      };
      const fatBatch = (batchId: string, seqBase: number, marker: string): string => JSON.stringify({
        project: PROJECT, batch_id: batchId,
        events: Array.from({ length: 500 }, (_, i) => ({
          type: 'upsert' as const, seq: seqBase + i,
          entity: envelope(record(randomUUID(), `${marker} ${i} ${'y'.repeat(1200)}`), `E-${batchId}-${i}`),
        })),
      });

      // QUEUEING FLOOR (Codex exit final #3): health fired while the
      // apply transaction is PROVEN in flight must queue behind the
      // owner's blocked loop — its RTT carries the blockage. A lone
      // standalone health answers in ~1-3ms; the floor is well above.
      // One body per batch_id, reused on refire: a rebuilt batch would
      // regenerate row ids and change the canonical digest under the
      // same batch_id — a VALIDATION refusal, not a retry.
      const floorBody = fatBatch('sa-floor', 40_000, 'floor row');
      let floorStatus = 0;
      const floorApply = fetch(`${url}/owner/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: floorBody,
      }).then((r) => { floorStatus = r.status; return r.status; });
      await waitForWriteTx(() => floorStatus !== 0, () => {
        floorStatus = 0;
        void fetch(`${url}/owner/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: floorBody }).then((r) => { floorStatus = r.status; });
      });
      const tHealth = process.hrtime.bigint();
      const floorHealth = await fetch(`${url}/owner/health`);
      const floorRtt = Number(process.hrtime.bigint() - tHealth) / 1e6;
      assert.equal(floorHealth.status, 200);
      assert.ok(floorRtt >= 20, `health queued behind the in-flight apply (${floorRtt.toFixed(1)}ms ≥ 20ms floor)`);
      assert.ok((await floorApply) === 200 || floorStatus === 200, 'the floor apply completed');
      console.log(`[m1-exit standalone] health-behind-apply RTT: ${floorRtt.toFixed(1)}ms (floor 20ms)`);

      // SIGKILL synchronized to the in-transaction point: kill lands
      // while the batch's write transaction is open, with an explicit
      // in-flight assertion — a kill after completion would test nothing.
      const killBody = fatBatch('sa-kill', 50_000, 'kill row');
      let killSettled = false;
      const killBatch = fetch(`${url}/owner/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: killBody,
      }).then((r) => { killSettled = true; return r.status; }).catch(() => { killSettled = true; return null; });
      await waitForWriteTx(() => killSettled, () => {
        killSettled = false;
        void fetch(`${url}/owner/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: killBody }).then(() => { killSettled = true; }).catch(() => { killSettled = true; });
      });
      assert.equal(killSettled, false, 'the apply was still in flight at the kill point');
      child.kill('SIGKILL');
      probe.close();
      await killBatch; // settles via the socket-death catch
      await delay(150);

      // Reopen: integrity + whole-batches-only.
      const inspect = openDatabase({ dbPath });
      try {
        const check = inspect.pragma('integrity_check') as Array<{ integrity_check: string }>;
        assert.equal(check[0].integrity_check, 'ok');
        const killRows = (inspect.prepare("SELECT COUNT(*) n FROM memories WHERE content LIKE 'kill row %'").get() as { n: number }).n;
        const receipt = inspect.prepare("SELECT 1 FROM sync_state WHERE ns = 'rpc-batch' AND k = 'sa-kill'").get();
        if (receipt) assert.equal(killRows, 500, 'receipt ⇒ whole batch');
        else assert.equal(killRows, 0, 'no receipt ⇒ nothing');
        assert.equal((inspect.prepare("SELECT COUNT(*) n FROM memories WHERE content LIKE 'standalone row %'").get() as { n: number }).n, 300, 'the committed batches are intact');
      } finally { inspect.close(); }

      // Restart: a fresh owner continues from consistent state.
      rm(portFile, { force: true });
      ({ child, url } = await spawnOwner());
      const after = await fetch(`${url}/owner/apply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project: PROJECT, batch_id: 'sa-after',
          events: [{ type: 'upsert' as const, seq: 60_001, entity: envelope(record(randomUUID(), 'post-restart row'), 'E-after') }],
        }),
      });
      assert.equal(after.status, 200, 'the restarted owner applies normally');
    } finally {
      child.kill('SIGKILL');
      rmSync(sdir, { recursive: true, force: true });
    }
  });

  it('owner death mid-apply leaves the database consistent — the batch is all-or-nothing with its receipt', async () => {
    // Fire an apply and destroy every socket immediately.
    const controller = new AbortController();
    const deathEvents: SyncEvent[] = Array.from({ length: 100 }, (_, i) => ({
      type: 'upsert' as const, seq: 90_001 + i,
      entity: envelope(record(randomUUID(), `death marker row ${90_001 + i}`), `E-death-${i}`),
    }));
    const inFlight = fetch(`${baseUrl}/owner/apply`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project: PROJECT, batch_id: 'death-batch', events: deathEvents }),
      signal: controller.signal,
    }).catch(() => null);
    controller.abort();
    await inFlight;
    await delay(50);

    // The connection survives in-process here; the crash-consistency
    // claim is the DB's: integrity holds and the batch either fully
    // applied WITH its idempotency receipt or not at all.
    const check = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    assert.equal(check[0].integrity_check, 'ok');
    const receipt = db.prepare("SELECT v FROM sync_state WHERE ns = 'rpc-batch' AND k = 'death-batch'").get() as { v: string } | undefined;
    const rows = (db.prepare("SELECT COUNT(*) n FROM memories WHERE content LIKE 'death marker row %'").get() as { n: number }).n;
    if (receipt) assert.equal(rows, 100, 'receipt present ⇒ batch fully applied');
    else assert.equal(rows, 0, 'no receipt ⇒ nothing applied');
  });
});
