/**
 * File-path and command classification helpers used while scanning
 * transcript entries.
 */
import type { CommandBucket } from './snapshot.js';

/** Extensionless file names that are still legitimate file reads. */
const EXTENSIONLESS_FILE_ALLOWLIST = new Set([
  'Makefile', 'Dockerfile', 'Rakefile', 'Gemfile', 'Jenkinsfile',
  'LICENSE', 'README', 'CHANGELOG', 'AUTHORS', 'CONTRIBUTORS',
  'NOTICE', 'COPYING', 'VERSION',
]);

/** True if the path looks like a real file (not a bare directory name).
 *  Accepts anything with an extension on the basename, plus a small
 *  allowlist of extensionless-but-real files (Makefile, README, etc).
 *  Rejects "tests", "src", ".", and similar bare directory markers that
 *  sneak in via Grep/Glob `path` arguments. */
export function looksLikeFilePath(p: string): boolean {
  if (!p) return false;
  const trimmed = p.replace(/\/+$/, '');
  if (trimmed.length === 0) return false;
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  if (base.length === 0 || base === '.' || base === '..') return false;
  // Has a file extension on the basename (e.g., foo.ts, .eslintrc.json).
  // We require the dot to NOT be the first char unless followed by more
  // characters — `.env`, `.gitignore` should pass; bare `.` should not.
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx > 0 && dotIdx < base.length - 1) return true;
  // Extensionless allowlist (Makefile, README, etc).
  return EXTENSIONLESS_FILE_ALLOWLIST.has(base);
}

/** Classify a Bash command into a resolution bucket, or null if it's not
 *  a build/test/typecheck/lint invocation. Used by parseTranscript to drop
 *  errors that the transcript itself proves were resolved. */
export function classifyCommandBucket(command: string): CommandBucket | null {
  const cmd = command.trim().toLowerCase();
  // Typecheck: tsc (with or without --noEmit)
  if (/(^|[\s&|;])tsc\b/.test(cmd) || /\bnpm\s+run\s+(type|tsc|typecheck)\b/.test(cmd)) {
    return 'typecheck';
  }
  // Test: node --test, jest, vitest, npm/yarn/pnpm test
  if (/(^|[\s&|;])(jest|vitest)\b/.test(cmd)
    || /\b(npm|yarn|pnpm)\s+(run\s+)?test\b/.test(cmd)
    || /\bnode\s+[^|&;]*--test\b/.test(cmd)) {
    return 'test';
  }
  // Build: npm/yarn/pnpm run build, make, cmake
  if (/\b(npm|yarn|pnpm)\s+run\s+build\b/.test(cmd)
    || /(^|[\s&|;])(make|cmake|cargo\s+build|go\s+build)\b/.test(cmd)) {
    return 'build';
  }
  // Lint: eslint, npm/yarn run lint
  if (/(^|[\s&|;])eslint\b/.test(cmd)
    || /\b(npm|yarn|pnpm)\s+run\s+lint\b/.test(cmd)) {
    return 'lint';
  }
  return null;
}
