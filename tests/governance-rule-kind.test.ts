import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type Database from 'better-sqlite3';
import { MEMORY_KINDS, LEARNABLE_KINDS } from '../src/constants/index.js';
import { openDatabase } from '../src/db/connection.js';
import { applyConfidenceDecay, expireTtlMemories } from '../src/db/decay.js';
import { forgetProject, weakenStaleFingerprintMemories } from '../src/db/maintenance.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import {
  GovernanceRuleRepository, type CreateRuleInput, type RuleConfirmation,
} from '../src/governance/rule-repository.js';
import { isLearnableKind, isMemoryKind } from '../src/utils/validation.js';

const confirmation: RuleConfirmation = {
  userConfirmed: true, sessionId: 'session-1', clientName: 'claude-code',
};

const input = (ruleId: string, project = 'project-a'): CreateRuleInput => ({
  ruleId,
  content: `Run the exact verification gates for ${ruleId}`,
  project,
  phases: ['pre_exit'],
  level: 'advise',
  gateIds: ['test-core'],
  paths: ['src/**', 'tests/**'],
  confirmation,
});

describe('schema v28 rule semantics', () => {
  let db: Database.Database;
  let rules: GovernanceRuleRepository;
  let memories: MemoryRepository;

  beforeEach(() => {
    db = openDatabase({ dbPath: ':memory:' });
    rules = new GovernanceRuleRepository(db);
    memories = new MemoryRepository(db);
  });
  afterEach(() => db.close());

  it('adds rule to MemoryKind but keeps it outside every generic learning type', () => {
    assert.ok(MEMORY_KINDS.includes('rule'));
    assert.ok(!LEARNABLE_KINDS.includes('rule' as never));
    assert.equal(isMemoryKind('rule'), true);
    assert.equal(isLearnableKind('rule'), false);
    assert.throws(
      () => memories.create({ content: 'generic policy', kind: 'rule' } as never),
      /governance repository/,
    );
  });

  it('creates immutable user-confirmed revisions with exact-scope phase reads and lifecycle audit', () => {
    const first = rules.create(input('verify-core'));
    assert.equal(first.context.record_type, 'policy');
    assert.equal(first.context.revision, 1);
    assert.equal(first.context.status, 'active');
    assert.equal(first.context.created_by, 'user-confirmed');
    assert.equal(rules.activeByPhase('project-a', 'pre_exit').length, 1);
    assert.equal(rules.activeByPhase('project-b', 'pre_exit').length, 0);
    assert.equal(rules.activeByPhase('project-a', 'during').length, 0);

    const secondInput = {
      ruleId: 'caller-controlled-id-must-be-ignored',
      content: 'Run test-core and build before exit',
      project: 'project-a',
      phases: ['during', 'pre_exit'],
      level: 'advise',
      gateIds: ['test-core', 'build'],
      paths: ['src/**', 'tests/**'],
      confirmation,
    } as unknown as Parameters<GovernanceRuleRepository['supersede']>[1];
    const second = rules.supersede('verify-core', secondInput);
    assert.equal(second.context.rule_id, 'verify-core');
    assert.equal(second.context.revision, 2);
    assert.equal(second.context.supersedes, first.memoryId);
    const old = db.prepare('SELECT content, superseded_by FROM memories WHERE id = ?').get(first.memoryId) as {
      content: string; superseded_by: string;
    };
    assert.equal(old.content, first.content, 'old revision content stays immutable');
    assert.equal(old.superseded_by, second.memoryId, 'explicit lifecycle link retires old revision');

    const disabled = rules.disable('project-a', 'verify-core', confirmation);
    assert.equal(disabled.context.status, 'disabled');
    assert.deepEqual(rules.activeByPhase('project-a', 'pre_exit'), []);
    const retired = rules.retire('project-a', 'verify-core', confirmation);
    assert.equal(retired.context.status, 'retired');
    assert.equal(retired.context.revision, 4);
    assert.deepEqual(rules.history('project-a', 'verify-core').map(r => r.context.status), [
      'active', 'active', 'disabled', 'retired',
    ]);

    const audit = db.prepare(`
      SELECT event_type, actor_class, linked_rule_memory_id
      FROM governance_audit ORDER BY id
    `).all() as Array<{ event_type: string; actor_class: string; linked_rule_memory_id: string }>;
    assert.deepEqual(audit.map(row => row.event_type), [
      'rule_created', 'rule_superseded', 'rule_disabled', 'rule_retired',
    ]);
    assert.ok(audit.every(row => row.actor_class === 'user-confirmed'));
    assert.equal(audit.at(-1)?.linked_rule_memory_id, retired.memoryId);
  });

  it('requires confirmation and atomically rolls back when lifecycle audit cannot be written', () => {
    const unconfirmed = {
      ...input('unconfirmed'), confirmation: { userConfirmed: false },
    } as unknown as CreateRuleInput;
    assert.throws(() => rules.create(unconfirmed), /explicit user confirmation/);

    db.exec(`CREATE TRIGGER reject_rule_audit BEFORE INSERT ON governance_audit
      WHEN new.event_type = 'rule_created' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
    assert.throws(() => rules.create(input('atomic')), /audit unavailable/);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM memories WHERE kind = 'rule'").get() as { n: number }).n;
    assert.equal(count, 0, 'rule insert rolls back with its required audit row');
  });

  it('excludes rules from decay, expiry, weakening, generic mutation, recall, stats, embeddings, and portability', () => {
    const rule = rules.create(input('isolated'));
    db.prepare(`
      UPDATE memories SET confidence = 0.8, created_at = ?, last_decayed_at = ?,
        expires_at = ?, fingerprint = ? WHERE id = ?
    `).run(
      '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z',
      '2020-01-02T00:00:00.000Z',
      JSON.stringify({ lang: ['ts'], framework: [], module: ['gone-module'] }),
      rule.memoryId,
    );
    applyConfidenceDecay(db, Date.parse('2026-08-25T12:00:00.000Z'));
    expireTtlMemories(db, Date.parse('2026-08-25T12:00:00.000Z'));
    assert.equal(weakenStaleFingerprintMemories(db, 'project-a', new Set(['current-module'])), 0);

    memories.boostConfidence(rule.memoryId, 0.1);
    memories.incrementSurface(rule.memoryId);
    memories.incrementImpact(rule.memoryId);
    assert.equal(memories.strengthenConfidence(rule.memoryId), false);
    assert.deepEqual(memories.weakenConfidence(rule.memoryId), { weakened: false, invalidated: false });
    assert.equal(memories.update(rule.memoryId, 'generic rewrite'), false);
    assert.equal(memories.invalidate(rule.memoryId), false);
    assert.equal(memories.promote(rule.memoryId), false);
    assert.equal(memories.delete(rule.memoryId), false);
    assert.equal(forgetProject(db, 'project-a'), 0);

    assert.equal(memories.findById(rule.memoryId), null);
    assert.deepEqual(memories.search('verification gates', { project: 'project-a', kind: 'rule' }), []);
    assert.deepEqual(memories.recall('verification gates', { project: 'project-a' }), []);
    assert.deepEqual(memories.memoriesWithoutEmbeddings(), []);
    assert.deepEqual(memories.exportPortable(), []);
    assert.deepEqual(memories.exportMemories({ kind: 'rule' }), []);
    assert.deepEqual(memories.getStats(), { total: 0, active: 0, invalidated: 0, byKind: {} });
    assert.throws(() => memories.restore({
      id: rule.memoryId, kind: 'fact', content: 'overwrite policy', confidence: 0.7,
      source: 'user', tags: [], context: null, fingerprint: null, project: 'project-a',
      expires_at: null, anchor: null, created_at: '2026-01-01T00:00:00.000Z',
    }), /not portable/);

    const stored = db.prepare(`
      SELECT content, confidence, surface_count, impact_count, invalidated, project
      FROM memories WHERE id = ?
    `).get(rule.memoryId) as Record<string, unknown>;
    assert.deepEqual(stored, {
      content: rule.content, confidence: 0.8, surface_count: 0,
      impact_count: 0, invalidated: 0, project: 'project-a',
    });
  });

  it('keeps generic dedup and truth supersession one boundary away from policy', () => {
    const rule = rules.create({
      ...input('policy-boundary'),
      content: 'The API gateway must run version 18.1 in production.',
    });
    const fact = memories.create({
      content: 'The API gateway must run version 19.2 in production.',
      kind: 'fact', project: 'project-a',
    });
    assert.notEqual(fact.id, rule.memoryId);
    const storedRule = rules.history('project-a', 'policy-boundary')[0];
    assert.equal(storedRule.supersededBy, null);
    assert.equal(storedRule.content, rule.content);
  });
});
