import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection.js';
import { GovernanceRepository } from '../src/governance/repository.js';
import {
  GovernanceOverrideStore, GOVERNANCE_OVERRIDE_DEFAULT_DURATION_MS,
} from '../src/governance/governance-overrides.js';
import type { GovernanceOverrideContext } from '../src/governance/override-validator.js';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');

function context(overrides: Partial<GovernanceOverrideContext> = {}): GovernanceOverrideContext {
  return {
    project: 'proj-a', sessionId: 'session-a', configSha256: 'a'.repeat(64),
    worktreeDigest: 'b'.repeat(64), rules: [{ ruleId: 'verify-core', revision: 2 }],
    gateIds: ['test-core'], nowMs: NOW, ...overrides,
  };
}

function create(store: GovernanceOverrideStore, overrides: Record<string, unknown> = {}) {
  return store.create({
    ...context(), clientName: 'claude-code', reason: 'Known upstream outage',
    confirmation: { userConfirmed: true, mechanism: 'mcp-elicitation' }, nowMs: NOW,
    ...overrides,
  });
}

describe('GovernanceOverrideStore', () => {
  it('requires interactive confirmation before either record is written', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const store = new GovernanceOverrideStore(db);
    assert.throws(() => store.create({
      ...context(), clientName: 'claude-code', reason: 'no direct confirmation',
      confirmation: { userConfirmed: false, mechanism: 'mcp-elicitation' } as never,
      nowMs: NOW,
    }), /interactive user confirmation/);
    assert.equal((db.prepare('SELECT count(*) n FROM governance_audit').get() as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) n FROM memories').get() as { n: number }).n, 0);
    db.close();
  });

  it('rolls back the fact when the authoritative audit insert fails', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const store = new GovernanceOverrideStore(db);
    db.exec(`CREATE TRIGGER reject_override_audit BEFORE INSERT ON governance_audit
      WHEN NEW.event_type = 'governance_override_created' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    assert.throws(() => create(store), /audit unavailable/);
    assert.equal((db.prepare(`SELECT count(*) n FROM governance_audit
      WHERE event_type = 'governance_override_created'`).get() as { n: number }).n, 0);
    assert.equal((db.prepare(`SELECT count(*) n FROM governance_audit
      WHERE event_type = 'governance_override_incident'`).get() as { n: number }).n, 1);
    assert.equal((db.prepare('SELECT count(*) n FROM memories').get() as { n: number }).n, 0);
    assert.equal(store.latest(context()).status, 'self_error');
    db.close();
  });

  it('defaults to a session-bound 24 hours and rejects a longer duration', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const store = new GovernanceOverrideStore(db);
    const result = create(store);
    assert.equal(Date.parse(result.expiresAt) - Date.parse(result.issuedAt), GOVERNANCE_OVERRIDE_DEFAULT_DURATION_MS);
    assert.throws(() => create(store, { durationMs: GOVERNANCE_OVERRIDE_DEFAULT_DURATION_MS + 1 }), /1 ms\.\.24 h/);
    db.close();
  });

  it('reads only an exact current binding and invalidates tree, config, rule, gate, and expiry changes', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const store = new GovernanceOverrideStore(db);
    create(store);
    assert.equal(store.latest(context()).status, 'valid');
    assert.equal(store.latest(context({ worktreeDigest: 'c'.repeat(64) })).status, 'invalid');
    assert.equal(store.latest(context({ configSha256: 'd'.repeat(64) })).status, 'invalid');
    assert.equal(store.latest(context({ rules: [{ ruleId: 'verify-core', revision: 3 }] })).status, 'invalid');
    assert.equal(store.latest(context({ gateIds: ['lint-core'] })).status, 'invalid');
    assert.equal(store.latest(context({ nowMs: NOW + GOVERNANCE_OVERRIDE_DEFAULT_DURATION_MS })).status, 'invalid');
    db.close();
  });

  it('fails closed on a newer malformed audit instead of reviving an older override', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const store = new GovernanceOverrideStore(db);
    create(store);
    db.prepare(`INSERT INTO governance_audit (
      project, session_id, occurred_at, event_type, actor_class, redacted_detail,
      payload_version, payload
    ) VALUES ('proj-a', 'session-a', ?, 'governance_override_created',
      'user-confirmed', 'malformed', 1, '{}')`).run(new Date(NOW + 1).toISOString());
    assert.deepEqual(store.latest(context()), {
      status: 'invalid', candidate: null, validation: { valid: false, reason: 'malformed' },
    });
    db.close();
  });

  it('keeps a live linked override intact during explicit retention cleanup', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const store = new GovernanceOverrideStore(db);
    const created = create(store);
    db.prepare(`INSERT INTO governance_audit (
      project, occurred_at, event_type, actor_class, redacted_detail, payload_version, payload
    ) VALUES ('proj-a', ?, 'old_incident', 'system', 'old', 1, '{}')`)
      .run(new Date(NOW - 3 * 86_400_000).toISOString());
    const result = new GovernanceRepository(db).cleanupLifecycle({
      project: 'proj-a', auditDays: 1, ruleDays: 1, nowMs: NOW, confirmed: true,
    });
    assert.equal(result.auditRowsDeleted, 1);
    assert.ok(db.prepare('SELECT id FROM governance_audit WHERE id = ?').get(created.auditId));
    assert.ok(db.prepare('SELECT id FROM memories WHERE id = ?').get(created.factMemoryId));
    assert.equal(store.latest(context()).status, 'valid');
    db.close();
  });

  it('redacts secrets from both records', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const store = new GovernanceOverrideStore(db);
    create(store, { reason: 'upstream token=needle-secret outage' });
    const audit = db.prepare(`SELECT redacted_detail, payload FROM governance_audit`).get() as {
      redacted_detail: string; payload: string;
    };
    const fact = db.prepare(`SELECT content, context FROM memories`).get() as { content: string; context: string };
    assert.doesNotMatch(JSON.stringify({ audit, fact }), /needle-secret/);
    assert.match(audit.payload, /\[REDACTED\]/);
    db.close();
  });
});
