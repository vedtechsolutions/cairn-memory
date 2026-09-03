/**
 * Context fingerprint generation and matching.
 * Fingerprints capture WHERE a lesson was learned (lang, framework, module)
 * so retrieval can match by context similarity, not just keyword overlap.
 */
import { extname, basename, dirname } from 'node:path';
import type { ProjectContext } from './project-scanner.js';
import { FINGERPRINT, RELEVANCE } from '../constants/index.js';
import { CLAUDE_CODE } from '../constants/claude-code.js';
import { jaccardOverlap } from './similarity.js';

/** Extract task-signal tokens from a git branch name: lowercased segments
 *  split on /-_ with short and conventional-prefix noise (feat, fix, ...)
 *  removed. Shared by pitfall-handler prediction and the briefing query
 *  fingerprint — the two previously kept drifting private copies. */
export function branchSignalTokens(branch: string): string[] {
  const noise = new Set(RELEVANCE.BRANCH_NOISE_TOKENS);
  return branch.toLowerCase().split(/[/\-_]/).filter(t => t.length >= 3 && !noise.has(t));
}

// --- Types ------------------------------------------------------------------

export interface ContextFingerprint {
  lang: string[];
  framework: string[];
  module: string[];
}

// --- Extension → Language Map -----------------------------------------------

const EXTENSION_LANG_MAP: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', cs: 'csharp', cpp: 'cpp', c: 'c', h: 'c',
  xml: 'xml', html: 'html', css: 'css', scss: 'scss',
  sql: 'sql', sh: 'bash', yml: 'yaml', yaml: 'yaml',
  json: 'json', md: 'markdown', toml: 'toml',
};

// --- Public API -------------------------------------------------------------

/** Generate a fingerprint for a memory at write time. */
export function generateFingerprint(context: {
  projectContext?: ProjectContext | null;
  filePath?: string;
  command?: string;
  tags?: string[];
}): ContextFingerprint {
  const lang = new Set<string>();
  const framework = new Set<string>();
  const module = new Set<string>();

  // From project context (cached scanner result)
  if (context.projectContext) {
    extractFromProjectContext(context.projectContext, lang, framework);
  }

  // From file path
  if (context.filePath) {
    extractFromFilePath(context.filePath, lang, module);
  }

  // From command
  if (context.command) {
    extractFromCommand(context.command, lang);
  }

  // From user-provided tags (hint: tags that look like tech/module names)
  if (context.tags) {
    extractFromTags(context.tags, lang, framework, module);
  }

  return {
    lang: [...lang],
    framework: [...framework],
    module: [...module],
  };
}

/** Build a query fingerprint from the current activity context. */
export function buildQueryFingerprint(context: {
  projectContext?: ProjectContext | null;
  filePath?: string;
  command?: string;
}): ContextFingerprint {
  return generateFingerprint(context);
}

/** Compute dimension-weighted overlap between two fingerprints (0-1). */
export function fingerprintOverlap(
  stored: ContextFingerprint,
  query: ContextFingerprint,
): number {
  const langScore = jaccardOverlap(stored.lang, query.lang);
  const frameworkScore = jaccardOverlap(stored.framework, query.framework);
  const moduleScore = jaccardOverlap(stored.module, query.module);

  const weights = FINGERPRINT.DIMENSION_WEIGHTS;
  return (
    weights.MODULE * moduleScore +
    weights.FRAMEWORK * frameworkScore +
    weights.LANG * langScore
  );
}

/** Build SQL LIKE conditions for fingerprint matching. Returns param pairs [condition, value]. */
export function fingerprintLikeConditions(fp: ContextFingerprint): string[] {
  const terms: string[] = [];
  for (const l of fp.lang) terms.push(l);
  for (const f of fp.framework) terms.push(f);
  for (const m of fp.module) terms.push(m);
  return [...new Set(terms)];
}

// --- Private helpers --------------------------------------------------------

