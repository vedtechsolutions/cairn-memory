/**
 * Code-location anchoring — extract file paths and symbols from memory content.
 * Links memories to specific code locations for file-aware retrieval.
 */

export interface CodeAnchor {
  /** Relative file paths referenced in the content */
  files: string[];
  /** Function/class/symbol names mentioned */
  symbols: string[];
}

/** Regex patterns for extracting file paths from text */
const FILE_PATH_PATTERNS = [
  // Explicit paths: src/foo/bar.ts, ./lib/utils.py, /opt/project/file.js.
  // A SENTENCE-final '.' terminates (lookahead: followed by whitespace,
  // another dot, or EOL): distilled lessons put filenames at sentence end
  // ("… in valcheck-one.ts. Fix: …") — without it those anchors were
  // silently empty. A bare '.' terminator would also accept member-access
  // dots and anchor `process.env` as a file (env-var names over 6 chars
  // backtrack to `process` + `.env`), hence the lookahead.
  /(?:^|[\s(`"'])([.\w/-]+\.\w{1,6})(?:[\s)'"`,;:]|\.(?=[\s.]|$)|$)/gm,
];

/** Regex patterns for extracting symbol names (functions, classes) */
const SYMBOL_PATTERNS = [
  // function foo(), def bar(), class Baz
  /\b(?:function|def|class|const|let|var|export)\s+(\w{3,})/g,
  // foo(), bar.baz() — function calls
  /\b([a-z]\w{2,})\s*\(/g,
  // CamelCase class names
  /\b([A-Z][a-zA-Z]{2,})\b/g,
];

/** Common file extensions that indicate a real file path */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'py', 'pyi', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'cpp', 'h', 'hpp', 'cs',
  'sql', 'sh', 'bash', 'zsh',
  'json', 'yaml', 'yml', 'toml', 'xml',
  'md', 'txt', 'cfg', 'ini', 'env',
  'html', 'css', 'scss', 'vue', 'svelte',
]);

/** Words that look like file paths but aren't */
const FALSE_POSITIVE_PATHS = new Set([
  'e.g.', 'i.e.', 'etc.', 'vs.', 'v1.0', 'v2.0',
]);

/**
 * Extract code-location anchor from memory content.
 * Returns null if no meaningful anchors found.
 */
export function extractAnchor(content: string): CodeAnchor | null {
  const files = extractFilePaths(content);
  const symbols = extractSymbols(content);

  if (files.length === 0 && symbols.length === 0) return null;

  return {
    files: files.slice(0, 5),    // Cap at 5 files
    symbols: symbols.slice(0, 5), // Cap at 5 symbols
  };
}

/** Extract file paths from content text */
function extractFilePaths(content: string): string[] {
  const found = new Set<string>();

  for (const pattern of FILE_PATH_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const path = match[1];
      if (!path) continue;

      // Validate: must have a code extension
      const ext = path.split('.').pop()?.toLowerCase() ?? '';
      if (!CODE_EXTENSIONS.has(ext)) continue;

      // Filter false positives
      if (FALSE_POSITIVE_PATHS.has(path.toLowerCase())) continue;

      // Must have at least one path separator or be a simple filename
      if (path.includes('/') || path.includes('.')) {
        found.add(path);
      }
    }
  }

  return [...found];
}

/** Extract symbol names from content text */
function extractSymbols(content: string): string[] {
  const found = new Set<string>();

  // Common words that match patterns but aren't symbols
  const noise = new Set([
    'the', 'and', 'for', 'not', 'but', 'use', 'get', 'set', 'has', 'new',
    'try', 'catch', 'throw', 'return', 'this', 'that', 'with', 'from',
    'import', 'export', 'const', 'class', 'function', 'async', 'await',
    'always', 'never', 'should', 'must', 'when', 'before', 'after',
    'error', 'warning', 'because', 'instead', 'avoid', 'ensure',
    'problem', 'solution', 'issue', 'fix', 'bug', 'feature',
  ]);

  for (const pattern of SYMBOL_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const sym = match[1];
      if (!sym || sym.length < 3) continue;
      if (noise.has(sym.toLowerCase())) continue;
      found.add(sym);
    }
  }

  return [...found];
}

/** Serialize anchor to JSON for SQLite TEXT column */
export function anchorToJson(anchor: CodeAnchor): string {
  return JSON.stringify(anchor);
}

/** Deserialize anchor from JSON */
export function jsonToAnchor(json: string): CodeAnchor | null {
  try {
    const parsed = JSON.parse(json);
    if (parsed && Array.isArray(parsed.files) && Array.isArray(parsed.symbols)) {
      return parsed as CodeAnchor;
    }
    return null;
  } catch {
    return null;
  }
}
