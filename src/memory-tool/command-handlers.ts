/**
 * Memory-tool command handlers (W4 v3.1 §5, §6, §8). Guarantees: immediate
 * write transactions cover ALL checks and writes; existence = RAW active
 * rows; directory mutations touch only VFS-OWNED kinds; canonical cache
 * keys invalidated ONLY after successful commits; zero mutation on every
 * error path; gateway tokens rendered from the POST-rollback store.
 */
import type Database from 'better-sqlite3';
import type { PlanRepository } from '../db/plan-repository.js';
import { activeRows } from './active-rows.js';
import { parseBlocks, type BlockToken } from './block-parser.js';
import { verifyOldBlocks } from './cas.js';
import { ERR } from './errors.js';
import {
  freeFormDelete, freeFormDeleteUnder, freeFormInsert, freeFormRename,
  freeFormReplace, readFreeForm, writeFreeForm,
} from './free-form-store.js';
import { executeCreatePlan, plannerErrorToContract } from './gateway-planner.js';
import { categoryPath, directoryEntries, rootEntries } from './listings.js';
import { materializeView, type Log, type MaterializableCategory } from './materializer.js';
import {
  CATEGORY_KINDS, GLOBAL_SEGMENT, MEMORY_ROOT, encodeProjectSegment,
  routeMemoryPath, vfsOwnedKinds, type RoutedPath,
} from './path-router.js';
import { applyRecordUpdate } from './record-updater.js';
import {
  journalTombstonesForIds, journalUpsertsForIds, retireIdsByInvalidation,
} from '../db/memory-repository/journal.js';
import { RenderCache } from './render-cache.js';
import { renderDirectoryListing, renderFileView, renderPlanLines } from './view-renderer.js';

export interface HandlerDeps {
  db: Database.Database;
  planRepo: PlanRepository;
  cache?: RenderCache;
  log?: Log;
}

type Materialized = Extract<RoutedPath, { type: 'materialized' }>;
type WritableMaterialized = Materialized & { category: MaterializableCategory };

/** Narrows plan.md out of the write paths (router readOnly's type twin). */
function assertWritable(route: Materialized, path: string): asserts route is WritableMaterialized {
  if (route.readOnly || route.category === 'plan') {
    throw new Error(ERR.readOnlyPlan(path));
  }
}

const canonicalDir = (project: string | null): string =>
  project === null ? `${MEMORY_ROOT}/${GLOBAL_SEGMENT}` : `${MEMORY_ROOT}/${encodeProjectSegment(project)}`;

/** ONLY cache key + invalidation endpoint — aliases can't go stale. */
const canonicalFile = (route: Materialized): string => categoryPath(route.project, route.category);

const tok = (t: BlockToken): string => `[${t.code}:${t.idPrefix}@${t.revision}]`;

export class MemoryCommandHandlers {
  private readonly db: Database.Database;
  private readonly planRepo: PlanRepository;
  private readonly cache: RenderCache;
  private readonly log: Log;

  constructor(deps: HandlerDeps) {
    this.db = deps.db;
    this.planRepo = deps.planRepo;
    this.cache = deps.cache ?? new RenderCache();
    this.log = deps.log ?? ((m) => console.error(`[cairn:memory-tool] ${m}`));
  }

  // --- view -------------------------------------------------------------------

  view(rawPath: string, viewRange?: [number, number]): string {
    const route = routeMemoryPath(rawPath);
    if (route.type === 'root') {
      return renderDirectoryListing(MEMORY_ROOT, rootEntries(this.db, this.planRepo, this.cache, this.log));
    }
    if (route.type === 'directory') {
      const entries = directoryEntries(this.db, this.planRepo, this.cache, route.project, this.log);
      if (entries.length === 0) throw new Error(ERR.nonexistent(rawPath));
      return renderDirectoryListing(canonicalDir(route.project), entries);
    }
    if (route.type === 'free-form') {
      const content = readFreeForm(this.db, route.path);
      if (content === null) throw new Error(ERR.nonexistent(route.path));
      return renderFileView(route.path, content.split('\n'), viewRange);
    }
    return renderFileView(canonicalFile(route), this.materializedLines(route, viewRange !== undefined), viewRange);
  }

  private materializedLines(route: Materialized, ranged: boolean): readonly string[] {
    const path = canonicalFile(route);
    if (route.category === 'plan') {
      const lines = route.project === null ? null : renderPlanLines(this.planRepo, route.project);
      if (!lines) throw new Error(ERR.nonexistent(path));
      return lines;
    }
    const view = materializeView(this.db, path, route.project, route.category, this.cache, ranged, this.log);
    if (view.lines.length === 0) throw new Error(ERR.nonexistent(path));
    return view.lines;
  }

