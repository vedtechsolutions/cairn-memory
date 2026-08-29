/**
 * Agent-client identity — re-exported from the contract package, which is
 * the source of truth (the constants are wire-visible across separately
 * shipped artifacts). This shim keeps the ~15 existing import sites
 * stable.
 */
export {
  CLIENT_CLAUDE,
  CLIENT_CODEX,
  CLIENT_UNKNOWN,
  CLIENT_ENV_VAR,
  CLIENT_HEADER,
} from 'cairn-contract';
