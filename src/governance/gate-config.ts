import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import {
  GATE_CONFIG_LIMITS, GateConfigSchema, type ParsedGateConfig,
} from './gates-schema.js';

export type GateConfigErrorCode =
  | 'invalid-project-root'
  | 'invalid-config-path'
  | 'config-too-large'
  | 'invalid-json'
  | 'duplicate-json-key'
  | 'invalid-config'
  | 'path-escape';

export class GateConfigError extends Error {
  constructor(
    readonly code: GateConfigErrorCode,
    message: string,
    readonly issues: readonly unknown[] = [],
  ) {
    super(message);
    this.name = 'GateConfigError';
  }
}

export interface FileChangedCapability {
  supported: boolean;
  observed: boolean;
}

export interface LoadGateConfigOptions {
  /** Defaults to the sole canonical location: .cairn/gates.json. */
  configPath?: string;
  fileChanged?: FileChangedCapability;
}

export interface NormalizedCommandForm {
  argv: string[];
  cwd: string;
}

export interface NormalizedGate extends NormalizedCommandForm {
  parser: 'node-test' | 'exit-only';
  timeoutMs: number;
  skips: { max: number; requireReasons: boolean };
  aliases: NormalizedCommandForm[];
  envNames: string[];
}

export interface NormalizedGateConfig {
  version: 1;
  defaults: {
    level: 'advise' | 'warn' | 'block';
    evaluationTimeoutMs: number;
    retention: { evidenceDays: number; auditDays?: number; ruleDays?: number };
  };
  gates: Record<string, NormalizedGate>;
  pathRules: Array<{ paths: string[]; require: string[] }>;
}

