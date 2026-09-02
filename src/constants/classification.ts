// ============================================================================
// Error classification, rollout lookup and agent framing
// ============================================================================

// --- Intent Classification --------------------------------------------------

export { INTENTS, type UserIntent } from 'waykeep-contract';

// --- Error Classification ---------------------------------------------------

export const LEARNABLE_ERROR_PATTERNS = [
  { pattern: /SyntaxError|IndentationError/, tags: ['python', 'syntax'] },
  { pattern: /ImportError|ModuleNotFoundError/, tags: ['python', 'imports'] },
  { pattern: /TypeError|AttributeError/, tags: ['python', 'api'] },
  { pattern: /ParseError|XMLSyntaxError/, tags: ['xml', 'parsing'] },
  { pattern: /AssertionError/, tags: ['testing'] },
  { pattern: /ValidationError|IntegrityError/, tags: ['orm', 'database'] },
  { pattern: /KeyError.*field/, tags: ['odoo', 'fields'] },
  { pattern: /error TS\d+|Cannot find module|Property .+ does not exist/, tags: ['typescript'] },
  { pattern: /ERR_MODULE_NOT_FOUND|ERR_REQUIRE_ESM|Cannot find package/, tags: ['node', 'modules'] },
  { pattern: /ENOENT|EACCES|EPERM|EADDRINUSE/, tags: ['node', 'system'] },
  { pattern: /ReferenceError|RangeError/, tags: ['javascript'] },
  { pattern: /SQLITE_ERROR|SQLITE_CONSTRAINT|SQLITE_BUSY/, tags: ['sqlite', 'database'] },
  { pattern: /npm ERR!|error Command failed|ERR_PNPM_/, tags: ['npm'] },
  { pattern: /Failed to compile|Build failed|build error/i, tags: ['build'] },
  { pattern: /OSError|FileNotFoundError|OverflowError|RuntimeError|RecursionError|NotImplementedError|StopIteration/, tags: ['python'] },
  { pattern: /exit(?:ed)? (?:with )?(?:code|status) [1-9]/, tags: ['process'] },
] as const;

export const NOISE_ERROR_PATTERNS = [
  /ConnectionError|TimeoutError|ConnectionRefused/,
  /PermissionError|Permission denied/,
  /command not found/,
  /KeyboardInterrupt/,
  /SIGTERM|SIGKILL/,
  /ETIMEOUT|ECONNRESET|ECONNREFUSED/,
] as const;
