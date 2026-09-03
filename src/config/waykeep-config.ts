/**
 * Waykeep's config file — ~/.waykeep/config.json, overridable via
 * WAYKEEP_CONFIG_PATH (same hermeticity pattern as WAYKEEP_CODEX_DIR: tests
 * point it into a temp dir and can never read a real user's config).
 *
 * TOLERANT READER, absent-equals-default: no file, unreadable file,
 * invalid JSON, or wrong-shaped fields all yield the empty config — the
 * behavior with no config present must be exactly the pre-config
 * behavior. The schema is INTERNAL in v1 (documented in the README, not
 * part of waykeep-contract): only additive changes, unknown fields
 * ignored.
 *
 * Read path is hot (guard functions consult it per memory-set filter),
 * so the parsed config is cached and re-read only when the file's mtime
 * changes — cheap statSync per access, daemon-safe (a long-lived daemon
 * picks up edits without restart).
 */
import { readFileSync, statSync } from 'node:fs';
import { configPath as sharedConfigPath } from '../constants/paths.js';
import { log } from '../utils/log.js';
import { CONFIG_CACHE } from '../constants/index.js';

export interface WaykeepScopeConfig {
  /** Projects whose memories never surface OUTSIDE the project — on any
   *  surface, regardless of fingerprint overlap. Inside the project
   *  everything behaves normally. */
  privateProjects: ReadonlySet<string>;
}

export interface WaykeepReportConfig {
  /** telemetry_rollup writes (default true). Only a literal false
   *  disables — the report is default-on, opt-out. */
  rollup: boolean;
}

export interface WaykeepConfig {
  scope: WaykeepScopeConfig;
  report: WaykeepReportConfig;
}

const EMPTY_CONFIG: WaykeepConfig = {
  scope: { privateProjects: new Set() },
  report: { rollup: true },
};

export function waykeepConfigPath(): string {
  return sharedConfigPath();
}

/** Cache identity is (path, mtime, size, inode): mtimeMs alone is lossy —
 *  measured 1ms granularity lets a rapid rewrite (or a same-size atomic
 *  replace) share a timestamp, which for THIS file means a stale privacy
 *  policy served indefinitely. A very fresh mtime (within its granularity
 *  of now) is additionally never cached, so back-to-back edits re-read. */
