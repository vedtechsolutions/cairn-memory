import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import Database from 'better-sqlite3';
import { DB } from '../constants/index.js';
import { projectId } from '../utils/project-id.js';
import {
  loadGateConfig, type LoadedGateConfig, type NormalizedCommandForm,
} from './gate-config.js';
import { redactArgv } from './redaction.js';

export const DIAGNOSTIC_LABEL = 'diagnostic only — Slice A does not enforce';

export class InspectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectorError';
  }
}

export class InspectorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InspectorValidationError';
  }
}

export interface InspectGatesOptions {
  projectRoot: string;
  paths?: readonly string[];
  dbPath?: string | null;
  /** Behavioral tests set this so an omitted or default DB can never touch the live store. */
  refuseDefaultStore?: boolean;
}

interface CapabilityValues {
  postToolUse: boolean | null;
  postToolFailure: boolean | null;
  fileChanged: boolean | null;
  structuredOutput: boolean | null;
  stop: boolean | null;
  blocking: boolean | null;
}

interface CapabilityRecord {
  installationSha256: string;
  client: string;
  version: string | null;
  adapterVersion: number;
  settingsSource: 'recorded' | 'not recorded';
  lastHeartbeatAt: string | null;
  declared: CapabilityValues | null;
  observed: CapabilityValues | null;
  observation: string | null;
}

export interface InspectorReport {
  slice: 'A';
  mode: typeof DIAGNOSTIC_LABEL;
  projectRoot: string;
  config: { version: number; sha256: string; path: string };
  enforcement: {
    configured: string;
    effective: 'diagnostic';
    label: typeof DIAGNOSTIC_LABEL;
    block: { available: boolean; reason: string | null };
  };
  retention: {
    evidenceDays: number;
    auditDays: number | 'until explicit cleanup';
    ruleDays: number | 'until explicit cleanup';
  };
  gates: Array<{
    id: string;
    argv: string[];
    cwd: string;
    parser: string;
    timeoutMs: number;
    skips: { max: number; requireReasons: boolean };
    aliases: NormalizedCommandForm[];
    envNames: string[];
  }>;
  paths: Array<{ path: string; requiredGates: string[] }>;
  packageScriptProposals: Array<{ name: string; command: string; sha256: string }>;
  capabilities: {
    source: 'database' | 'unavailable';
    reason: string | null;
    records: CapabilityRecord[];
  };
  warnings: string[];
}

type CapabilityRow = {
  client_installation_id: string;
  client_name: string;
  client_version: string | null;
  supports_post_tool_use: number | null;
  supports_post_tool_failure: number | null;
  supports_file_changed: number | null;
  supports_structured_output: number | null;
  supports_stop: number | null;
  supports_blocking: number | null;
  adapter_version: number;
  settings_source: string | null;
  last_heartbeat_at: string | null;
  last_probe_result: string | null;
};

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function booleanOrNull(value: number | null): boolean | null {
  return value === null ? null : value === 1;
}

function capabilityValues(row: CapabilityRow): CapabilityValues {
  return {
    postToolUse: booleanOrNull(row.supports_post_tool_use),
    postToolFailure: booleanOrNull(row.supports_post_tool_failure),
    fileChanged: booleanOrNull(row.supports_file_changed),
    structuredOutput: booleanOrNull(row.supports_structured_output),
    stop: booleanOrNull(row.supports_stop),
    blocking: booleanOrNull(row.supports_blocking),
  };
}

function defaultStorePath(): string {
  return resolve(DB.DEFAULT_PATH.replace('~', homedir()));
}

function resolveDatabasePath(input: string): string {
  if (input.includes('\0')) throw new InspectorError('database path contains NUL');
  if (input === ':memory:') throw new InspectorError('inspector requires a persistent read-only database path');
  return resolve(input.startsWith('~') ? input.replace('~', homedir()) : input);
}

