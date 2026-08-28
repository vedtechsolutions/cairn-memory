import * as z from 'zod/v4';

/** Public bounds for the v1 gate-config contract. */
export const GATE_CONFIG_LIMITS = Object.freeze({
  configBytes: 256 * 1024,
  gates: 32,
  aliasesPerGate: 16,
  argvItems: 64,
  argvItemChars: 4_096,
  cwdChars: 512,
  envNames: 64,
  pathRules: 128,
  globsPerRule: 64,
  globChars: 512,
  gateRefsPerRule: 32,
  commandTimeoutMs: 3_600_000,
  evaluationTimeoutMs: 1_000,
  retentionDays: 3_650,
});

export const GATE_ID_PATTERN = '^[a-z][a-z0-9_-]{0,63}$';
export const ENV_NAME_PATTERN = '^[A-Za-z_][A-Za-z0-9_]*$';

const gateId = z.string().regex(new RegExp(GATE_ID_PATTERN));
const argvItem = z.string().max(GATE_CONFIG_LIMITS.argvItemChars).regex(/^[^\0]*$/);
const argv = z.array(argvItem).min(1).max(GATE_CONFIG_LIMITS.argvItems);
const PORTABLE_RELATIVE_PATTERN = /^(?![\\/]|[A-Za-z]:)(?!\.\.(?:[\\/]|$))(?!.*[\\/]\.\.(?:[\\/]|$))[^\0]+$/;
const relativePath = z.string().max(GATE_CONFIG_LIMITS.cwdChars).regex(PORTABLE_RELATIVE_PATTERN);
const glob = z.string().max(GATE_CONFIG_LIMITS.globChars).regex(PORTABLE_RELATIVE_PATTERN);

const skipPolicySchema = z.strictObject({
  max: z.number().int().min(0).max(1_000).default(0),
  requireReasons: z.boolean().default(false),
});

const aliasSchema = z.strictObject({
  argv,
  cwd: relativePath.optional(),
});

const gateSchema = z.strictObject({
  argv,
  cwd: relativePath.default('.'),
  parser: z.enum(['node-test', 'exit-only']),
  timeoutMs: z.number().int().min(1).max(GATE_CONFIG_LIMITS.commandTimeoutMs),
  skips: skipPolicySchema.default({ max: 0, requireReasons: false }),
  aliases: z.array(aliasSchema).max(GATE_CONFIG_LIMITS.aliasesPerGate).default([]),
  envNames: z.array(z.string().regex(new RegExp(ENV_NAME_PATTERN)))
    .max(GATE_CONFIG_LIMITS.envNames).default([]),
});

const retentionSchema = z.strictObject({
  evidenceDays: z.number().int().min(1).max(30).default(30),
  auditDays: z.number().int().min(1).max(GATE_CONFIG_LIMITS.retentionDays).optional(),
  ruleDays: z.number().int().min(1).max(GATE_CONFIG_LIMITS.retentionDays).optional(),
});

const defaultsSchema = z.strictObject({
  level: z.enum(['advise', 'warn', 'block']).default('advise'),
  evaluationTimeoutMs: z.number().int().min(1)
    .max(GATE_CONFIG_LIMITS.evaluationTimeoutMs).default(250),
  retention: retentionSchema.default({ evidenceDays: 30 }),
});

const pathRuleSchema = z.strictObject({
  paths: z.array(glob).min(1).max(GATE_CONFIG_LIMITS.globsPerRule),
  require: z.array(gateId).max(GATE_CONFIG_LIMITS.gateRefsPerRule),
});

function hasTraversal(path: string): boolean {
  return path.replaceAll('\\', '/').split('/').includes('..');
}

function isAbsoluteLike(path: string): boolean {
  return path.startsWith('/') || path.startsWith('\\') || /^[A-Za-z]:/.test(path);
}

function normalizedRelativePath(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/');
  return parts.filter(part => part !== '' && part !== '.').join('/') || '.';
}