interface ConfigCache { path: string; mtimeMs: number; size: number; ino: number; config: WaykeepConfig }
let cache: ConfigCache | null = null;
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
function parseConfig(raw: string): { config: WaykeepConfig; badSections: string[] } {
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
function parseScope(raw: unknown): WaykeepScopeConfig | 'bad-shape' {
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
function parseReport(raw: unknown): WaykeepReportConfig | 'bad-shape' {
  if (raw === undefined) return { rollup: true };
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'bad-shape';
  const rollup = (raw as { rollup?: unknown }).rollup;
  if (rollup === undefined) {
    return Object.keys(raw as object).length === 0 ? { rollup: true } : 'bad-shape';
  }
  if (typeof rollup !== 'boolean') return 'bad-shape';
  return { rollup };
}

export function loadWaykeepConfig(): WaykeepConfig {
  const path = waykeepConfigPath();
  // throwIfNoEntry covers only ENOENT; any OTHER stat error (EACCES, a
  // directory in the path replaced by a file, ...) must honor the
  // tolerant-reader contract too — empty config, but WITH a signal: an
  // unreadable privacy config silently failing open is the worst outcome.
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(path, { throwIfNoEntry: false });
  } catch (err) {
    if (warnedIdentity !== 'stat-error') {
      log.warn(`config at ${path} could not be read (${(err as NodeJS.ErrnoException).code ?? 'stat failed'}) — scope settings are INACTIVE`);
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
  let config: WaykeepConfig;
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
    log.warn(`config at ${path} ${problem}`);
    warnedIdentity = identity;
  }
  if (Date.now() - st.mtimeMs >= CONFIG_CACHE.MTIME_GRANULARITY_MS) {
    cache = { path, mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, config };
  } else {
    cache = null; // too fresh to fingerprint reliably — re-read next time
  }
  return config;
}

/**
 * Sync-facing config health (brief D8 item 5, D10 — release blocker):
 * LOCAL reads stay tolerant (fail-open WITH a signal, above), but sync
 * eligibility treats an unreadable or wrong-shaped config as UNHEALTHY
 * and fails closed — a broken privacy file must disable upload, never
 * silently widen it. Absent file = healthy (the default config is a
 * valid, deliberate state). Consumed by the eligibility predicate and
 * `waykeep doctor`.
 */
export interface WaykeepConfigHealth {
  healthy: boolean;
  /** Human-readable problem when unhealthy; null when healthy. */
  problem: string | null;
  /** Which sections are malformed: section names, '(document)' for a
   *  non-object/unparseable file, '(io)' for stat/read failures. */
  badSections: string[];
  path: string;
}

export interface WaykeepConfigSnapshot {
  config: WaykeepConfig;
  health: WaykeepConfigHealth;
  /** File identity of the bytes BOTH fields derive from; null when the
   *  file is absent. */
  identity: string | null;
}

/**
 * ONE-READ config snapshot (slice-6 Codex H5): health and policy derive
 * from the SAME bytes, so `healthy: true` can never pair with a policy
 * from a different file version — the raceable
 * waykeepConfigHealth()-then-loadWaykeepConfig() pattern produced exactly
 * the fail-open combination D10 forbids (healthy + empty
 * privateProjects). A post-read stat detects mid-read replacement:
 * one retry, then fail CLOSED as unhealthy. Every D10 decision must use
 * one snapshot; transmit takes a fresh one.
 */
export function waykeepConfigSnapshot(): WaykeepConfigSnapshot {
  const path = waykeepConfigPath();
  for (let attempt = 0; attempt < 2; attempt++) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(path, { throwIfNoEntry: false });
    } catch (err) {
      const problem = `config could not be stat'd (${(err as NodeJS.ErrnoException).code ?? 'stat failed'})`;
      return { config: EMPTY_CONFIG, health: { healthy: false, problem, badSections: ['(io)'], path }, identity: null };
    }
    if (!st) {
      return { config: EMPTY_CONFIG, health: { healthy: true, problem: null, badSections: [], path }, identity: null };
    }
    const identityBefore = `${st.mtimeMs}:${st.size}:${st.ino}`;
    let raw: string;
    try {
      raw = readFileSync(path, 'utf-8');
    } catch (err) {
      const problem = `config could not be read (${(err as NodeJS.ErrnoException).code ?? 'read failed'})`;
      return { config: EMPTY_CONFIG, health: { healthy: false, problem, badSections: ['(io)'], path }, identity: null };
    }
    let stAfter: ReturnType<typeof statSync>;
    try {
      stAfter = statSync(path, { throwIfNoEntry: false });
    } catch {
      stAfter = undefined;
    }
    const identityAfter = stAfter ? `${stAfter.mtimeMs}:${stAfter.size}:${stAfter.ino}` : null;
    if (identityAfter !== identityBefore) {
      if (attempt === 0) continue;
      return {
        config: EMPTY_CONFIG,
        health: { healthy: false, problem: 'config changed during read — retry produced a second mismatch', badSections: ['(io)'], path },
        identity: null,
      };
    }
    try {
      const parsed = parseConfig(raw);
      if (parsed.badSections.length > 0) {
        return {
          config: parsed.config,
          health: { healthy: false, problem: `malformed section(s): ${parsed.badSections.join(', ')}`, badSections: parsed.badSections, path },
          identity: identityBefore,
        };
      }
      return { config: parsed.config, health: { healthy: true, problem: null, badSections: [], path }, identity: identityBefore };
    } catch {
      return {
        config: EMPTY_CONFIG,
        health: { healthy: false, problem: 'invalid JSON', badSections: ['(document)'], path },
        identity: identityBefore,
      };
    }
  }
  // Unreachable: the loop returns on every path.
  return { config: EMPTY_CONFIG, health: { healthy: false, problem: 'unreachable', badSections: ['(io)'], path }, identity: null };
}

export function waykeepConfigHealth(): WaykeepConfigHealth {
  return waykeepConfigSnapshot().health;
}

/** True when the project is marked private in the scope config. Null
 *  (global scope) is never private — global visibility is governed at
 *  promote time, not here. */
export function isPrivateProject(project: string | null): boolean {
  if (!project) return false;
  return loadWaykeepConfig().scope.privateProjects.has(project);
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