  /** Gateway markers convert to contract errors only AFTER the outer
   *  rollback restored the store — tokens never show ephemeral state. */
  private runPlanned(run: () => void, route: WritableMaterialized, path: string): void {
    try {
      run();
    } catch (err) {
      throw plannerErrorToContract(this.db, err, route.category, route.project, path, this.log) ?? err;
    }
  }

  // --- create -----------------------------------------------------------------

  create(rawPath: string, fileText: string): string {
    const route = routeMemoryPath(rawPath);
    if (route.type === 'root' || route.type === 'directory') {
      throw new Error(ERR.isDirectory(rawPath));
    }
    if (route.type === 'free-form') {
      writeFreeForm(this.db, route.path, fileText);
      return `File created successfully at: ${route.path}`;
    }
    assertWritable(route, rawPath);
    const blocks = parseBlocks(fileText);
    if (blocks.some(b => b.token !== undefined)) throw new Error(ERR.createTokenless());
    const path = canonicalFile(route);
    const createdIds = new Set<string>();
    const run = this.db.transaction(() => {
      // Existence = RAW active rows, rechecked INSIDE the transaction (§5).
      if (activeRows(this.db, route.project, CATEGORY_KINDS[route.category]).length > 0) {
        throw new Error(ERR.alreadyExists(path));
      }
      for (const block of blocks) executeCreatePlan(this.db, block, route.category, route.project, createdIds);
    });
    this.runPlanned(() => run.immediate(), route, path);
    this.cache.invalidate(path);
    return `File created successfully at: ${path}`;
  }

  // --- str_replace ------------------------------------------------------------

  strReplace(rawPath: string, oldStr: string, newStr?: string): string {
    const route = routeMemoryPath(rawPath);
    if (route.type === 'root' || route.type === 'directory') throw new Error(ERR.nonexistent(rawPath));
    if (route.type === 'free-form') return freeFormReplace(this.db, route.path, oldStr, newStr ?? '');
    assertWritable(route, rawPath);

    const oldBlocks = parseBlocks(oldStr);
    if (oldBlocks.some(b => b.token === undefined)) throw new Error(ERR.oldStrMustBeTokened());
    const newBlocks = newStr === undefined || newStr === '' ? [] : parseBlocks(newStr);
    const path = canonicalFile(route);
    const createdIds = new Set<string>();

    const run = this.db.transaction(() => {
      const resolved = verifyOldBlocks(this.db, oldBlocks, route.project, route.category, path, this.log);
      const usedPrefixes = new Set<string>();
      for (const block of newBlocks) {
        if (block.token === undefined) {
          executeCreatePlan(this.db, block, route.category, route.project, createdIds);
          continue;
        }
        const match = resolved.get(block.token.idPrefix);
        if (!match || match.token.code !== block.token.code || match.token.revision !== block.token.revision) {
          throw new Error(ERR.newTokenMismatch(tok(block.token)));
        }
        if (usedPrefixes.has(block.token.idPrefix)) {
          throw new Error(ERR.newTokenDuplicate(tok(block.token)));
        }
        usedPrefixes.add(block.token.idPrefix);
        applyRecordUpdate(this.db, match.record.id, match.record.content, block);
      }
      const dropped = [...resolved]
        .filter(([prefix]) => !usedPrefixes.has(prefix))
        .map(([, r]) => r.record.id);
      // Explicit user removals: tombstone log + journal (journal.ts VFS
      // semantics), inside this command's transaction.
      retireIdsByInvalidation(this.db, dropped);
    });
    this.runPlanned(() => run.immediate(), route, path);
    this.cache.invalidate(path);
    const snippet = renderFileView(path, this.materializedLines(route, false));
    return `The memory file has been edited.\n${snippet}`;
  }

  // --- insert -----------------------------------------------------------------

  insert(rawPath: string, insertLine: number, insertText: string): string {
    const route = routeMemoryPath(rawPath);
    if (route.type === 'root' || route.type === 'directory') throw new Error(ERR.nonexistent(rawPath));
    if (route.type === 'free-form') return freeFormInsert(this.db, route.path, insertLine, insertText);
    assertWritable(route, rawPath);

    const blocks = parseBlocks(insertText);
    if (blocks.some(b => b.token !== undefined)) throw new Error(ERR.insertTokenless());
    const path = canonicalFile(route);
    const createdIds = new Set<string>();
    const run = this.db.transaction(() => {
      // Existence, rendering, line validation INSIDE the transaction —
      // no writer can slip between the checks and the creates.
      const rendered = this.materializedLines(route, false);
      if (!Number.isSafeInteger(insertLine) || insertLine < 0 || insertLine > rendered.length) {
        throw new Error(ERR.invalidInsertLine(insertLine, rendered.length));
      }
      for (const block of blocks) executeCreatePlan(this.db, block, route.category, route.project, createdIds);
    });
    this.runPlanned(() => run.immediate(), route, path);
    this.cache.invalidate(path);
    return `The file ${path} has been edited.`;
  }

  // --- delete -----------------------------------------------------------------

