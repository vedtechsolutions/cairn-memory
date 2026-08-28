import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection.js';
import { InvestigationRepository, type ChainAttempt } from '../src/db/investigation-repository.js';
import { compileBriefing, type BriefingContext } from '../src/hooks/shared/briefing-compiler.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';

function makeAttempt(approach: string, outcome: string): ChainAttempt {
  return { approach, outcome, timestamp: new Date().toISOString() };
}

describe('InvestigationRepository', () => {
  it('should create a chain and retrieve it as active', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new InvestigationRepository(db);

    const chain = repo.create('proj', 'sess-1', 'TypeError: undefined', makeAttempt('Edit on app.ts', 'TypeError'));
    assert.ok(chain.id);
    assert.equal(chain.trigger_error, 'TypeError: undefined');
    assert.equal(chain.attempts.length, 1);
    assert.equal(chain.resolution, null);

    const active = repo.getActiveChain('proj', 'sess-1');
    assert.ok(active);
    assert.equal(active!.id, chain.id);
    db.close();
  });

  it('should append attempts up to the cap', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new InvestigationRepository(db);

    const chain = repo.create('proj', 'sess-1', 'build error', makeAttempt('Attempt 1', 'fail'));

    // Append 9 more (total 10 = cap)
    for (let i = 2; i <= 10; i++) {
      const ok = repo.appendAttempt(chain.id, makeAttempt(`Attempt ${i}`, 'fail'));
      assert.ok(ok, `attempt ${i} should succeed`);
    }

    // 11th should be rejected
    const rejected = repo.appendAttempt(chain.id, makeAttempt('Attempt 11', 'fail'));
    assert.equal(rejected, false, 'should reject attempt beyond cap');

    // Verify count
    const active = repo.getActiveChain('proj', 'sess-1');
    assert.equal(active!.attempts.length, 10);
    db.close();
  });

  it('should resolve a chain and move it from active to resolved', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new InvestigationRepository(db);

    const chain = repo.create('proj', 'sess-1', 'test failure', makeAttempt('Edit on test.ts', 'assertion error'));
    repo.appendAttempt(chain.id, makeAttempt('Edit on util.ts', 'still failing'));
    repo.resolve(chain.id, 'Fixed via util.ts — tests pass');

    // No longer active
    const active = repo.getActiveChain('proj', 'sess-1');
    assert.equal(active, null, 'resolved chain should not appear as active');

    // Appears in recently resolved
    const resolved = repo.getRecentResolved('proj', 5);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].resolution, 'Fixed via util.ts — tests pass');
    assert.equal(resolved[0].attempts.length, 2);
    db.close();
  });

  it('should link memory IDs to a chain', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new InvestigationRepository(db);

    const chain = repo.create('proj', 'sess-1', 'error', makeAttempt('Edit', 'fail'));
    repo.addMemoryId(chain.id, 'mem-1');
    repo.addMemoryId(chain.id, 'mem-2');
    repo.addMemoryId(chain.id, 'mem-1'); // duplicate — should not add twice

    const active = repo.getActiveChain('proj', 'sess-1');
    assert.deepEqual(active!.memory_ids, ['mem-1', 'mem-2']);
    db.close();
  });

  it('should return null for nonexistent active chain', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new InvestigationRepository(db);

    const active = repo.getActiveChain('proj', 'sess-nonexistent');
    assert.equal(active, null);
    db.close();
  });

  it('should scope active chains by session', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new InvestigationRepository(db);

    repo.create('proj', 'sess-1', 'error A', makeAttempt('Edit', 'fail'));
    repo.create('proj', 'sess-2', 'error B', makeAttempt('Write', 'fail'));

    const active1 = repo.getActiveChain('proj', 'sess-1');
    assert.equal(active1!.trigger_error, 'error A');

    const active2 = repo.getActiveChain('proj', 'sess-2');
    assert.equal(active2!.trigger_error, 'error B');
    db.close();
  });

  it('should cleanup old resolved chains', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new InvestigationRepository(db);

    const chain = repo.create('proj', 'sess-1', 'old error', makeAttempt('Edit', 'fail'));
    repo.resolve(chain.id, 'fixed');

    // Manually set resolved_at to 100 hours ago
    db.prepare(`UPDATE investigation_chains SET resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-100 hours') WHERE id = ?`).run(chain.id);

    const deleted = repo.cleanup(48); // retain 48 hours
    assert.equal(deleted, 1);

    const resolved = repo.getRecentResolved('proj', 5);
    assert.equal(resolved.length, 0);
    db.close();
  });
});

describe('Briefing: Investigation Chain Rendering', () => {
  it('should render resolved chains in T2 section', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    // Need at least one decision for T2 to render (chains append to T2)
    memRepo.create({ content: 'Use RRF for search fusion', kind: 'decision', project: 'tp' });

    const ctx: BriefingContext = {
      project: 'tp',
      sessionType: 'startup',
      interrupted: false,
      resolvedChains: [{
        trigger_error: 'TypeError: cannot read property of undefined',
        attempts: [
          { approach: 'Edit on handler.ts' },
          { approach: 'Edit on types.ts' },
        ],
        resolution: 'Fixed via types.ts — tests pass',
      }],
    };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(result.text.includes('Investigation:'), 'should render investigation chain');
    assert.ok(result.text.includes('TypeError'), 'should include trigger');
    assert.ok(result.text.includes('Fixed via types.ts'), 'should include resolution');
    db.close();
  });

  it('should not render chains when none provided', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const memRepo = new MemoryRepository(db);
    const planRepo = new PlanRepository(db);

    memRepo.create({ content: 'Some decision', kind: 'decision', project: 'tp' });

    const ctx: BriefingContext = { project: 'tp', sessionType: 'startup', interrupted: false };
    const result = compileBriefing(memRepo, planRepo, ctx);
    assert.ok(!result.text.includes('Investigation:'), 'no chains = no investigation line');
    db.close();
  });
});