function extractFromProjectContext(
  ctx: ProjectContext,
  lang: Set<string>,
  framework: Set<string>,
): void {
  // Parse tech stack string: "TypeScript/Node.js, better-sqlite3, @modelcontextprotocol/sdk"
  const parts = ctx.techStack.split(',').map(s => s.trim().toLowerCase());
  for (const part of parts) {
    // Language detection
    if (part.includes('typescript')) lang.add('typescript');
    if (part.includes('javascript') || part.includes('node.js') || part.includes('node')) lang.add('javascript');
    if (part.includes('python')) lang.add('python');
    if (part.includes('rust')) lang.add('rust');
    if (part.includes('go') && !part.includes('google')) lang.add('go');
    if (part.includes('java') && !part.includes('javascript')) lang.add('java');
    if (part.includes('ruby')) lang.add('ruby');
    if (part.includes('c++') || part.includes('cpp')) lang.add('cpp');
    if (part.includes('c#') || part.includes('csharp')) lang.add('csharp');

    // Framework/library: strip @scope/ prefix, normalize
    const normalized = part.replace(/@[\w-]+\//, '').replace(/[/\\]/g, '-').trim();
    if (normalized.length > 1 && !isLanguageName(normalized)) {
      framework.add(normalized);
    }
  }
}

function extractFromFilePath(
  filePath: string,
  lang: Set<string>,
  module: Set<string>,
): void {
  // Language from extension
  const ext = extname(filePath).slice(1).toLowerCase();
  if (ext && EXTENSION_LANG_MAP[ext]) {
    lang.add(EXTENSION_LANG_MAP[ext]);
  }

  // Module from directory path segments
  const dir = dirname(filePath);
  const segments = dir
    .split(/[/\\]/)
    .map(s => s.toLowerCase())
    .filter(s => s.length >= 2 && !GENERIC_PATH_SEGMENTS.has(s));

  for (const seg of segments) {
    module.add(seg);
  }

  // Filename stem (without extension) as a module hint
  const stem = basename(filePath, extname(filePath)).toLowerCase();
  if (stem.length >= 2 && !GENERIC_PATH_SEGMENTS.has(stem)) {
    // Split hyphenated/underscored names: "memory-repository" → ["memory", "repository"]
    const parts = stem.split(/[-_]/).filter(p => p.length >= 2);
    for (const p of parts) {
      module.add(p);
    }
  }
}

function extractFromCommand(command: string, lang: Set<string>): void {
  const lower = command.toLowerCase();
  if (lower.includes('python') || lower.includes(' py ')) lang.add('python');
  if (lower.includes('node') || lower.includes('npm') || lower.includes('npx')) lang.add('javascript');
  if (lower.includes('cargo') || lower.includes('rustc')) lang.add('rust');
  if (lower.includes('go ')) lang.add('go');
  if (lower.includes('tsc') || lower.includes('tsx')) lang.add('typescript');
}

/** Known tag values that map to fingerprint dimensions. */
const TAG_DIMENSION_MAP: Record<string, { dim: 'lang' | 'framework' | 'module'; value: string }> = {
  python: { dim: 'lang', value: 'python' },
  typescript: { dim: 'lang', value: 'typescript' },
  javascript: { dim: 'lang', value: 'javascript' },
  xml: { dim: 'lang', value: 'xml' },
  sql: { dim: 'lang', value: 'sql' },
  bash: { dim: 'lang', value: 'bash' },
  ruby: { dim: 'lang', value: 'ruby' },
  go: { dim: 'lang', value: 'go' },
  rust: { dim: 'lang', value: 'rust' },
  java: { dim: 'lang', value: 'java' },
  node: { dim: 'framework', value: 'node' },
  docker: { dim: 'framework', value: 'docker' },
  sqlite: { dim: 'framework', value: 'sqlite' },
  odoo: { dim: 'framework', value: 'odoo' },
  django: { dim: 'framework', value: 'django' },
  flask: { dim: 'framework', value: 'flask' },
  react: { dim: 'framework', value: 'react' },
  orm: { dim: 'module', value: 'orm' },
  hooks: { dim: 'module', value: 'hooks' },
  views: { dim: 'module', value: 'views' },
  security: { dim: 'module', value: 'security' },
  testing: { dim: 'module', value: 'testing' },
  database: { dim: 'module', value: 'database' },
  auth: { dim: 'module', value: 'auth' },
  api: { dim: 'module', value: 'api' },
  portal: { dim: 'module', value: 'portal' },
  accounting: { dim: 'module', value: 'accounting' },
  billing: { dim: 'module', value: 'billing' },
  payment: { dim: 'module', value: 'payment' },
  stock: { dim: 'module', value: 'stock' },
  controller: { dim: 'module', value: 'controller' },
};

function extractFromTags(
  tags: string[],
  lang: Set<string>,
  framework: Set<string>,
  module: Set<string>,
): void {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    const mapping = TAG_DIMENSION_MAP[lower];
    if (mapping) {
      const target = mapping.dim === 'lang' ? lang : mapping.dim === 'framework' ? framework : module;
      target.add(mapping.value);
    }
    // Ignore severity tags (high, critical, medium, low) — not retrieval signals
  }
}

/** Path segments that carry no retrieval signal. The `opt|usr|var|home|root|
 *  tmp|etc` entries drop filesystem-root segments that leak in from absolute
 *  paths (`/opt/cairn/...`), and `.claude|worktrees` drop Claude Code worktree
 *  structure (`.claude/worktrees/<slug>/...`). Kept in sync with
 *  `BRIEFING_GENERIC_SEGMENTS` in `hooks/shared/briefing-compiler.ts`. */
const GENERIC_PATH_SEGMENTS = new Set([
  'src', 'lib', 'dist', 'build', 'out', 'bin',
  'node_modules', 'packages', 'vendor',
  'public', 'static', 'assets', 'resources',
  'opt', 'usr', 'var', 'home', 'root', 'tmp', 'etc',
  CLAUDE_CODE.CONFIG_DIR, 'worktrees',
  '.', '..',
]);

const LANGUAGE_NAMES = new Set([
  'typescript', 'javascript', 'python', 'ruby', 'go', 'rust',
  'java', 'kotlin', 'csharp', 'cpp', 'c', 'node.js',
]);

function isLanguageName(s: string): boolean {
  return LANGUAGE_NAMES.has(s);
}
