import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import type { MemoryRepository } from '../../db/memory-repository.js';
import type { PlanRepository } from '../../db/plan-repository.js';
import type { ReminderRepository } from '../../db/reminder-repository.js';
import type Database from 'better-sqlite3';
import { getEmbeddingModelConfig } from '../../utils/embeddings.js';
import { STATS_ACTIONS, HEALTH, CONSOLIDATION, type ContextMode } from '../../constants/index.js';
import { isCritical } from './helpers.js';

type ContextModeFn = () => ContextMode;

const EXTENDED_STATS_ACTIONS = [...STATS_ACTIONS, 'velocity'] as const;

export function registerStatsTools(
  server: McpServer,
  memoryRepo: MemoryRepository,
  _planRepo: PlanRepository,
  _reminderRepo: ReminderRepository,
  db: Database.Database,
  getMode: ContextModeFn,
): void {
  server.registerTool(
    'cairn_stats',
    {
      title: 'Memory Statistics',
      description: 'View memory health, distributions, and analytics. Actions: summary, health, by_kind, by_project, velocity.',
      annotations: { readOnlyHint: true, destructiveHint: false },
      inputSchema: z.object({
        action: z.enum(EXTENDED_STATS_ACTIONS).describe('What statistics to show (velocity = learning curve)'),
      }),
    },
    async ({ action }) => {
      const critical = isCritical(getMode());
      if (critical) return critical;

      if (action === 'summary') {
        const memStats = memoryRepo.getStats();
        const plans = db.prepare(`
          SELECT status, COUNT(*) as cnt FROM plans GROUP BY status
        `).all() as Array<{ status: string; cnt: number }>;
        const planMap: Record<string, number> = {};
        for (const p of plans) planMap[p.status] = p.cnt;
        const totalDecisions = (db.prepare('SELECT COUNT(*) as cnt FROM plan_decisions').get() as { cnt: number }).cnt;

        const reminderStats = db.prepare(`
          SELECT COUNT(*) as total, COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) as activeCount,
            COALESCE(SUM(fire_count), 0) as totalFires
          FROM reminders
        `).get() as { total: number; activeCount: number; totalFires: number };

        const lines = [
          `Memories: ${memStats.active} active, ${memStats.invalidated} invalidated`,
          `  By kind: ${Object.entries(memStats.byKind).map(([k, v]) => `${k}: ${v}`).join(', ')}`,
          `Plans: active: ${planMap.active ?? 0}, completed: ${planMap.completed ?? 0}, abandoned: ${planMap.abandoned ?? 0}`,
          `  Decisions: ${totalDecisions} total`,
          `Reminders: ${reminderStats.activeCount ?? 0} active, ${reminderStats.totalFires ?? 0} total fires`,
        ];
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      if (action === 'health') {
        const health = memoryRepo.getHealthMetrics();
        const lines = [
          `Confidence: high(>${HEALTH.CONFIDENCE_HIGH_THRESHOLD}): ${health.confidenceDistribution.high}, medium(${HEALTH.CONFIDENCE_MEDIUM_THRESHOLD}-${HEALTH.CONFIDENCE_HIGH_THRESHOLD}): ${health.confidenceDistribution.medium}, low(<${HEALTH.CONFIDENCE_MEDIUM_THRESHOLD}): ${health.confidenceDistribution.low}`,
          `Avg confidence: ${health.avgConfidence.toFixed(2)}`,
          `Decay candidates (30d+ no recall): ${health.decayCandidates}`,
          `Never recalled: ${health.neverRecalled}`,
        ];
        if (health.oldestMemory) {
          lines.push(`Oldest: "${health.oldestMemory.content.slice(0, 60)}" (${health.oldestMemory.created_at})`);
        }
        if (health.mostRecalled) {
          lines.push(`Most recalled: "${health.mostRecalled.content.slice(0, 60)}" (${health.mostRecalled.recall_count}x)`);
        }

        // Memory impact tracking
        try {
          const impactStats = db.prepare(`
            SELECT COUNT(*) as surfaced,
              SUM(CASE WHEN impact_count > 0 THEN 1 ELSE 0 END) as impactful,
              SUM(CASE WHEN surface_count >= ${HEALTH.ZERO_IMPACT_MIN_SURFACES} AND impact_count = 0 THEN 1 ELSE 0 END) as zero_impact
            FROM memories WHERE invalidated = 0 AND kind != 'rule' AND surface_count > 0
          `).get() as { surfaced: number; impactful: number; zero_impact: number };
          if (impactStats.surfaced > 0) {
            const rate = impactStats.impactful / impactStats.surfaced * 100;
            lines.push(`Impact: ${impactStats.impactful}/${impactStats.surfaced} surfaced memories had positive impact (${rate.toFixed(0)}%)`);
            if (impactStats.zero_impact > 0) {
              lines.push(`  ⚠ ${impactStats.zero_impact} memories surfaced ${HEALTH.ZERO_IMPACT_MIN_SURFACES}+ times with zero impact — review with cairn_export`);
            }
          }
        } catch {
          // surface_count column may not exist on older schemas
        }

        // Hook telemetry health
        try {
          const hookHealth = db.prepare(`
            SELECT hook_name, COUNT(*) as runs,
              SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failures,
              AVG(duration_ms) as avg_duration_ms
            FROM hook_telemetry
            WHERE created_at > datetime('now', '-1 day')
            GROUP BY hook_name
          `).all() as Array<{ hook_name: string; runs: number; failures: number; avg_duration_ms: number }>;
          if (hookHealth.length > 0) {
            lines.push('Hook health (24h):');
            for (const h of hookHealth) {
              lines.push(`  ${h.hook_name}: ${h.runs} runs, ${h.failures} failures, avg ${Math.round(h.avg_duration_ms)}ms`);
            }
          }
        } catch {
          // hook_telemetry table may not exist
        }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      if (action === 'by_kind') {
        const byKind = memoryRepo.getStatsByKind();
        const lines = byKind.map(k =>
          `${k.kind}: ${k.count} memories, avg conf: ${k.avgConfidence.toFixed(2)}, total recalls: ${k.totalRecalls}`
        );
        return { content: [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : 'No memories found.' }] };
      }

      if (action === 'by_project') {
        const byProject = memoryRepo.getStatsByProject();
        const lines = byProject.map(p => {
          const proj = p.project ?? '(global)';
          return `${proj}: ${p.count} memories, avg conf: ${p.avgConfidence.toFixed(2)}, last activity: ${p.lastActivity ?? 'never'}`;
        });
        return { content: [{ type: 'text', text: lines.length > 0 ? lines.join('\n') : 'No memories found.' }] };
      }

      if (action === 'velocity') {
        const lines: string[] = ['Learning Velocity:'];

        // Memories created per week (last 4 weeks)
        try {
          const weeklyRows = db.prepare(`
            SELECT
              CAST((julianday('now') - julianday(created_at)) / 7 AS INTEGER) AS weeks_ago,
              COUNT(*) AS count
            FROM memories WHERE invalidated = 0 AND kind != 'rule'
              AND created_at > datetime('now', '-28 days')
            GROUP BY weeks_ago ORDER BY weeks_ago ASC
          `).all() as Array<{ weeks_ago: number; count: number }>;
          if (weeklyRows.length > 0) {
            lines.push('  Weekly new memories:');
            for (const w of weeklyRows) {
              const label = w.weeks_ago === 0 ? 'this week' : `${w.weeks_ago}w ago`;
              lines.push(`    ${label}: ${w.count}`);
            }
          }
        } catch { /* best-effort */ }

        // Embedding coverage — ACTIVE-model only (v26): after a model
        // switch, stale-model vectors are invisible to vector search and
        // pending re-embed, so counting them as covered would hide the
        // transition backlog.
        try {
          const activeKey = getEmbeddingModelConfig().key;
          const embRow = db.prepare(`
            SELECT
              COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN embedding IS NOT NULL AND embedding_model = ? THEN 1 ELSE 0 END), 0) AS with_embedding,
              COALESCE(SUM(CASE WHEN embedding IS NOT NULL AND COALESCE(embedding_model, '') != ? THEN 1 ELSE 0 END), 0) AS stale_model
            FROM memories WHERE invalidated = 0 AND kind != 'rule'
          `).get(activeKey, activeKey) as { total: number; with_embedding: number; stale_model: number };
          const pct = embRow.total > 0 ? Math.round(embRow.with_embedding / embRow.total * 100) : 0;
          const stale = embRow.stale_model > 0 ? `, ${embRow.stale_model} stale-model pending re-embed` : '';
          lines.push(`  Embedding coverage (${activeKey}): ${embRow.with_embedding}/${embRow.total} (${pct}%${stale})`);
        } catch { /* best-effort */ }

        // Anchor coverage
        try {
          const anchorRow = db.prepare(`
            SELECT
              COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN anchor IS NOT NULL THEN 1 ELSE 0 END), 0) AS with_anchor
            FROM memories WHERE invalidated = 0 AND kind != 'rule'
          `).get() as { total: number; with_anchor: number };
          const pct = anchorRow.total > 0 ? Math.round(anchorRow.with_anchor / anchorRow.total * 100) : 0;
          lines.push(`  Anchor coverage: ${anchorRow.with_anchor}/${anchorRow.total} (${pct}%)`);
        } catch { /* best-effort */ }

        // Graph density (edges per memory)
        try {
          const edgeRow = db.prepare(`
            SELECT COUNT(*) AS edges FROM memory_edges
          `).get() as { edges: number };
          const memCount = memoryRepo.getStats().active;
          const density = memCount > 0 ? (edgeRow.edges / memCount).toFixed(2) : '0';
          lines.push(`  Graph: ${edgeRow.edges} edges, ${density} edges/memory`);
        } catch { /* best-effort */ }

        // Consolidation opportunities
        try {
          const dupRow = db.prepare(`
            SELECT kind, COUNT(*) AS count FROM memories
            WHERE invalidated = 0 AND kind IN (${CONSOLIDATION.ELIGIBLE_KINDS.map(() => '?').join(',')})
            GROUP BY kind HAVING count >= 2
          `).all(...CONSOLIDATION.ELIGIBLE_KINDS) as Array<{ kind: string; count: number }>;
          if (dupRow.length > 0) {
            lines.push(`  Consolidation eligible: ${dupRow.map(r => `${r.kind}: ${r.count}`).join(', ')}`);
          }
        } catch { /* best-effort */ }

        // Cross-project patterns
        try {
          const crossRow = db.prepare(`
            SELECT COUNT(DISTINCT project) AS projects FROM memories
            WHERE invalidated = 0 AND kind != 'rule' AND project IS NOT NULL
          `).get() as { projects: number };
          const globalRow = db.prepare(`
            SELECT COUNT(*) AS count FROM memories WHERE invalidated = 0 AND kind != 'rule' AND project IS NULL
          `).get() as { count: number };
          lines.push(`  Projects tracked: ${crossRow.projects}, global memories: ${globalRow.count}`);
        } catch { /* best-effort */ }

        // Session recall precision (last 5 sessions)
        try {
          const precRows = db.prepare(`
            SELECT s.id,
              COUNT(sm.memory_id) AS recalled,
              SUM(CASE WHEN sm.led_to_success = 1 THEN 1 ELSE 0 END) AS successful
            FROM sessions s
            LEFT JOIN session_memories sm ON s.id = sm.session_id
            WHERE s.ended_at IS NOT NULL
            GROUP BY s.id
            HAVING recalled > 0
            ORDER BY s.started_at DESC
            LIMIT 5
          `).all() as Array<{ id: string; recalled: number; successful: number }>;
          if (precRows.length > 0) {
            const avgPrec = precRows.reduce((sum, r) => sum + r.successful / r.recalled, 0) / precRows.length;
            lines.push(`  Recall precision (last ${precRows.length} sessions): ${(avgPrec * 100).toFixed(0)}%`);
          }
        } catch { /* best-effort */ }

        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      return { content: [{ type: 'text', text: `Unknown action: ${action}` }], isError: true };
    },
  );
}
