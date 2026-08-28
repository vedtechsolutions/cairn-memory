/**
 * SubagentStop handler — capture subagent outcomes.
 * Pure business logic: no stdin/stdout/process.exit.
 */
import type { SubagentStopInput } from '../shared/hook-io.js';
import type { HookDbClient } from '../shared/db-client.js';
import { projectId } from '../../utils/project-id.js';
import { TOKEN_BUDGET } from '../../constants/index.js';

export interface SubagentStopResult {
  noted: boolean;
}

export function handleSubagentStop(input: SubagentStopInput, client: HookDbClient): SubagentStopResult {
  const message = input.last_assistant_message;
  if (!message || message.length < 30) {
    return { noted: false };
  }

  const project = projectId(input.cwd);
  const activePlan = client.planRepo.getActive(project);
  if (!activePlan) {
    return { noted: false };
  }

  const inProgress = activePlan.steps.find(s => s.status === 'in_progress');
  if (!inProgress) {
    return { noted: false };
  }

  const summary = extractSummary(message);
  if (!summary) {
    return { noted: false };
  }

  const note = `[${input.agent_type ?? 'subagent'}] ${summary}`;
  const trimmed = note.slice(0, TOKEN_BUDGET.NOTE_MAX_CHARS);

  // GAP I: skip append when the last note on the target step is identical
  // (normalised). Prevents spam on long sessions where the same subagent
  // returns with the same summary across multiple fires.
  const lastNote = inProgress.notes[inProgress.notes.length - 1]?.note;
  if (lastNote && normaliseNote(lastNote) === normaliseNote(trimmed)) {
    return { noted: false };
  }

  client.planRepo.addNote(activePlan.id, {
    step_id: inProgress.step_id,
    note: trimmed,
  });

  return { noted: true };
}

function normaliseNote(n: string): string {
  return n.toLowerCase().replace(/\s+/g, ' ').trim();
}

function extractSummary(text: string): string | null {
  const sentences = text.split(/[.!?\n]/).map(s => s.trim()).filter(s => s.length >= 20);
  if (sentences.length === 0) return null;

  const actionSentence = sentences.find(s =>
    /\b(found|created|fixed|updated|resolved|implemented|completed|added|removed|changed)\b/i.test(s)
  );
  return (actionSentence ?? sentences[0]).slice(0, 140);
}