export interface LoadedGateConfig {
  projectRoot: string;
  configPath: string;
  config: NormalizedGateConfig;
  canonicalJson: string;
  sha256: string;
  enforcement: {
    intent: 'advise' | 'warn' | 'block';
    effective: 'diagnostic';
    block: { available: boolean; reason: string | null };
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJsonValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJsonValue(child)}`);
    return `{${fields.join(',')}}`;
  }
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new GateConfigError('invalid-config', 'config is not JSON-serializable');
  return encoded;
}

export function canonicalGateConfigJson(config: NormalizedGateConfig): string {
  return canonicalJsonValue(config);
}

function normalizeRelativePath(path: string): string {
  const withSlashes = path.replaceAll('\\', '/');
  const normalized = posix.normalize(withSlashes);
  return normalized === '' ? '.' : normalized.replace(/^\.\//, '');
}

function commandSignature(command: NormalizedCommandForm): string {
  return `${command.cwd}\0${JSON.stringify(command.argv)}`;
}

export function normalizeGateConfig(parsed: ParsedGateConfig): NormalizedGateConfig {
  const gates: Record<string, NormalizedGate> = {};
  for (const id of Object.keys(parsed.gates).sort(compareStrings)) {
    const gate = parsed.gates[id];
    const cwd = normalizeRelativePath(gate.cwd);
    const aliases = gate.aliases.map(alias => ({
      argv: [...alias.argv],
      cwd: normalizeRelativePath(alias.cwd ?? cwd),
    })).sort((left, right) => compareStrings(commandSignature(left), commandSignature(right)));
    gates[id] = {
      argv: [...gate.argv],
      cwd,
      parser: gate.parser,
      timeoutMs: gate.timeoutMs,
      skips: { ...gate.skips },
      aliases,
      envNames: [...gate.envNames].sort(compareStrings),
    };
  }

  const retention = parsed.defaults.retention;
  return {
    version: 1,
    defaults: {
      level: parsed.defaults.level,
      evaluationTimeoutMs: parsed.defaults.evaluationTimeoutMs,
      retention: {
        evidenceDays: retention.evidenceDays,
        ...(retention.auditDays === undefined ? {} : { auditDays: retention.auditDays }),
        ...(retention.ruleDays === undefined ? {} : { ruleDays: retention.ruleDays }),
      },
    },
    gates,
    pathRules: parsed.pathRules.map(rule => ({
      paths: rule.paths.map(normalizeRelativePath).sort(compareStrings),
      require: [...rule.require].sort(compareStrings),
    })),
  };
}

/** Parse and normalize an already-decoded value without touching the filesystem. */
export function parseGateConfig(input: unknown): NormalizedGateConfig {
  const result = GateConfigSchema.safeParse(input);
  if (!result.success) {
    throw new GateConfigError('invalid-config', 'gate config validation failed', result.error.issues);
  }
  return normalizeGateConfig(result.data);
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child));
}

function canonicalDirectory(path: string): string {
  if (path.includes('\0')) throw new GateConfigError('invalid-project-root', 'project root contains NUL');
  let canonical: string;
  try {
    canonical = realpathSync.native(resolve(path));
    if (!statSync(canonical).isDirectory()) throw new Error('not a directory');
  } catch (error) {
    throw new GateConfigError(
      'invalid-project-root', `project root is not a canonical directory: ${String(error)}`,
    );
  }
  return canonical;
}

function canonicalConfigPath(root: string, requested?: string): string {
  if (requested?.includes('\0')) throw new GateConfigError('invalid-config-path', 'config path contains NUL');
  if (requested?.replaceAll('\\', '/').split('/').includes('..')) {
    throw new GateConfigError('invalid-config-path', 'config path must not contain traversal');
  }
  const expected = join(root, '.cairn', 'gates.json');
  const lexical = requested === undefined
    ? expected
    : resolve(root, requested);
  if (lexical !== expected) {
    throw new GateConfigError(
      'invalid-config-path', 'config path must resolve exactly to .cairn/gates.json',
    );
  }
  let canonical: string;
  try {
    canonical = realpathSync.native(lexical);
  } catch (error) {
    throw new GateConfigError('invalid-config-path', `config path is not readable: ${String(error)}`);
  }
  if (!isWithin(root, canonical)) {
    throw new GateConfigError('path-escape', 'config path escapes the canonical project root');
  }
  if (!statSync(canonical).isFile()) {
    throw new GateConfigError('invalid-config-path', 'config path is not a regular file');
  }
  return canonical;
}

function canonicalExistingAncestor(path: string): string {
  let cursor = path;
  while (true) {
    try {
      return realpathSync.native(cursor);
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) throw new GateConfigError('path-escape', `cannot resolve cwd ancestor: ${path}`);
      cursor = parent;
    }
  }
}

function validateCwdBoundaries(root: string, config: NormalizedGateConfig): void {
  for (const [gateId, gate] of Object.entries(config.gates)) {
    const forms: NormalizedCommandForm[] = [gate, ...gate.aliases];
    for (const form of forms) {
      const lexical = resolve(root, form.cwd);
      if (!isWithin(root, lexical)) {
        throw new GateConfigError('path-escape', `gate ${gateId} cwd escapes the project root`);
      }
      const ancestor = canonicalExistingAncestor(lexical);
      if (!isWithin(root, ancestor)) {
        throw new GateConfigError('path-escape', `gate ${gateId} cwd escapes through a symlink`);
      }
    }
  }
}

function skipWhitespace(source: string, start: number): number {
  let index = start;
  while (/\s/.test(source[index] ?? '')) index += 1;
  return index;
}

function scanString(source: string, start: number): { end: number; value: string } {
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === '"') {
      const raw = source.slice(start, index + 1);
      return { end: index + 1, value: JSON.parse(raw) as string };
    }
    index += 1;
  }
  throw new SyntaxError('unterminated JSON string');
}

function duplicateJsonKey(source: string): string | null {
  let duplicate: string | null = null;

  function scanValue(start: number, pointer: string): number {
    let index = skipWhitespace(source, start);
    if (source[index] === '{') return scanObject(index, pointer);
    if (source[index] === '[') return scanArray(index, pointer);
    if (source[index] === '"') return scanString(source, index).end;
    while (index < source.length && !/[\s,}\]]/.test(source[index])) index += 1;
    return index;
  }

  function scanObject(start: number, pointer: string): number {
    const keys = new Set<string>();
    let index = skipWhitespace(source, start + 1);
    if (source[index] === '}') return index + 1;
    while (index < source.length) {
      const keyToken = scanString(source, index);
      const key = keyToken.value;
      const childPointer = `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`;
      if (keys.has(key) && duplicate === null) duplicate = childPointer;
      keys.add(key);
      index = skipWhitespace(source, keyToken.end);
      if (source[index] !== ':') throw new SyntaxError('expected colon after JSON key');
      index = skipWhitespace(source, scanValue(index + 1, childPointer));
      if (source[index] === '}') return index + 1;
      if (source[index] !== ',') throw new SyntaxError('expected comma in JSON object');
      index = skipWhitespace(source, index + 1);
    }
    throw new SyntaxError('unterminated JSON object');
  }

  function scanArray(start: number, pointer: string): number {
    let item = 0;
    let index = skipWhitespace(source, start + 1);
    if (source[index] === ']') return index + 1;
    while (index < source.length) {
      index = skipWhitespace(source, scanValue(index, `${pointer}/${item}`));
      item += 1;
      if (source[index] === ']') return index + 1;
      if (source[index] !== ',') throw new SyntaxError('expected comma in JSON array');
      index = skipWhitespace(source, index + 1);
    }
    throw new SyntaxError('unterminated JSON array');
  }

  scanValue(0, '');
  return duplicate;
}

function readAndParse(path: string): unknown {
  const size = statSync(path).size;
  if (size > GATE_CONFIG_LIMITS.configBytes) {
    throw new GateConfigError(
      'config-too-large', `gate config exceeds ${GATE_CONFIG_LIMITS.configBytes} bytes`,
    );
  }
  const bytes = readFileSync(path);
  if (bytes.byteLength > GATE_CONFIG_LIMITS.configBytes) {
    throw new GateConfigError(
      'config-too-large', `gate config exceeds ${GATE_CONFIG_LIMITS.configBytes} bytes`,
    );
  }
  const source = bytes.toString('utf8');
  try {
    const duplicate = duplicateJsonKey(source);
    if (duplicate !== null) {
      throw new GateConfigError('duplicate-json-key', `duplicate JSON key at ${duplicate}`);
    }
    return JSON.parse(source) as unknown;
  } catch (error) {
    if (error instanceof GateConfigError) throw error;
    throw new GateConfigError('invalid-json', `gate config is not valid JSON: ${String(error)}`);
  }
}

function blockAvailability(capability?: FileChangedCapability): { available: boolean; reason: string | null } {
  if (capability?.supported !== true) {
    return { available: false, reason: 'block unavailable: FileChanged is unsupported' };
  }
  if (capability.observed !== true) {
    return { available: false, reason: 'block unavailable: FileChanged has not been observed' };
  }
  return { available: true, reason: null };
}

/**
 * Load only the fixed project config. This performs filesystem reads and
 * validation; it never discovers or executes package scripts.
 */
export function loadGateConfig(projectRoot: string, options: LoadGateConfigOptions = {}): LoadedGateConfig {
  const root = canonicalDirectory(projectRoot);
  const configPath = canonicalConfigPath(root, options.configPath);
  const config = parseGateConfig(readAndParse(configPath));
  validateCwdBoundaries(root, config);
  const canonicalJson = canonicalGateConfigJson(config);
  return {
    projectRoot: root,
    configPath,
    config,
    canonicalJson,
    sha256: createHash('sha256').update(canonicalJson).digest('hex'),
    enforcement: {
      intent: config.defaults.level,
      effective: 'diagnostic',
      block: blockAvailability(options.fileChanged),
    },
  };
}