function readCapabilities(
  root: string,
  dbPath: string | null | undefined,
  refuseDefaultStore: boolean,
): InspectorReport['capabilities'] {
  if (dbPath === null) {
    return { source: 'unavailable', reason: 'database inspection disabled', records: [] };
  }
  const resolvedPath = resolveDatabasePath(dbPath ?? defaultStorePath());
  if (refuseDefaultStore && resolvedPath === defaultStorePath()) {
    throw new InspectorError('live default store refused by inspector test safety barrier');
  }
  if (!existsSync(resolvedPath)) {
    if (dbPath === undefined) {
      return { source: 'unavailable', reason: 'default capability store does not exist', records: [] };
    }
    throw new InspectorError('explicit capability database does not exist');
  }
  if (!statSync(resolvedPath).isFile()) throw new InspectorError('capability database is not a regular file');

  let db: Database.Database | undefined;
  try {
    // Opening a WAL-mode file with SQLITE_OPEN_READONLY may still create
    // -shm/-wal sidecars. Deserialize a private byte snapshot and lock that
    // connection to query-only mode so the source DB/directory cannot change.
    const snapshot = Buffer.from(readFileSync(resolvedPath));
    if (snapshot.length >= 100
      && snapshot.subarray(0, 16).toString('binary') === 'SQLite format 3\0'
      && snapshot[18] === 2 && snapshot[19] === 2) {
      // The private snapshot has no WAL sidecar. Mark its copied header as a
      // rollback-journal image; a normally closed DB has already checkpointed.
      snapshot[18] = 1;
      snapshot[19] = 1;
    }
    db = new Database(snapshot);
    db.pragma('temp_store = MEMORY');
    db.pragma('query_only = ON');
    const table = db.prepare(`
      SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'governance_client_state'
    `).get();
    if (table === undefined) {
      return { source: 'unavailable', reason: 'capability table is unavailable', records: [] };
    }
    const rows = db.prepare(`
      SELECT client_installation_id, client_name, client_version,
             supports_post_tool_use, supports_post_tool_failure, supports_file_changed,
             supports_structured_output, supports_stop, supports_blocking,
             adapter_version, settings_source, last_heartbeat_at, last_probe_result
      FROM governance_client_state
      WHERE project = ?
      ORDER BY client_name, client_installation_id
    `).all(projectId(root)) as CapabilityRow[];
    return {
      source: 'database',
      reason: rows.length === 0 ? 'no client capability observations for this project' : null,
      records: rows.map(row => {
        const values = capabilityValues(row);
        const observed = row.last_probe_result === 'hook-observation';
        return {
          installationSha256: sha256(row.client_installation_id),
          client: row.client_name,
          version: row.client_version,
          adapterVersion: row.adapter_version,
          settingsSource: row.settings_source === null ? 'not recorded' : 'recorded',
          lastHeartbeatAt: row.last_heartbeat_at,
          declared: row.settings_source === null ? null : values,
          observed: observed ? values : null,
          observation: row.last_probe_result === null
            ? null
            : row.last_probe_result === 'hook-observation' ? 'hook-observation' : 'recorded',
        };
      }),
    };
  } catch (error) {
    if (error instanceof InspectorError) throw error;
    throw new InspectorError(`read-only capability inspection failed: ${String(error)}`);
  } finally {
    db?.close();
  }
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function normalizeRequestedPath(root: string, requested: string): string {
  if (requested.includes('\0') || /[\r\n]/.test(requested)) {
    throw new InspectorValidationError('inspected paths must not contain control characters');
  }
  const withSlashes = requested.replaceAll('\\', '/');
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(root, requested);
  if (!isWithin(root, absolute)) throw new InspectorValidationError(`inspected path escapes project root: ${requested}`);
  const normalized = posix.normalize(isAbsolute(requested) ? relative(root, absolute).replaceAll('\\', '/') : withSlashes);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new InspectorValidationError(`inspected path escapes project root: ${requested}`);
  }
  return normalized.replace(/^\.\//, '') || '.';
}

function globRegex(glob: string): RegExp {
  let source = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        if (glob[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[\\^$+?.()|{}[\]]/g, '\\$&');
    }
  }
  return new RegExp(`${source}$`);
}

function expandPaths(loaded: LoadedGateConfig, paths: readonly string[]): InspectorReport['paths'] {
  return paths.map(requested => {
    const path = normalizeRequestedPath(loaded.projectRoot, requested);
    const required = new Set<string>();
    for (const rule of loaded.config.pathRules) {
      if (rule.paths.some(pattern => globRegex(pattern).test(path))) {
        for (const gateId of rule.require) required.add(gateId);
      }
    }
    return { path, requiredGates: [...required] };
  });
}

function safePackageScripts(root: string): InspectorReport['packageScriptProposals'] {
  const packagePath = resolve(root, 'package.json');
  if (!existsSync(packagePath) || !statSync(packagePath).isFile()) return [];
  const bytes = readFileSync(packagePath);
  if (bytes.byteLength > 256 * 1024) return [];
  try {
    const decoded = JSON.parse(bytes.toString('utf8')) as { scripts?: unknown };
    if (decoded.scripts === null || typeof decoded.scripts !== 'object' || Array.isArray(decoded.scripts)) return [];
    return Object.entries(decoded.scripts as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, command]) => ({
        name,
        command: '[redacted command; proposal only, never executed]',
        sha256: sha256(command),
      }));
  } catch {
    return [];
  }
}

