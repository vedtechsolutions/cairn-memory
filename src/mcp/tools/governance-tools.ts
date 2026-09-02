import type Database from 'better-sqlite3';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import * as z from 'zod/v4';
import {
  GovernanceOverrideStore, GOVERNANCE_OVERRIDE_DEFAULT_DURATION_MS,
} from '../../governance/governance-overrides.js';
import { deriveGovernanceOverrideContext } from '../../governance/override-context.js';
import { TOOL } from '../../constants/mcp.js';
import { registerToolCompat } from './helpers.js';

const OVERRIDE_CLIENT_NAME = 'claude-code';

function reply(text: string, isError = false) {
  return { content: [{ type: 'text' as const, text }], ...(isError ? { isError: true } : {}) };
}

export function registerGovernanceTools(
  server: McpServer,
  db: Database.Database,
  innerServer: Server,
): void {
  registerToolCompat(server, TOOL.GOVERNANCE_OVERRIDE, {
    title: 'Confirm Governance Override',
    description: 'Request a temporary, session-bound governance gate override. Requires direct user confirmation.',
    inputSchema: z.object({
      project_root: z.string().min(1).max(512),
      session_id: z.string().min(1).max(512),
      expires_in_minutes: z.number().int().min(1).max(24 * 60).optional(),
    }).strict(),
  }, async ({ project_root: projectRoot, session_id: sessionId, expires_in_minutes: minutes }) => {
    try {
      const nowMs = Date.now();
      const context = await deriveGovernanceOverrideContext(db, {
        projectRoot, sessionId, clientName: OVERRIDE_CLIENT_NAME, nowMs,
      });
      const elicited = await innerServer.elicitInput({
        mode: 'form',
        message: [
          `Confirm a temporary governance override for project ${context.project}.`,
          `Rules: ${context.rules.map(rule => `${rule.ruleId}@${rule.revision}`).join(', ')}`,
          `Gates: ${context.gateIds.join(', ')}`,
          'This permits Stop but does not change policy.',
        ].join('\n'),
        requestedSchema: {
          type: 'object',
          properties: {
            confirm: { type: 'boolean', title: 'Confirm temporary override' },
            reason: { type: 'string', title: 'Reason', minLength: 1, maxLength: 500 },
          },
          required: ['confirm', 'reason'],
        },
      });
      const content = elicited.content as Record<string, unknown> | undefined;
      if (elicited.action !== 'accept' || content?.confirm !== true || typeof content.reason !== 'string') {
        return reply('Governance override cancelled.');
      }
      const created = new GovernanceOverrideStore(db).create({
        ...context, clientName: OVERRIDE_CLIENT_NAME, reason: content.reason,
        confirmation: { userConfirmed: true, mechanism: 'mcp-elicitation' },
        durationMs: minutes === undefined
          ? GOVERNANCE_OVERRIDE_DEFAULT_DURATION_MS : minutes * 60_000,
        nowMs,
      });
      return reply(`Governance override recorded (audit ${created.auditId}); expires ${created.expiresAt}.`);
    } catch (error) {
      return reply(`Governance override not recorded: ${error instanceof Error ? error.message : 'unknown error'}`, true);
    }
  });
}
