#!/usr/bin/env node
/**
 * FileChanged hook — fires when watched files change on disk.
 * Checks for file-triggered reminders matching the changed file.
 */
import { readStdinJson, outputAdditionalContext, type FileChangedInput } from './shared/hook-io.js';
import { createHookDbClient } from './shared/db-client.js';
import { projectId } from '../utils/project-id.js';
import { recordTelemetry } from './shared/hook-telemetry.js';
import { recordGovernanceEventFailOpen } from '../governance/recorder.js';

const _startTime = Date.now();
try {
  const input = readStdinJson<FileChangedInput>();
  const filePath = input.file_path;

  if (!filePath) {
    process.exit(0);
  }

  const dbPath = process.env.CAIRN_DB_PATH ?? undefined;
  const client = createHookDbClient(dbPath);
  const project = projectId(input.cwd);

  // Check file-triggered reminders
  const reminders = client.reminderRepo.checkFileReminders(filePath, project);

  if (reminders.length > 0) {
    const lines = reminders.map(r => `[WAYKEEP] Reminder: ${r.action}`);
    outputAdditionalContext('FileChanged', lines.join('\n'));
  }

  await recordGovernanceEventFailOpen(client.db, input);
  client.close();
  recordTelemetry('file-changed', 'check', _startTime, true, undefined, {
    remindersTriggered: reminders.length,
  }, client.db);
} catch (err) {
  recordTelemetry('file-changed', 'error', _startTime, false, String(err));
  process.exit(0);
}
