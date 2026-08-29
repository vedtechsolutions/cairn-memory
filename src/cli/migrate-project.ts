/**
 * `migrate-project <old-project-id>` — carry a project's rows over to the
 * CURRENT project id after the id changed out from under the data.
 *
 * Project identity derives from the normalized `origin` remote (project-id.ts),
 * so renaming a repository or transferring it to another org silently changes
 * the id and orphans everything stored under the old one. The session-start
 * migration only heals the legacy PATH-hash id; it cannot know a prior
 * remote. This command is the explicit, user-driven completion of that story:
 * run it from inside the renamed project, naming the id the rows are under.
 *
 * Deliberately explicit rather than automatic: sessions do not record enough
 * to infer "same project, new remote" safely, and a wrong guess would merge
 * unrelated projects. Privacy fails closed — see the gate below.
 */
import { openDatabase } from '../db/connection.js';
import { resolveDbPath } from '../db/db-path.js';
import { countProjectRows, moveProjectRows } from '../db/project-identity-migration.js';
import { projectId } from '../utils/project-id.js';
import { isPrivateProject } from '../config/cairn-config.js';

/** Mirrors the MCP tools' project-param shape: sane charset, 200-char cap. */
const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export interface MigrateProjectOptions {
  oldId: string;
  dryRun: boolean;
  /** Test seam; defaults to the real working directory. */
  cwd?: string;
}

export function runMigrateProject(options: MigrateProjectOptions): number {
  const { oldId, dryRun } = options;
  const cwd = options.cwd ?? process.cwd();

  if (!PROJECT_ID_PATTERN.test(oldId)) {
    console.error(`migrate-project: "${oldId}" is not a valid project id`);
    return 1;
  }

  const newId = projectId(cwd);
  if (oldId === newId) {
    console.error(`migrate-project: "${oldId}" already is the current project id — nothing to migrate`);
    return 1;
  }

  // Privacy fails closed: moving a private project's rows to an id the scope
  // config does not list would silently strip its one-rule protection. The
  // fix lives in the config file, not here.
  if (isPrivateProject(oldId) && !isPrivateProject(newId)) {
    console.error(
      `migrate-project: "${oldId}" is marked private but the current id "${newId}" is not.\n`
      + `Add "${newId}" to scope.privateProjects in your config file first, then re-run.`,
    );
    return 1;
  }

  const db = openDatabase({ dbPath: resolveDbPath(process.env.CAIRN_DB_PATH) });
  try {
    const counts = countProjectRows(db, oldId);
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (total === 0) {
      console.error(`migrate-project: no rows found under "${oldId}"`);
      return 1;
    }

    if (dryRun) {
      console.log(`migrate-project (dry run): would move ${total} row(s) from "${oldId}" to "${newId}"`);
      for (const [table, n] of Object.entries(counts)) console.log(`  ${table}: ${n}`);
      return 0;
    }

    const moved = moveProjectRows(db, oldId, newId);
    const movedTotal = Object.values(moved).reduce((a, b) => a + b, 0);
    console.log(`migrate-project: moved ${movedTotal} row(s) from "${oldId}" to "${newId}"`);
    for (const [table, n] of Object.entries(moved)) console.log(`  ${table}: ${n}`);
    return 0;
  } finally {
    db.close();
  }
}
