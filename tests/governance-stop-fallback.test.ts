import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from '../src/db/connection.js';
import { projectId } from '../src/utils/project-id.js';
import { nodeGrandchildSkipReason } from './spawn-probe.js';

function runFallback(script: string, input: string, env: NodeJS.ProcessEnv): Promise<{
  status: number | null; stdout: string; stderr: string;
}> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [script], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('standalone Stop fallback timed out'));
    }, 15_000);
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += String(chunk); });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += String(chunk); });
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.on('close', status => {
      clearTimeout(timeout);
      resolveResult({ status, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

describe('standalone Stop fallback shadow wiring', () => {
  it('records Stop support, emits no control output, and exits zero for a short message', async (t) => {
    const skip = nodeGrandchildSkipReason();
    if (skip) return t.skip(skip);
    const root = mkdtempSync(join(tmpdir(), 'cairn-stop-fallback-root-'));
    const state = mkdtempSync(join(tmpdir(), 'cairn-stop-fallback-state-'));
    const dbPath = join(state, 'cairn.db');
    try {
      const result = await runFallback(
        resolve('dist/src/hooks/stop.js'),
        JSON.stringify({
          session_id: 'fallback-session', transcript_path: join(root, 'transcript.jsonl'),
          cwd: root, stop_hook_active: false, last_assistant_message: 'short',
          client_name: 'claude-code', client_installation_id: 'fallback-install',
        }),
        { ...process.env, CAIRN_DB_PATH: dbPath, CAIRN_DIR: state },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '', 'shadow verdict must never reach stdout');
      const db = openDatabase({ dbPath });
      try {
        const row = db.prepare(`
          SELECT supports_stop, last_session_id
          FROM governance_client_state
          WHERE project = ? AND client_installation_id = 'fallback-install'
        `).get(projectId(root)) as { supports_stop: number; last_session_id: string };
        assert.equal(row.supports_stop, 1);
        assert.equal(row.last_session_id, 'fallback-session');
      } finally {
        db.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(state, { recursive: true, force: true });
    }
  });
});