function normalizedArgv(argvValue: readonly string[]): string {
  return JSON.stringify(argvValue);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The single v1 source of truth. It drives runtime parsing and JSON Schema
 * generation; cross-field checks remain attached here as Zod refinements.
 */
export const GateConfigSchema = z.strictObject({
  version: z.literal(1),
  defaults: defaultsSchema.default({
    level: 'advise', evaluationTimeoutMs: 250, retention: { evidenceDays: 30 },
  }),
  gates: z.record(gateId, gateSchema).meta({
    minProperties: 1,
    maxProperties: GATE_CONFIG_LIMITS.gates,
  }),
  pathRules: z.array(pathRuleSchema).min(1).max(GATE_CONFIG_LIMITS.pathRules),
}).superRefine((config, context) => {
  const entries = Object.entries(config.gates);
  if (entries.length === 0) {
    context.addIssue({ code: 'custom', path: ['gates'], message: 'at least one gate is required' });
  }
  if (entries.length > GATE_CONFIG_LIMITS.gates) {
    context.addIssue({
      code: 'custom', path: ['gates'],
      message: `at most ${GATE_CONFIG_LIMITS.gates} gates are allowed`,
    });
  }

  const normalizedIds = new Set<string>();
  for (const [id, gate] of entries) {
    const normalizedId = id.toLowerCase();
    if (normalizedIds.has(normalizedId)) {
      context.addIssue({
        code: 'custom', path: ['gates', id], message: `duplicate normalized gate id: ${normalizedId}`,
      });
    }
    normalizedIds.add(normalizedId);

    if (gate.argv[0].length === 0) {
      context.addIssue({
        code: 'custom', path: ['gates', id, 'argv', 0], message: 'executable must not be empty',
      });
    }
    if (isAbsoluteLike(gate.cwd) || hasTraversal(gate.cwd)) {
      context.addIssue({
        code: 'custom', path: ['gates', id, 'cwd'],
        message: 'cwd must be project-relative and must not traverse parent directories',
      });
    }
    const envNames = new Set<string>();
    for (const [index, name] of gate.envNames.entries()) {
      if (envNames.has(name)) {
        context.addIssue({
          code: 'custom', path: ['gates', id, 'envNames', index],
          message: `duplicate environment name: ${name}`,
        });
      }
      envNames.add(name);
    }

    const commandForms = new Set([`${normalizedRelativePath(gate.cwd)}\0${normalizedArgv(gate.argv)}`]);
    for (const [index, alias] of gate.aliases.entries()) {
      if (alias.argv[0].length === 0) {
        context.addIssue({
          code: 'custom', path: ['gates', id, 'aliases', index, 'argv', 0],
          message: 'alias executable must not be empty',
        });
      }
      const cwd = alias.cwd ?? gate.cwd;
      if (isAbsoluteLike(cwd) || hasTraversal(cwd)) {
        context.addIssue({
          code: 'custom', path: ['gates', id, 'aliases', index, 'cwd'],
          message: 'alias cwd must be project-relative and must not traverse parent directories',
        });
      }
      const signature = `${normalizedRelativePath(cwd)}\0${normalizedArgv(alias.argv)}`;
      if (commandForms.has(signature)) {
        context.addIssue({
          code: 'custom', path: ['gates', id, 'aliases', index],
          message: 'duplicate normalized alias',
        });
      }
      commandForms.add(signature);
    }
  }

  for (const [ruleIndex, rule] of config.pathRules.entries()) {
    const seenPaths = new Set<string>();
    for (const [pathIndex, path] of rule.paths.entries()) {
      if (isAbsoluteLike(path) || hasTraversal(path)) {
        context.addIssue({
          code: 'custom', path: ['pathRules', ruleIndex, 'paths', pathIndex],
          message: 'glob must be project-relative and must not traverse parent directories',
        });
      }
      const normalized = normalizedRelativePath(path);
      if (seenPaths.has(normalized)) {
        context.addIssue({
          code: 'custom', path: ['pathRules', ruleIndex, 'paths', pathIndex],
          message: `duplicate normalized glob: ${normalized}`,
        });
      }
      seenPaths.add(normalized);
    }
    const refs = new Set<string>();
    for (const [refIndex, ref] of rule.require.entries()) {
      if (!Object.hasOwn(config.gates, ref)) {
        context.addIssue({
          code: 'custom', path: ['pathRules', ruleIndex, 'require', refIndex],
          message: `unknown gate reference: ${ref}`,
        });
      }
      if (refs.has(ref)) {
        context.addIssue({
          code: 'custom', path: ['pathRules', ruleIndex, 'require', refIndex],
          message: `duplicate gate reference: ${ref}`,
        });
      }
      refs.add(ref);
    }
  }

  if (config.defaults.level === 'block') {
    const hasCatchAll = config.pathRules.some(rule =>
      rule.paths.some(path => normalizedRelativePath(path) === '**'));
    if (!hasCatchAll) {
      context.addIssue({
        code: 'custom', path: ['pathRules'],
        message: 'block intent requires an explicit ** catch-all path rule',
      });
    }
  }
});

export type GateConfigInput = z.input<typeof GateConfigSchema>;
export type ParsedGateConfig = z.output<typeof GateConfigSchema>;

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => compareStrings(left, right))
      .map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}

/** Byte-canonical checked-in JSON Schema representation. */
export function generateGateConfigJsonSchema(): string {
  const generated = z.toJSONSchema(GateConfigSchema, {
    io: 'input',
    target: 'draft-2020-12',
    unrepresentable: 'any',
  });
  const schema = {
    ...generated,
    $id: 'https://cairn.dev/schemas/cairn-gates.schema.json',
    title: 'Cairn gate configuration v1',
  };
  return `${JSON.stringify(sortJson(schema), null, 2)}\n`;
}
