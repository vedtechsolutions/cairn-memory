/**
 * Secret scanner — redacts high-confidence credentials from memory content
 * before it is stored, so a secret pasted into a lesson (an error log, a
 * command, a config snippet) never lands in the database and never rides along
 * a later promote/export/sync.
 *
 * Coverage boundary: scrubbing runs on every CAPTURE path — waykeep_learn,
 * waykeep_correct(update), the decision/pitfall gateways, and waykeep_ingest
 * learn-mode all funnel through create()/storeMemory()/update(). The strict
 * byte-exact RESTORE path (waykeep_ingest restore → restoreRecord) is a trusted
 * round-trip of an already-scanned export and deliberately preserves bytes; it
 * is the one write path that does not re-scan (see portability.ts).
 *
 * Patterns are deliberately high-confidence (known token shapes, key blocks,
 * credentials-in-URL, and key=value assignments with a secret-ish key AND a
 * secret-shaped value) to keep false positives low in a coding-memory system —
 * redacting a live `process.env.X` reference or a function name would be real
 * signal loss. When in doubt, redacting a suspected secret is safer than
 * storing a real one. Each redaction leaves a visible `[REDACTED:<type>]`
 * marker so the scrub is never silent.
 *
 * Performance: every pattern is linear in input length. The multi-line
 * private-key body is length-bounded (SECRET_SCAN.MAX_PRIVATE_KEY_BODY_BYTES)
 * specifically so an untrusted ingest of many unterminated
 * `-----BEGIN … KEY-----` markers cannot
 * drive the lazy match into O(n²) backtracking and stall the single-threaded
 * server. scrubSecrets uses only String.replace on the module-level /g
 * patterns (which resets lastIndex on each call); do NOT add .test()/.exec()
 * on them — that would leak lastIndex state across calls.
 */
import { SECRET_SCAN } from '../constants/index.js';

/** Replacer receives the match and its POSITIONAL capture groups only. Return
 *  the match unchanged to decline — no redaction is then counted. */
type Replacer = (match: string, ...groups: string[]) => string;

interface SecretPattern {
  name: string;
  regex: RegExp;
  /** Custom replacement; defaults to `[REDACTED:<name>]`. Returning the input
   *  match unchanged declines the redaction (used to spare non-secret values). */
  replace?: Replacer;
}

const REDACTED = (name: string): string => `[REDACTED:${name}]`;

/** A secret-assignment value that carries a digit looks like a real credential;
 *  a bare identifier, dictionary word, env reference, or function name does
 *  not. (Member-access/call values never reach here — the value class excludes
 *  '.' and '(', so `process.env.X` and `getToken()` fail to match at all.) */
const looksLikeSecretValue = (value: string): boolean => /[0-9]/.test(value);

/** Ordered high-confidence patterns. The private-key block runs first so its
 *  multi-line body is removed before narrower patterns scan the remainder. */
const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    // OpenSSH/RSA/EC/PKCS#8/PGP private-key blocks. The body is length-bounded
    // (SECRET_SCAN.MAX_PRIVATE_KEY_BODY_BYTES) to stay linear on adversarial unterminated input.
    name: 'private-key',
    regex: new RegExp(
      `-----BEGIN[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----[\\s\\S]{0,${SECRET_SCAN.MAX_PRIVATE_KEY_BODY_BYTES}}?-----END[ A-Z0-9]*PRIVATE KEY(?: BLOCK)?-----`,
      'g',
    ),
  },
  { name: 'aws-access-key', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { name: 'github-pat', regex: /\bgithub_pat_[A-Za-z0-9_]{50,255}\b/g },
  { name: 'gitlab-token', regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { name: 'slack-token', regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google-api-key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'stripe-key', regex: /\b[sr]k_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { name: 'npm-token', regex: /\bnpm_[A-Za-z0-9]{36}\b/g },
  {
    // OpenAI keys: prefixed project/service/admin keys, and legacy `sk-<48
    // alnum>`. The legacy branch requires a long CONTIGUOUS alphanumeric run so
    // hyphenated slugs like `sk-button-primary-large-rounded` are not redacted.
    name: 'openai-key',
    regex: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|[A-Za-z0-9]{40,})\b/g,
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g,
  },
  {
    // Credentials embedded in a URL: keep the scheme, redact user:pass.
    // Brackets are excluded from the userinfo classes (never valid unencoded in
    // RFC 3986 userinfo) so the `[REDACTED:…]` placeholder is not itself
    // re-matched on a second pass — keeping the scrub idempotent by count too.
    name: 'url-credentials',
    regex: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@[\]]+:[^/\s:@[\]]+@/gi,
    replace: (_match, scheme: string) => `${scheme}[REDACTED:credentials]@`,
  },
  {
    // `Authorization: Bearer <token>` style.
    name: 'bearer-token',
    regex: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/g,
  },
  {
    // key=value / key: value where the key looks like a secret AND the value
    // looks like one. The value class excludes '.' and '(' so member-access
    // (`process.env.X`) and calls (`getToken()`) never match; digit-less
    // identifiers and dictionary words are declined by looksLikeSecretValue.
    // Keeps the key + separator (+ quotes); redacts only the value.
    name: 'secret-assignment',
    regex: /\b(api[_-]?key|secret|password|passwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\b(\s*[:=]\s*)(['"]?)([A-Za-z0-9_-]{12,})(['"]?)/gi,
    replace: (match, key: string, sep: string, open: string, value: string, close: string) =>
      looksLikeSecretValue(value) ? `${key}${sep}${open}[REDACTED:secret]${close}` : match,
  },
];

export interface ScrubResult {
  /** The text with detected secrets replaced by `[REDACTED:<type>]`. */
  text: string;
  /** How many secrets were redacted. */
  redactions: number;
}

/** Redact high-confidence secrets from `text`. Pure and idempotent — a second
 *  pass over already-redacted text makes no further change to the text and
 *  reports zero further redactions. */
export function scrubSecrets(text: string): ScrubResult {
  let redactions = 0;
  let result = text;
  for (const { name, regex, replace } of SECRET_PATTERNS) {
    const replacer: Replacer = replace ?? (() => REDACTED(name));
    result = result.replace(regex, (match: string, ...rest: unknown[]): string => {
      // String.replace passes (match, ...positionalGroups, offset, wholeString).
      // Drop the trailing offset + whole-string to leave just the groups. This
      // assumes POSITIONAL groups only — a NAMED group would append a trailing
      // groups object and shift these; none of the patterns above use one.
      const groups = rest.slice(0, -2) as string[];
      const replacement = replacer(match, ...groups);
      if (replacement !== match) redactions++;
      return replacement;
    });
  }
  return { text: result, redactions };
}