  delete(rawPath: string): string {
    const route = routeMemoryPath(rawPath);
    if (route.type === 'root') throw new Error(ERR.cannotDeleteRoot(MEMORY_ROOT));
    if (route.type === 'directory') return this.deleteDirectory(route.project);
    if (route.type === 'free-form') return freeFormDelete(this.db, route.path);
    assertWritable(route, rawPath);
    const path = canonicalFile(route);
    let invalidated = 0;
    const run = this.db.transaction(() => {
      // RAW rows: corrupt-but-active records are deleted too, not skipped.
      const rows = activeRows(this.db, route.project, CATEGORY_KINDS[route.category]);
      if (rows.length === 0) throw new Error(ERR.nonexistent(path));
      // Explicit user deletion: tombstone log + journal (journal.ts VFS
      // semantics), not a bare flag flip.
      invalidated = retireIdsByInvalidation(this.db, rows.map((r) => r.id));
    });
    run.immediate();
    this.cache.invalidate(path);
    return `Successfully deleted ${path}\n(${invalidated} records invalidated)`;
  }

  private deleteDirectory(project: string | null): string {
    const dir = canonicalDir(project);
    // VFS-OWNED kinds only: unmapped kinds (task_state) are invisible to
    // this tool and must never be mutated by directory-level operations.
    const kinds = vfsOwnedKinds(project);
    let records = 0;
    let files = 0;
    const run = this.db.transaction(() => {
      // plan.md is read-only: atomic rejection (§3), INSIDE the txn.
      if (project !== null && this.planRepo.getActive(project)) {
        throw new Error(ERR.dirContainsPlan(dir));
      }
      const scopeClause = project === null ? 'project IS NULL' : 'project = ?';
      const placeholders = kinds.map(() => '?').join(',');
      const args = project === null ? [...kinds] : [...kinds, project];
      const ids = (this.db.prepare(
        `SELECT id FROM memories
         WHERE kind IN (${placeholders}) AND ${scopeClause} AND invalidated = 0 AND superseded_by IS NULL`
      ).all(...args) as Array<{ id: string }>).map((r) => r.id);
      records = retireIdsByInvalidation(this.db, ids);
      files = freeFormDeleteUnder(this.db, dir);
      if (records + files === 0) throw new Error(ERR.nonexistent(dir));
    });
    run.immediate();
    this.cache.invalidateAll();
    return `Successfully deleted ${dir}\n(${records} records invalidated, ${files} files deleted)`;
  }

  // --- rename -----------------------------------------------------------------

  rename(rawOld: string, rawNew: string): string {
    const oldRoute = routeMemoryPath(rawOld);
    const newRoute = routeMemoryPath(rawNew);
    if (oldRoute.type === 'root' || newRoute.type === 'root') {
      throw new Error(ERR.cannotRenameRoot(MEMORY_ROOT));
    }
    if (oldRoute.type === 'free-form' && newRoute.type === 'free-form') {
      return freeFormRename(this.db, oldRoute.path, newRoute.path);
    }
    if (oldRoute.type === 'materialized' && newRoute.type === 'materialized') {
      return this.materializedRename(rawOld, rawNew, oldRoute, newRoute);
    }
    throw new Error(ERR.crossDomainRename());
  }

  private materializedRename(rawOld: string, rawNew: string, oldRoute: Materialized, newRoute: Materialized): string {
    // Read-only wins over shape errors: plan.md renames always say why.
    assertWritable(oldRoute, rawOld);
    assertWritable(newRoute, rawNew);
    if (oldRoute.category !== newRoute.category) throw new Error(ERR.crossCategoryRename());
    const oldPath = canonicalFile(oldRoute);
    const newPath = canonicalFile(newRoute);
    const kinds = CATEGORY_KINDS[oldRoute.category];
    const run = this.db.transaction(() => {
      // RAW rows both sides: corrupt records move too and still block.
      const source = activeRows(this.db, oldRoute.project, kinds);
      if (source.length === 0) throw new Error(ERR.nonexistent(oldPath));
      if (activeRows(this.db, newRoute.project, kinds).length > 0) {
        throw new Error(ERR.destinationExists(newPath));
      }
      // A materialized rename is a USER scope move, not the administrative
      // rescope X9 exempts: it journals like promote — tombstone under the
      // departing scope (pre-move revision), upsert under the arriving one
      // (post-move revision). Admissibility filters the global side out.
      const ids = source.map((row) => row.id);
      journalTombstonesForIds(this.db, ids);
      const stmt = this.db.prepare('UPDATE memories SET project = ? WHERE id = ?');
      for (const row of source) stmt.run(newRoute.project, row.id);
      journalUpsertsForIds(this.db, ids);
    });
    run.immediate();
    this.cache.invalidate(oldPath);
    this.cache.invalidate(newPath);
    return `Successfully renamed ${oldPath} to ${newPath}`;
  }
}
