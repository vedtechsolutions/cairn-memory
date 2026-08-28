/**
 * FileChanged handler — checks for file-triggered reminders.
 * Pure business logic: no stdin/stdout/process.exit.
 */
import type { FileChangedInput } from '../shared/hook-io.js';
import { recordRollup } from '../../db/telemetry-rollup.js';
import { ROLLUP_METRICS } from '../../constants/index.js';
import { estimateTokensFast } from '../../utils/tokens.js';
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
    const lines = reminders.map(r => `[CAIRN] Reminder: ${r.action}`);
    const context = lines.join('\n');
    recordRollup(client.db, input.session_id, ROLLUP_METRICS.INJECTED, 'file-changed', estimateTokensFast(context));
    const output = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'FileChanged',
        additionalContext: context,
      },
    });
    return { output, remindersTriggered: reminders.length };
  }

  return { output: null, remindersTriggered: 0 };
}
