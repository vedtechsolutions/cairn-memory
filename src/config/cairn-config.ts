/**
 * Cairn's config file — ~/.cairn/config.json, overridable via
 * CAIRN_CONFIG_PATH (same hermeticity pattern as CAIRN_CODEX_DIR: tests
 * point it into a temp dir and can never read a real user's config).
 *
 * TOLERANT READER, absent-equals-default: no file, unreadable file,
 * invalid JSON, or wrong-shaped fields all yield the empty config — the
 * behavior with no config present must be exactly the pre-config
 * behavior. The schema is INTERNAL in v1 (documented in the README, not
 * part of cairn-contract): only additive changes, unknown fields
 * ignored.
 *
 * Read path is hot (guard functions consult it per memory-set filter),
 * so the parsed config is cached and re-read only when the file's mtime
 * changes — cheap statSync per access, daemon-safe (a long-lived daemon
 * picks up edits without restart).
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface CairnScopeConfig {
  /** Projects whose memories never surface OUTSIDE the project — on any
   *  surface, regardless of fingerprint overlap. Inside the project
   *  everything behaves normally. */
  privateProjects: ReadonlySet<string>;
}

export interface CairnReportConfig {
  /** telemetry_rollup writes (default true). Only a literal false
   *  disables — the report is default-on, opt-out. */
  rollup: boolean;
}

export interface CairnConfig {
  scope: CairnScopeConfig;
  report: CairnReportConfig;
}

const EMPTY_CONFIG: CairnConfig = {
  scope: { privateProjects: new Set() },
  report: { rollup: true },
};

export function cairnConfigPath(): string {
  return process.env.CAIRN_CONFIG_PATH ?? join(homedir(), '.cairn', 'config.json');
}

/** Cache identity is (path, mtime, size, inode): mtimeMs alone is lossy —
 *  measured 1ms granularity lets a rapid rewrite (or a same-size atomic
 *  replace) share a timestamp, which for THIS file means a stale privacy
 *  policy served indefinitely. A very fresh mtime (within its granularity
 *  of now) is additionally never cached, so back-to-back edits re-read. */
interface ConfigCache { path: string; mtimeMs: number; size: number; ino: number; config: CairnConfig }
let cache: ConfigCache | null = null;
const MTIME_GRANULARITY_MS = 2;
/** One warning per problem per file VERSION (mtime+size+ino — mtime alone
 *  can collide across versions), so a broken privacy config is loud once
 *  rather than silent or spammy. */
let warnedIdentity: string | null = null;

/**
 * Parse with INDEPENDENT section degradation: a malformed `report` block
 * must never deactivate the `scope` privacy settings (review blocker: a
 * one-character `rollups` typo in the cosmetic block silently turned off
 * every private project), and vice versa. Each section distinguishes
 * "not configured" (legal, silent) from "present but wrong-shaped"
 * (falls back to ITS default, warning names the section). Unknown
 * TOP-LEVEL keys are ignored per the additive contract.
 */
function parseConfig(raw: string): { config: CairnConfig; badSections: string[] } {
  const parsed = JSON.parse(raw) as unknown;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { config: EMPTY_CONFIG, badSections: ['(document)'] };
  }
  const badSections: string[] = [];
  const scope = parseScope((parsed as { scope?: unknown }).scope);
  if (scope === 'bad-shape') badSections.push('scope');
  const report = parseReport((parsed as { report?: unknown }).report);
  if (report === 'bad-shape') badSections.push('report');
  return {
    config: {
      scope: scope === 'bad-shape' ? EMPTY_CONFIG.scope : scope,
      report: report === 'bad-shape' ? EMPTY_CONFIG.report : report,
    },
    badSections,
  };
}

/** scope block: absent or deliberately empty = no restrictions; a
 *  NON-empty block without a well-formed privateProjects list is almost
 *  certainly a typo — and a typo silently deactivating every private
 *  project is the failure the warning exists for. */
function parseScope(raw: unknown): CairnScopeConfig | 'bad-shape' {
  if (raw === undefined) return EMPTY_CONFIG.scope;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'bad-shape';
  const list = (raw as { privateProjects?: unknown }).privateProjects;
  if (list === undefined) {
    return Object.keys(raw as object).length === 0 ? EMPTY_CONFIG.scope : 'bad-shape';
  }
  if (!Array.isArray(list)) return 'bad-shape';
  // Non-string members mean a malformed file, not ignorable noise — being
  // silently filtered to an empty set is the same fail-open as a typo.
  if (list.some((p) => typeof p !== 'string')) return 'bad-shape';
  return { privateProjects: new Set(list.filter((p): p is string => p.length > 0)) };
}

