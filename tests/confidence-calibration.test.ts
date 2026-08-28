import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { CONFIDENCE } from '../src/constants/index.js';

// Note: the two-tier decayStaleConfidence path was removed in W0 of the
// 2026-07-20 roadmap — temporal decay is owned solely by the incremental
// Ebbinghaus model (tests/decay.test.ts); surfaced-but-unused feedback is
// owned by applyPrecisionFeedback.

describe('Phase 6: Confidence Calibration Constants', () => {
  it('PREDICTION_VERIFIED_BOOST should be stronger than generic BOOST_INCREMENT', () => {
    assert.ok(CONFIDENCE.PREDICTION_VERIFIED_BOOST > CONFIDENCE.BOOST_INCREMENT,
      `verified boost ${CONFIDENCE.PREDICTION_VERIFIED_BOOST} should exceed generic ${CONFIDENCE.BOOST_INCREMENT}`);
  });

  it('should have DOUBLE_IMPACT_ON_IGNORED_WARNING flag', () => {
    assert.equal(CONFIDENCE.DOUBLE_IMPACT_ON_IGNORED_WARNING, true);
  });
});

describe('Phase 6: Prediction Verified Boost', () => {
  it('PREDICTION_VERIFIED_BOOST should be 0.08', () => {
    assert.equal(CONFIDENCE.PREDICTION_VERIFIED_BOOST, 0.08);
  });

  it('should boost confidence by PREDICTION_VERIFIED_BOOST amount', () => {
    const db = openDatabase({ dbPath: ':memory:' });
    const repo = new MemoryRepository(db);

    const mem = repo.create({ content: 'Pitfall that predicted correctly', kind: 'pitfall', project: 'tp', confidence: 0.65 });
    repo.boostConfidence(mem.id, CONFIDENCE.PREDICTION_VERIFIED_BOOST);
    const after = repo.findById(mem.id)!.confidence;

    assert.ok(Math.abs(after - 0.73) < 0.01, `expected ~0.73, got ${after}`);
    db.close();
  });
});
