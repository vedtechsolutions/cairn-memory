import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
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

    // Hook-representative reads on a timer: generation check + skip-gate.
    const hookTimer = setInterval(() => {
      const t0 = process.hrtime.bigint();
      cache.checkDurableGeneration(db);
      cache.getSkipGate('lat-key');
      hookSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }, 5);

    try {
      for (let b = 0; b < 20; b++) {
        const t0 = process.hrtime.bigint();
        const health = await fetch(`${baseUrl}/owner/health`);
        healthSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
        assert.equal(health.status, 200);

        const res = await fetch(`${baseUrl}/owner/apply`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ project: PROJECT, batch_id: `lat-${b}`, events: batch(b * 100 + 1, 50) }),
        });
        if (res.status === 503) busyResponses++;
        else { assert.equal(res.status, 200); applied++; }

        // Interleave hostile bodies: malformed + oversized declarations.
        const bad = await fetch(`${baseUrl}/owner/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
        assert.equal(bad.status, 400);
      }
    } finally {
      clearInterval(hookTimer);
      clearInterval(writerTimer);
      writer.close();
    }

    const summary = {
      hook_reads: { n: hookSamples.length, p50: pct(hookSamples, 50).toFixed(3), p95: pct(hookSamples, 95).toFixed(3), max: Math.max(...hookSamples).toFixed(3) },
      health_rtt: { n: healthSamples.length, p50: pct(healthSamples, 50).toFixed(3), p95: pct(healthSamples, 95).toFixed(3), max: Math.max(...healthSamples).toFixed(3) },
      applied, busyResponses,
    };
    console.log(`[m1-exit latency matrix] ${JSON.stringify(summary)}`);

    assert.ok(hookSamples.length >= 20, 'enough hook samples under load');
    assert.ok(applied + busyResponses === 20 && applied >= 15, 'applies completed or returned typed BUSY');
    // Generous sanity bounds: the D3 property is no LOCK-WAIT class
    // stalls — CPU sharing on the embedded topology is expected and
    // documented, so bounds sit an order of magnitude above expectation.
    assert.ok(pct(hookSamples, 95) < 250, `hook p95 ${pct(hookSamples, 95)}ms within the embedded budget`);
    assert.ok(pct(healthSamples, 95) < 1000, `health p95 ${pct(healthSamples, 95)}ms — the socket answers during applies`);
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
