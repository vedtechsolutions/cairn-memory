import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { ReminderRepository } from '../../db/reminder-repository.js';
import type { SessionCache } from '../../hooks/shared/session-cache.js';
import { LIMITS, type ContextMode } from '../../constants/index.js';
import { isCritical } from './helpers.js';

type ContextModeFn = () => ContextMode;

export function registerReminderTools(
  server: McpServer,
  repo: ReminderRepository,
  getMode: ContextModeFn,
  sessionCache?: SessionCache,
): void {
  // --- cairn_remind -----------------------------------------------------------

  server.registerTool(
    'cairn_remind',
    {
      title: 'Set Reminder',
      description: 'Create a trigger-action reminder: "when I encounter [trigger], remind me to [action]". Fires automatically on matching prompts.',
      inputSchema: z.object({
        trigger: z.string().max(200).describe('Keywords/phrase that should trigger this reminder'),
        action: z.string().max(200).describe('What to remind about when trigger matches'),
        project: z.string().max(200).nullable().optional().describe('Project scope (null = global)'),
        max_fires: z.number().int().min(0).optional().describe('0 = unlimited, N = deactivate after N fires'),
        trigger_type: z.enum(['prompt', 'file', 'time', 'conditional']).optional()
          .describe('Trigger type: prompt (default, FTS match), file (path match), time (scheduled), conditional'),
        trigger_config: z.object({
          filePaths: z.array(z.string()).optional().describe('File paths for file-triggered reminders'),
          nextDue: z.string().optional().describe('ISO date for time-triggered reminders'),
          condition: z.string().optional().describe('Condition expression for conditional reminders'),
        }).optional().describe('Configuration for non-prompt trigger types'),
      }),
    },
    async ({ trigger, action, project, max_fires: maxFires, trigger_type: triggerType, trigger_config: triggerConfig }) => {
      const critical = isCritical(getMode());
      if (critical) return critical;

      const result = repo.create({
        trigger,
        action,
        project: project ?? null,
        max_fires: maxFires,
        trigger_type: triggerType,
        trigger_config: triggerConfig,
      });

      if ('error' in result) {
        return { content: [{ type: 'text', text: `error: ${result.error}` }], isError: true };
      }

      // New reminder affects pitfall-handler's file/conditional reminder surfacing.
      sessionCache?.bumpMemoryVersion();

      return { content: [{ type: 'text', text: 'ok' }] };
    },
  );

  // --- cairn_reminder_list -----------------------------------------------------

  server.registerTool(
    'cairn_reminder_list',
    {
      title: 'List Reminders',
      description: 'List active reminders.',
      inputSchema: z.object({
        project: z.string().max(LIMITS.MAX_STRING_PARAM).nullable().optional()
          .describe('Filter by project (null = global, omit = all)'),
      }),
    },
    async ({ project }) => {
      const critical = isCritical(getMode());
      if (critical) return critical;

      const reminders = repo.listActive(repo.resolveProject(project));
      if (reminders.length === 0) {
        return { content: [{ type: 'text', text: 'No active reminders.' }] };
      }
      const lines = reminders.map(r => {
        const scope = r.project ? `[${r.project}]` : '[global]';
        const fires = r.max_fires > 0
          ? `${r.fire_count}/${r.max_fires} fires`
          : `${r.fire_count} fires`;
        return `• ${r.id}: when "${r.trigger_pattern}" → "${r.action}" ${scope} (${fires})`;
      });
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    },
  );

  // --- cairn_reminder_delete ---------------------------------------------------

  server.registerTool(
    'cairn_reminder_delete',
    {
      title: 'Delete Reminder',
      description: 'Delete or deactivate a reminder by ID.',
      inputSchema: z.object({
        id: z.string().describe('Reminder ID to delete'),
        permanent: z.boolean().optional().describe('true = hard delete, false/omit = deactivate'),
      }),
    },
    async ({ id, permanent }) => {
      if (permanent) {
        const ok = repo.delete(id);
        if (ok) sessionCache?.bumpMemoryVersion();
        return { content: [{ type: 'text', text: ok ? 'deleted' : 'not found' }] };
      }
      const ok = repo.deactivate(id);
      if (ok) sessionCache?.bumpMemoryVersion();
      return { content: [{ type: 'text', text: ok ? 'deactivated' : 'not found' }] };
    },
  );
}
