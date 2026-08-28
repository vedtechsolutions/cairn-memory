/**
 * Project scanner — lightweight filesystem scan for structural context.
 * Captures project name, tech stack, directory structure, entry points.
 * Designed to run in < 200ms for projects up to 10,000 files.
 */
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename } from 'node:path';
import { PROJECT_SCAN } from '../constants/index.js';
import { now } from './time.js';

// --- Types ------------------------------------------------------------------

export interface ProjectContext {
  gitHash: string;
  projectName: string;
  techStack: string;
  structure: string[];
  entryPoints: string[];
  keyConfigs: string[];
  scannedAt: string;
}

// --- Public API -------------------------------------------------------------

/** Get the current git commit hash. Returns null if not a git repo. */
export function getGitHash(cwd: string): string | null {
  try {
    const result = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

/** Get the subject of the latest git commit (single line). Returns null if
 *  not a git repo, empty repo, or command failure. Used by the branch-goal
 *  synthesizer to enrich a branch name with a human-readable task hint. */
export function getLatestCommitSubject(cwd: string): string | null {
  try {
    const result = execFileSync('git', ['log', '-1', '--pretty=%s'], {
      cwd,
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const subject = result.trim();
    return subject.length > 0 ? subject : null;
  } catch {
    return null;
  }
}

/** Scan project directory for structural context. Fast (~200ms). */
export function scanProject(cwd: string): ProjectContext {
  const gitHash = getGitHash(cwd) ?? 'no-git';
  const keyConfigs = detectConfigs(cwd);
  const { name, techStack, entryPoints } = inferTechStack(cwd, keyConfigs);
  const structure = scanStructure(cwd);

  return {
    gitHash,
    projectName: name || basename(cwd),
    techStack,
    structure,
    entryPoints,
    keyConfigs,
    scannedAt: now(),
  };
}

/** Format ProjectContext as compact briefing lines (~60-80 tokens). */
export function formatProjectContext(ctx: ProjectContext): string[] {
  const lines: string[] = [];

  // Tech stack line (merged with project name in the briefing's Project: header)
  if (ctx.techStack) {
    lines.push(`Tech: ${ctx.techStack}`);
  }

  // Structure
  if (ctx.structure.length > 0) {
    lines.push(`Structure: ${ctx.structure.join(' | ')}`);
  }

  // Entry points (deduplicated, max 2)
  const uniqueEntries = [...new Set(ctx.entryPoints)].slice(0, 2);
  if (uniqueEntries.length > 0) {
    lines.push(`Entry: ${uniqueEntries.join(', ')}`);
  }

  // Config files
  if (ctx.keyConfigs.length > 0) {
    lines.push(`Config: ${ctx.keyConfigs.join(', ')}`);
  }

  return lines;
}

/** Ultra-compact project context — single line for startup briefings.
 *  Format: "Stack: TypeScript/Node.js | src/{constants/,db/,hooks/}" */
export function formatProjectContextCompact(ctx: ProjectContext, maxChars: number): string {
  const parts: string[] = [];
  if (ctx.techStack) parts.push(ctx.techStack);
  if (ctx.structure.length > 0) parts.push(ctx.structure.join(' | '));
  const line = parts.join(' | ');
  if (line.length <= maxChars) return line;
  return line.slice(0, maxChars - 1) + '…';
}

/** Extract all meaningful directory/file-stem tokens from the project structure.
 *  Used for fingerprint staleness detection — checking if memory module terms
 *  still exist in the project. */
export function getProjectModuleTerms(cwd: string): Set<string> {
  const terms = new Set<string>();
  const ignoredSet = new Set(PROJECT_SCAN.IGNORED_DIRS);

  function walkDir(dir: string, depth: number): void {
    if (depth > 2) return; // max 3 levels deep
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || ignoredSet.has(entry.name)) continue;
        const name = entry.name.toLowerCase();

        if (entry.isDirectory()) {
          if (name.length >= 2) terms.add(name);
          walkDir(join(dir, entry.name), depth + 1);
        } else {
          // Extract file stem tokens (split on - and _)
          const stem = name.replace(/\.[^.]+$/, '');
          for (const part of stem.split(/[-_]/)) {
            if (part.length >= 2) terms.add(part);
          }
        }
      }
    } catch { /* unreadable directory */ }
  }

  walkDir(cwd, 0);
  return terms;
}

/** Get files deleted between two git commits. Returns file paths relative to cwd.
 *  Returns empty array on error (non-fatal). */
export function getDeletedFiles(cwd: string, fromHash: string, toHash: string, timeoutMs = 5000): string[] {
  try {
    const result = execFileSync(
      'git',
      ['diff', '--diff-filter=D', '--name-only', `${fromHash}..${toHash}`],
      { cwd, encoding: 'utf-8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return result.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/** Get files renamed between two git commits. Returns old→new path pairs.
 *  Uses git's rename detection (-M). Returns empty array on error (non-fatal). */
export function getGitRenames(cwd: string, fromHash: string, toHash: string, timeoutMs = 5000): Array<{ oldPath: string; newPath: string }> {
  try {
    const result = execFileSync(
      'git',
      ['diff', '-M', '--diff-filter=R', '--name-status', `${fromHash}..${toHash}`],
      { cwd, encoding: 'utf-8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    // Format: R100\told/path\tnew/path (tab-separated)
    return result.trim().split('\n').filter(Boolean).map(line => {
      const parts = line.split('\t');
      if (parts.length >= 3) return { oldPath: parts[1], newPath: parts[2] };
      return null;
    }).filter((r): r is { oldPath: string; newPath: string } => r !== null);
  } catch {
    return [];
  }
}

/** Git working tree state for briefing injection */
export interface GitWorkingState {
  branch: string;
  uncommittedCount: number;
  unpushedCount: number;
  /** Most recent commit subjects on HEAD — used by the briefing's goal
   *  staleness gate to detect goals that describe shipped work. Optional:
   *  absent when the log call fails or the caller doesn't populate it
   *  (e.g. test fixtures that only care about branch name). */
  recentCommits?: string[];
}

/** Get git working tree state: branch, uncommitted file count, unpushed commit count,
 *  and the last `recentCommitLimit` commit subjects on HEAD for ship-detection. */
export function getGitWorkingState(
  cwd: string,
  timeoutMs = 5000,
  recentCommitLimit = 8,
): GitWorkingState | null {
  try {
    // Current branch name
    const branch = execFileSync(
      'git', ['rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd, encoding: 'utf-8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    // Uncommitted files (staged + unstaged + untracked)
    const status = execFileSync(
      'git', ['status', '--porcelain'],
      { cwd, encoding: 'utf-8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    const uncommittedCount = status ? status.split('\n').length : 0;

    // Unpushed commits (may fail if no upstream)
    let unpushedCount = 0;
    try {
      const log = execFileSync(
        'git', ['log', '@{u}..HEAD', '--oneline'],
        { cwd, encoding: 'utf-8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      unpushedCount = log ? log.split('\n').length : 0;
    } catch { /* no upstream — leave as 0 */ }

    // Recent commit subjects (for goal ship-detection)
    let recentCommits: string[] = [];
    try {
      const log = execFileSync(
        'git', ['log', `-${recentCommitLimit}`, '--pretty=%s'],
        { cwd, encoding: 'utf-8', timeout: timeoutMs, stdio: ['pipe', 'pipe', 'pipe'] },
      ).trim();
      recentCommits = log ? log.split('\n').filter(s => s.length > 0) : [];
    } catch { /* no commits or git error — leave empty */ }

    return { branch, uncommittedCount, unpushedCount, recentCommits };
  } catch {
    return null;
  }
}

// --- Private helpers --------------------------------------------------------

/** Detect which key config files exist. */
function detectConfigs(cwd: string): string[] {
  return PROJECT_SCAN.CONFIG_FILES.filter(f => existsSync(join(cwd, f)));
}

/** Infer project name, tech stack, and entry points from config files. */
function inferTechStack(
  cwd: string,
  configs: string[],
): { name: string; techStack: string; entryPoints: string[] } {
  const parts: string[] = [];
  const entryPoints: string[] = [];
  let name = '';

  // Node.js / TypeScript
  if (configs.includes('package.json')) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
      name = pkg.name ?? '';
      if (configs.includes('tsconfig.json')) {
        parts.push('TypeScript/Node.js');
      } else {
        parts.push('Node.js');
      }
      // Key dependencies (top 3 runtime deps)
      const deps = Object.keys(pkg.dependencies ?? {}).slice(0, 3);
      if (deps.length > 0) parts.push(deps.join(', '));
      // Entry points
      if (pkg.main) entryPoints.push(pkg.main);
      if (pkg.bin) {
        for (const v of Object.values(pkg.bin)) {
          if (typeof v === 'string') entryPoints.push(v);
        }
      }
    } catch { /* corrupted package.json — skip */ }
  }

  // Rust
  if (configs.includes('Cargo.toml')) {
    parts.push('Rust');
    try {
      const cargo = readFileSync(join(cwd, 'Cargo.toml'), 'utf-8');
      const nameMatch = cargo.match(/^name\s*=\s*"([^"]+)"/m);
      if (nameMatch) name = name || nameMatch[1];
    } catch {}
  }

  // Python
  if (configs.includes('pyproject.toml') || configs.includes('setup.py') || configs.includes('setup.cfg')) {
    parts.push('Python');
    try {
      const pyp = readFileSync(join(cwd, 'pyproject.toml'), 'utf-8');
      const nameMatch = pyp.match(/^name\s*=\s*"([^"]+)"/m);
      if (nameMatch) name = name || nameMatch[1];
    } catch {}
  }

  // Go
  if (configs.includes('go.mod')) {
    parts.push('Go');
    try {
      const gomod = readFileSync(join(cwd, 'go.mod'), 'utf-8');
      const modMatch = gomod.match(/^module\s+(\S+)/m);
      if (modMatch) name = name || (modMatch[1].split('/').pop() ?? '');
    } catch {}
  }

  // Java
  if (configs.includes('build.gradle') || configs.includes('pom.xml')) {
    parts.push('Java');
  }

  // C/C++
  if (configs.includes('CMakeLists.txt')) {
    parts.push('C/C++');
  }

  // Docker
  if (configs.includes('docker-compose.yml')) {
    parts.push('Docker');
  }

  return {
    name,
    techStack: parts.join(', ') || 'Unknown',
    entryPoints,
  };
}

/** Scan top-level directory structure in compact notation. */
function scanStructure(cwd: string): string[] {
  const ignoredSet = new Set(PROJECT_SCAN.IGNORED_DIRS);

  let entries: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.') && !ignoredSet.has(e.name))
    .slice(0, PROJECT_SCAN.MAX_TOP_DIRS);

  return dirs.map(d => {
    try {
      const sub = readdirSync(join(cwd, d.name), { withFileTypes: true });
      const subDirs = sub
        .filter(s => s.isDirectory() && !s.name.startsWith('.') && !ignoredSet.has(s.name))
        .map(s => s.name + '/');

      if (subDirs.length > 0) {
        return `${d.name}/{${subDirs.join(',')}}`;
      }
    } catch { /* unreadable — just show the dir name */ }
    return d.name + '/';
  });
}
