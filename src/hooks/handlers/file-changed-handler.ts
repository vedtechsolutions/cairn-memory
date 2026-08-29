/**
 * FileChanged handler — checks for file-triggered reminders.
 * Pure business logic: no stdin/stdout/process.exit.
 */
import type { FileChangedInput } from '../shared/hook-io.js';
import type { HookDbClient } from '../shared/db-client.js';
import { projectId } from '../../utils/project-id.js';
import { recordGovernanceEventFailOpen } from '../../governance/recorder.js';
import type { RecorderDiagnostic } from '../../governance/types.js';

export interface FileChangedResult {
  /** Context to inject, or null */
  output: string | null;
  remindersTriggered: number;
  /** Internal-only recorder status; route output deliberately omits it. */
  recorder?: RecorderDiagnostic;
}

export async function handleFileChanged(
  input: FileChangedInput,
  client: HookDbClient,
): Promise<FileChangedResult> {
  const result = handleFileChangedBusiness(input, client);
  return { ...result, recorder: await recordGovernanceEventFailOpen(client.db, input) };
}

function handleFileChangedBusiness(input: FileChangedInput, client: HookDbClient): FileChangedResult {
  const filePath = input.file_path;
  if (!filePath) {
    return { output: null, remindersTriggered: 0 };
  }

  const project = projectId(input.cwd);
  const reminders = client.reminderRepo.checkFileReminders(filePath, project);

  if (reminders.length > 0) {
    const lines = reminders.map(r => `[WAYKEEP] Reminder: ${r.action}`);
    // NOT a report cost surface: file-changed is an ASYNC route, so this
    // additionalContext is never injected (async responses are discarded)
    // — recording it billed for undelivered text (review round 2). Same
    // latent delivery gap as error-learning; recorded in the backlog.
    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'FileChanged',
        additionalContext: lines.join('\n'),
      },
    });
    return { output, remindersTriggered: reminders.length };
  }

  return { output: null, remindersTriggered: 0 };
}
