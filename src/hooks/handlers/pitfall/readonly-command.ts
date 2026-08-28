/**
 * Read-only Bash command detection — skip gate for pitfall injection.
 */

/**
 * Check if a Bash command is read-only. Exported for unit tests.
 * Returns true only when EVERY sub-command
 * (split on `&&`, `||`, `;`, `|`) is definitively read-only. This is a skip gate
 * for pitfall injection — false negatives (real read-only marked unsafe) cost us
 * SNR; false positives (write marked read-only) cost us missed warnings. Err
 * toward precision, not recall.
 */
export function isReadOnlyCommand(cmd: string): boolean {
  // Strip string literals and heredoc bodies so their contents can't be
  // mistaken for shell separators or command verbs. Keep the ORIGINAL command
  // available for special-case checks (sqlite3 write keywords, find flags).
  const sanitized = stripStringsAndHeredocs(cmd);
  const parts = sanitized.split(/\s*(?:\|\|?|&&?|;)\s*/).map(s => s.trim()).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.every(part => isSingleReadOnly(part, cmd));
}

/** Redact quoted strings, backticks, and heredoc bodies with spaces. */
function stripStringsAndHeredocs(cmd: string): string {
  let out = cmd;
  // Heredocs: <<EOF ... EOF and <<'EOF' ... EOF (also <<- variants)
  out = out.replace(/<<-?\s*(['"]?)(\w+)\1[\s\S]*?^\s*\2\s*$/gm, ' ');
  // Remaining (unterminated) heredoc intros — drop the tail after <<TAG
  out = out.replace(/<<-?\s*['"]?\w+['"]?[\s\S]*$/, ' ');
  // Double-quoted strings (handle simple escapes)
  out = out.replace(/"(?:[^"\\]|\\.)*"/g, '""');
  // Single-quoted strings
  out = out.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  // Backtick command substitutions — presence means a nested command; reject
  // by leaving a marker the allowlist won't match.
  out = out.replace(/`[^`]*`/g, ' __SUBSHELL__ ');
  // $() command substitutions — same treatment.
  out = out.replace(/\$\([^)]*\)/g, ' __SUBSHELL__ ');
  return out;
}

const SQLITE_WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|ATTACH|VACUUM|REINDEX|BEGIN|COMMIT|ROLLBACK)\b|(?:^|[\s"'`])\.(?:import|restore|backup|read|load|save|output|once|shell|system)\b/i;
const FIND_WRITE_FLAGS = /(^|\s)(-delete|-exec(dir)?|-fprint(f|0)?|-ok(dir)?)\b/;

const READ_ONLY_ALLOWLIST = new RegExp(
  '^(?:' +
    // git: read-only subcommands only
    'git\\s+(?:status|log|diff|show|branch|tag|remote(?:\\s|$)|stash\\s+list|rev-parse|describe|shortlog|blame|ls-files|ls-remote|config\\s+--get|show-ref|reflog|worktree\\s+list|for-each-ref|cat-file|grep)' +
    // filesystem/navigation
    '|ls|pwd|cd|cat|bat|head|tail|wc|echo|printf|which|type|man|tldr|env|printenv|date|whoami|id|uname|hostname|df|du|free|uptime|file|stat|readlink|realpath|basename|dirname|tree|locate|lsof|mount|true|false|test' +
    // process inspection
    '|ps|pgrep|pstree|top|htop|jobs' +
    // text processing
    '|grep|egrep|fgrep|rg|ripgrep|ag|ack|fd|jq|yq|sort|uniq|cut|paste|tr|column|xxd|hexdump|od|diff|cmp|comm' +
    // language tooling — version/list/check only
    '|node\\s+(?:-v|--version)' +
    '|npm\\s+(?:-v|--version|ls|list|view|info|outdated|config\\s+get)' +
    '|tsc\\s+(?:-v|--version|--noEmit)' +
    '|python3?\\s+(?:-V|--version)' +
    '|pip3?\\s+(?:list|show|--version|-V)' +
    '|deno\\s+--version' +
    '|bun\\s+(?:-v|--version)' +
  ')\\b'
);

/**
 * Check if a single sub-command (no separators) is read-only.
 * `originalCmd` is the unsanitized full command line — used by sqlite3/find
 * special cases so write keywords inside quoted args are still visible.
 */
function isSingleReadOnly(part: string, originalCmd: string): boolean {
  // Reject anything with a subshell marker from the sanitizer.
  if (/__SUBSHELL__/.test(part)) return false;

  // Strip leading env-var assignments (FOO=bar BAZ=qux cmd ...) and sudo.
  const cleaned = part
    .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '')
    .replace(/^sudo(?:\s+-[A-Za-z]+)*\s+/, '')
    .replace(/^(?:time|nice|nohup)\s+/, '')
    .trimStart();
  if (!cleaned) return false;

  // sqlite3: read-only only when the command has no write keywords. Check
  // the ORIGINAL command string (not the quote-stripped one) so SQL inside
  // quotes or heredocs is still inspected.
  if (/^sqlite3\b/.test(cleaned)) {
    return !SQLITE_WRITE_KEYWORDS.test(originalCmd);
  }

  // find: reject write/side-effect flags (check original for quoted args).
  if (/^find\b/.test(cleaned)) {
    return !FIND_WRITE_FLAGS.test(originalCmd);
  }

  return READ_ONLY_ALLOWLIST.test(cleaned);
}
