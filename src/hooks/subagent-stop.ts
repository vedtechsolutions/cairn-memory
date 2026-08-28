#!/usr/bin/env node
/**
 * SubagentStop hook — capture subagent outcomes.
 * Extracts key findings from subagent's last message and records
 * progress notes on the active plan step.
 */
import { readStdinJson, type SubagentStopInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { projectId } from '../utils/project-id.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { TOKEN_BUDGET } from '../constants/index.js';

const _startTime = Date.now();
try {
  const input = readStdinJson<SubagentStopInput>();
  const message = input.last_assistant_message;

  if (!message || message.length < 30) {
    process.exit(0);
  }

  const dbPath = process.env.CAIRN_DB_PATH ?? undefined;
  const client = createHookDbClient(dbPath);
  const project = projectId(input.cwd);

  // Add subagent outcome as a note on the active plan step
  const activePlan = client.planRepo.getActive(project);
  if (activePlan) {
    const inProgress = activePlan.steps.find(s => s.status === 'in_progress');
    if (inProgress) {
      // Extract a summary from the last message (first meaningful sentence)
      const summary = extractSummary(message);
      if (summary) {
        const note = `[${input.agent_type ?? 'subagent'}] ${summary}`;
        client.planRepo.addNote(activePlan.id, {
          step_id: inProgress.step_id,
          note: note.slice(0, TOKEN_BUDGET.NOTE_MAX_CHARS),
        });
      }
    }
  }

  client.close();
  recordTelemetry('subagent-stop', input.agent_type ?? 'unknown', _startTime, true);
} catch (err) {
  recordTelemetry('subagent-stop', 'error', _startTime, false, String(err));
  process.exit(0);
}

/** Extract a meaningful summary from subagent's last message */
function extractSummary(text: string): string | null {
  // Take first sentence that's substantial enough
  const sentences = text.split(/[.!?\n]/).map(s => s.trim()).filter(s => s.length >= 20);
  if (sentences.length === 0) return null;

  // Prefer sentences with result/action words
  const actionSentence = sentences.find(s =>
    /\b(found|created|fixed|updated|resolved|implemented|completed|added|removed|changed)\b/i.test(s)
  );
  return (actionSentence ?? sentences[0]).slice(0, 140);
}
