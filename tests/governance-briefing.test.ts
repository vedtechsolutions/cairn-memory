import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { openDatabase } from '../src/db/connection.js';
import { MemoryRepository } from '../src/db/memory-repository.js';
import { PlanRepository } from '../src/db/plan-repository.js';
import { loadGovernanceBriefing } from '../src/governance/briefing.js';
import { GovernanceRuleRepository } from '../src/governance/rule-repository.js';
import { compileBriefing } from '../src/hooks/shared/briefing-compiler.js';
import { projectId } from '../src/utils/project-id.js';

describe('bounded advisory governance briefing', () => {
  let db: Database.Database;
  let root: string;
  let project: string;

  beforeEach(() => {
    db = openDatabase({ dbPath: ':memory:' });
    root = mkdtempSync(join(tmpdir(), 'cairn-governance-briefing-'));
    project = projectId(root);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('is absent for non-governed projects', () => {
    const section = loadGovernanceBriefing(db, {
      project, projectRoot: root, sessionId: 'session-a', clientName: 'claude-code',
      clientInstallationId: 'install-a', nowMs: Date.parse('2026-08-26T12:00:00.000Z'),
    });
    assert.equal(section, null);
  });

  it('renders redacted rules, capability reasons, and event-distance verdict age', () => {
    new GovernanceRuleRepository(db).create({
      ruleId: 'verify-core', content: 'Verify release password=hunter2 before exit',
      project, phases: ['pre_exit'], level: 'warn', gateIds: ['test'], paths: ['**'],
      confirmation: { userConfirmed: true },
    });
    db.prepare(`
      INSERT INTO governance_client_state (
        project, client_installation_id, client_name, client_version,
        supports_post_tool_use, supports_post_tool_failure, supports_file_changed,
        supports_structured_output, supports_stop, supports_blocking, adapter_version,
        settings_source, last_session_id, last_heartbeat_at, last_probe_result
      ) VALUES (?, 'install-a', 'claude-code', '1', 1, 1, 0, 1, 1, 0, 1,
        'managed', 'session-a', '2026-08-26T12:00:00.000Z', 'ok')
    `).run(project);
    db.prepare(`
      INSERT INTO governance_audit (
        project, occurred_at, event_type, actor_class, redacted_detail,
        payload_version, payload
      ) VALUES (?, '2026-08-26T11:59:00.000Z', 'shadow_stop_verdict', 'system',
        'shadow verdict', 1, ?)
    `).run(project, JSON.stringify({
      result: 'pass', reason: 'all_required_gates_fresh',
      evaluated_through: { event_seq: 0, mutation_seq: 0 },
      config_sha256: 'a'.repeat(64), assistant: 'needle-assistant-audit-text',
    }));
    const section = loadGovernanceBriefing(db, {
      project, projectRoot: root, sessionId: 'session-a', clientName: 'claude-code',
      clientInstallationId: 'install-a', nowMs: Date.parse('2026-08-26T12:00:00.000Z'),
    });
    assert.ok(section);
    const output = compileBriefing(new MemoryRepository(db), new PlanRepository(db), {
      project, sessionType: 'startup', interrupted: false, briefingMode: 'full',
      budgetOverride: 600, governance: section,
    });
    assert.match(output.text, /advisory; not enforced/u);
    assert.match(output.text, /password=\[REDACTED\]/u);
    assert.match(output.text, /missing_file_changed/u);
    assert.match(output.text, /pass\/all_required_gates_fresh; age 0 event\(s\)/u);
    assert.doesNotMatch(output.text, /\bpassed\b/iu);
    assert.doesNotMatch(output.text, /needle-assistant|a{64}/u);
    assert.ok(output.tokenEstimate <= 600, `${output.tokenEstimate} exceeds tier budget`);
  });

  it('renders the same advisory label in index mode within its budget', () => {
    new GovernanceRuleRepository(db).create({
      ruleId: 'verify-core', content: 'Verify core behavior before exit',
      project, phases: ['pre_exit'], level: 'advise', gateIds: [], paths: [],
      confirmation: { userConfirmed: true },
    });
    const section = loadGovernanceBriefing(db, {
      project, projectRoot: root, sessionId: 'session-a', clientName: 'claude-code',
      clientInstallationId: null,
    });
    const output = compileBriefing(new MemoryRepository(db), new PlanRepository(db), {
      project, sessionType: 'resume', interrupted: false, briefingMode: 'index',
      budgetOverride: 400, governance: section,
    });
    assert.match(output.text, /advisory; not enforced/u);
    assert.ok(output.tokenEstimate <= 400, `${output.tokenEstimate} exceeds index budget`);
  });
});

describe('capability line wording (field review)', () => {
  let db2: Database.Database;
  let root2: string;
  beforeEach(() => {
    db2 = openDatabase({ dbPath: ':memory:' });
    root2 = mkdtempSync(join(tmpdir(), 'cairn-gov-brief-'));
  });
  afterEach(() => { db2.close(); rmSync(root2, { recursive: true, force: true }); });

  it('an unsupported client reads as a design boundary, never raw degradation codes', () => {
    new GovernanceRuleRepository(db2).create({
      ruleId: 'verify-core', content: 'Verify tests before exit',
      project: 'proj-x', phases: ['pre_exit'], level: 'warn', gateIds: ['test'], paths: ['**'],
      confirmation: { userConfirmed: true },
    });
    const section = loadGovernanceBriefing(db2, {
      project: 'proj-x', projectRoot: root2, sessionId: 's-codex', clientName: 'codex',
      clientInstallationId: 'i-codex', nowMs: Date.parse('2026-08-26T12:00:00.000Z'),
    });
    assert.ok(section, 'a rule exists, so the section renders');
    const output = compileBriefing(new MemoryRepository(db2), new PlanRepository(db2), {
      project: 'proj-x', sessionType: 'startup', interrupted: false, briefingMode: 'full',
      budgetOverride: 600, governance: section,
    });
    // Raw codes next to doctor's "wired and trusted 10/10" read as a
    // health contradiction (field review) — the line must say what it
    // means and drop meaningless secondary reasons.
    assert.match(output.text, /governance advisory is Claude Code-only today/u);
    assert.ok(!output.text.includes('unsupported_client'), 'no raw code in user-facing text');
    assert.ok(!output.text.includes('stale_heartbeat'), 'secondary reasons suppressed for out-of-scope clients');
  });
});
