/**
 * Extract semantic concept tokens from a file path.
 * Used by pitfall-check to bridge the gap between file names and memory tags.
 * e.g., "src/auth/oauth_handler.py" → ["auth", "oauth", "handler"]
 */

/**
 * Only truly generic path segments that add no retrieval signal.
 * Architectural directory names (hooks, views, models, controllers, etc.)
 * are intentionally KEPT — they are the most meaningful retrieval signals.
 */
const PATH_STOPWORDS = new Set([
  'src', 'lib', 'dist', 'build', 'out', 'bin',
  'node_modules', 'packages', 'vendor',
  'public', 'static', 'assets', 'resources',
  'index', 'main',
]);

export function extractPathConcepts(filePath: string): string[] {
  const segments = filePath
    .split(/[/\\_.\-]/)
    .flatMap(splitCamelCase)
    .map(s => s.toLowerCase())
    .filter(s => s.length >= 2 && !PATH_STOPWORDS.has(s));

  // Deduplicate while preserving order
  return [...new Set(segments)];
}

function splitCamelCase(str: string): string[] {
  return str
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(' ');
}