function gateRows(loaded: LoadedGateConfig): InspectorReport['gates'] {
  return Object.entries(loaded.config.gates).map(([id, gate]) => ({
    id,
    argv: redactArgv(gate.argv),
    cwd: gate.cwd,
    parser: gate.parser,
    timeoutMs: gate.timeoutMs,
    skips: gate.skips,
    aliases: gate.aliases.map(alias => ({ argv: redactArgv(alias.argv), cwd: alias.cwd })),
    envNames: [...gate.envNames],
  }));
}

export function inspectGates(options: InspectGatesOptions): InspectorReport {
  const loaded = loadGateConfig(options.projectRoot);
  const capabilities = readCapabilities(
    loaded.projectRoot, options.dbPath, options.refuseDefaultStore === true,
  );
  const observedFileChanged = capabilities.records.some(record => record.observed?.fileChanged === true);
  const declaredFileChanged = capabilities.records.some(record => record.declared?.fileChanged === true);
  const block = observedFileChanged
    ? { available: true, reason: null }
    : declaredFileChanged
      ? { available: false, reason: 'block unavailable: FileChanged has not been observed' }
      : { available: false, reason: 'block unavailable: FileChanged is unsupported' };
  const retention = loaded.config.defaults.retention;
  return {
    slice: 'A',
    mode: DIAGNOSTIC_LABEL,
    projectRoot: loaded.projectRoot,
    config: { version: loaded.config.version, sha256: loaded.sha256, path: loaded.configPath },
    enforcement: {
      configured: loaded.enforcement.intent,
      effective: 'diagnostic',
      label: DIAGNOSTIC_LABEL,
      block,
    },
    retention: {
      evidenceDays: retention.evidenceDays,
      auditDays: retention.auditDays ?? 'until explicit cleanup',
      ruleDays: retention.ruleDays ?? 'until explicit cleanup',
    },
    gates: gateRows(loaded),
    paths: expandPaths(loaded, options.paths ?? []),
    packageScriptProposals: safePackageScripts(loaded.projectRoot),
    capabilities,
    warnings: [
      'Package scripts are proposals only; the inspector never executes commands.',
      'Command values are redacted and environment values are never read or printed.',
    ],
  };
}

export function renderInspectorText(report: InspectorReport): string {
  const lines = [
    'Waykeep gate inspector',
    `Project: ${JSON.stringify(report.projectRoot)}`,
    `Mode: ${report.mode}`,
    `Config: v${report.config.version} sha256:${report.config.sha256}`,
    `Configured enforcement: ${report.enforcement.configured} (${report.enforcement.label})`,
    `Effective enforcement: ${report.enforcement.effective} (${report.enforcement.label})`,
    report.enforcement.block.available
      ? 'Block capability: available (inspection remains diagnostic)'
      : `Block capability: ${report.enforcement.block.reason}`,
    `Retention: evidence=${report.retention.evidenceDays}d audit=${report.retention.auditDays} rule=${report.retention.ruleDays}`,
    '',
    'Normalized gates:',
  ];
  for (const gate of report.gates) {
    lines.push(
      `- ${gate.id}: argv=${JSON.stringify(gate.argv)} cwd=${JSON.stringify(gate.cwd)} parser=${gate.parser} timeout=${gate.timeoutMs}ms skips=${JSON.stringify(gate.skips)} envNames=${JSON.stringify(gate.envNames)}`,
    );
    for (const alias of gate.aliases) {
      lines.push(`  alias: argv=${JSON.stringify(alias.argv)} cwd=${JSON.stringify(alias.cwd)}`);
    }
  }
  lines.push('', 'Path expansion:');
  if (report.paths.length === 0) lines.push('- no paths requested');
  for (const path of report.paths) {
    lines.push(`- ${JSON.stringify(path.path)} => ${JSON.stringify(path.requiredGates)}`);
  }
  lines.push('', 'Client capabilities:');
  if (report.capabilities.records.length === 0) {
    lines.push(`- unavailable: ${report.capabilities.reason ?? 'none recorded'}`);
  } else {
    for (const record of report.capabilities.records) {
      lines.push(`- ${JSON.stringify(record.client)} declared=${JSON.stringify(record.declared)} observed=${JSON.stringify(record.observed)}`);
    }
  }
  lines.push('', 'Package script proposals (redacted; never executed):');
  if (report.packageScriptProposals.length === 0) lines.push('- none');
  for (const proposal of report.packageScriptProposals) {
    lines.push(`- ${JSON.stringify(proposal.name)}: ${proposal.command} sha256:${proposal.sha256}`);
  }
  lines.push('', ...report.warnings);
  return `${lines.join('\n')}\n`;
}