/** report block: absent = defaults; a literal rollup:false disables; any
 *  other malformed shape warns like the scope block (same fail-open-with-
 *  signal policy — a silently ignored opt-out is a broken promise too). */
function parseReport(raw: unknown): CairnReportConfig | 'bad-shape' {
  if (raw === undefined) return { rollup: true };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'bad-shape';
  const rollup = (raw as { rollup?: unknown }).rollup;
  if (rollup === undefined) {
    return Object.keys(raw as object).length === 0 ? { rollup: true } : 'bad-shape';
  }
  if (typeof rollup !== 'boolean') return 'bad-shape';
  return { rollup };
}

export function loadCairnConfig(): CairnConfig {
  const path = cairnConfigPath();
  // throwIfNoEntry covers only ENOENT; any OTHER stat error (EACCES, a
  // directory in the path replaced by a file, ...) must honor the
  // tolerant-reader contract too — empty config, but WITH a signal: an
  // unreadable privacy config silently failing open is the worst outcome.
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path, { throwIfNoEntry: false });
  } catch (err) {
    if (warnedIdentity !== 'stat-error') {
      console.error(`[cairn] config at ${path} could not be read (${(err as NodeJS.ErrnoException).code ?? 'stat failed'}) — scope settings are INACTIVE`);
      warnedIdentity = 'stat-error';
    }
    cache = null;
    return EMPTY_CONFIG;
  }
  if (!st) {
    // Absent file IS the default config; drop any cache so deleting the
    // file reverts behavior immediately.
    cache = null;
    return EMPTY_CONFIG;
  }
  if (cache && cache.path === path && cache.mtimeMs === st.mtimeMs
    && cache.size === st.size && cache.ino === st.ino) {
    return cache.config;
  }
  const identity = `${st.mtimeMs}:${st.size}:${st.ino}`;
  let config: CairnConfig;
  let problem: string | null = null;
  try {
    const parsed = parseConfig(readFileSync(path, 'utf-8'));
    config = parsed.config;
    if (parsed.badSections.length > 0) {
      problem = parsed.badSections.includes('(document)')
        ? 'is not a JSON object — ALL settings are INACTIVE until fixed'
        : `has an unrecognized ${parsed.badSections.join(' and ')} section — those settings are INACTIVE until fixed (other sections still apply)`;
    }
  } catch {
    problem = 'is invalid JSON — ALL settings are INACTIVE until fixed';
    config = EMPTY_CONFIG;
  }
  // PRESENT but broken must not degrade silently — one warning per file
  // version, NAMING the broken section (a warning pointing at the wrong
  // block is worse than none).
  if (problem !== null && warnedIdentity !== identity) {
    console.error(`[cairn] config at ${path} ${problem}`);
    warnedIdentity = identity;
  }
  if (Date.now() - st.mtimeMs >= MTIME_GRANULARITY_MS) {
    cache = { path, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, config };
  } else {
    cache = null; // too fresh to fingerprint reliably — re-read next time
  }
  return config;
}

/** True when the project is marked private in the scope config. Null
 *  (global scope) is never private — global visibility is governed at
 *  promote time, not here. */
export function isPrivateProject(project: string | null): boolean {
  if (!project) return false;
  return loadCairnConfig().scope.privateProjects.has(project);
}

/**
 * Session-binding for EXPLICIT reads: a private project's content is
 * readable through MCP tools only when the session's own working project
 * IS that project. This is preference isolation for an autonomous agent
 * (keeping client work out of unrelated contexts), not access control —
 * the DB file belongs to the same user either way.
 */
export function canReadPrivate(memoryProject: string | null, sessionProjectId: string | null): boolean {
  if (!memoryProject) return true;
  if (!isPrivateProject(memoryProject)) return true;
  return memoryProject === sessionProjectId;
}

/** TEST-ONLY cache reset (config path changes between hermetic tests). */
export function resetConfigCacheForTests(): void {
  cache = null;
  warnedIdentity = null;
}
