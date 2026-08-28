/**
 * Directory listing builders (W4 v3.1 §8) — which files "exist" under
 * /memories (a category file exists iff it has active records; plan.md
 * exists iff a plan is active) and their rendered sizes.
 */
import type Database from 'better-sqlite3';
import type { PlanRepository } from '../db/plan-repository.js';
import { activeRows } from './active-rows.js';
import {
  CATEGORY_KINDS, GLOBAL_SEGMENT, MEMORY_ROOT, encodeProjectSegment, type Category,
} from './path-router.js';
import { materializeView, type Log, type MaterializableCategory } from './materializer.js';
import type { RenderCache } from './render-cache.js';
import { renderPlanLines, type ListingEntry } from './view-renderer.js';

const LISTABLE_CATEGORIES = (Object.keys(CATEGORY_KINDS) as Category[])
  .filter((c): c is MaterializableCategory => c !== 'plan');

export function categoryPath(project: string | null, category: string): string {
  const dir = project === null ? GLOBAL_SEGMENT : encodeProjectSegment(project);
  return `${MEMORY_ROOT}/${dir}/${category}.md`;
}

export function directoryEntries(
  db: Database.Database,
  planRepo: PlanRepository,
  cache: RenderCache,
  project: string | null,
  log: Log,
): ListingEntry[] {
  const entries: ListingEntry[] = [];
  for (const category of LISTABLE_CATEGORIES) {
    if (project !== null && category === 'user-profile') continue;
    // Existence comes from RAW active rows: a file whose every record is
    // unrenderable still exists (it views as a warning line).
    if (activeRows(db, project, CATEGORY_KINDS[category]).length === 0) continue;
    const path = categoryPath(project, category);
    const view = materializeView(db, path, project, category, cache, false, log);
    entries.push({ path, bytes: Buffer.byteLength(view.lines.join('\n'), 'utf8') });
  }
  if (project !== null && planRepo.getActive(project)) {
    const lines = renderPlanLines(planRepo, project) ?? [];
    entries.push({ path: categoryPath(project, 'plan'), bytes: Buffer.byteLength(lines.join('\n'), 'utf8') });
  }
  return entries;
}

export function rootEntries(
  db: Database.Database,
  planRepo: PlanRepository,
  cache: RenderCache,
  log: Log,
): ListingEntry[] {
  const entries: ListingEntry[] = [];
  // Plan-only projects (a plan but no memories yet) must still list.
  const projects = db.prepare(`
    SELECT DISTINCT project FROM (
      SELECT project FROM memories WHERE invalidated = 0 AND superseded_by IS NULL AND kind != 'rule'
      UNION SELECT project FROM plans WHERE status = 'active'
    )
  `).all() as Array<{ project: string | null }>;
  for (const { project } of projects) {
    for (const entry of directoryEntries(db, planRepo, cache, project, log)) entries.push(entry);
  }
  const files = db.prepare(
    'SELECT path, length(CAST(content AS BLOB)) AS bytes FROM memory_files ORDER BY path'
  ).all() as Array<{ path: string; bytes: number }>;
  for (const f of files) entries.push({ path: f.path, bytes: f.bytes });
  return entries;
}
