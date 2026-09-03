/**
 * POSIX single-quote an argument for a human-readable command line. Safe
 * characters pass through; anything else is wrapped in single quotes with
 * embedded quotes closed, escaped and reopened. Two copies with the same
 * character class written differently lived in the CLI and the governance
 * recorder (audit).
 */
const SAFE_ARGUMENT = /^[A-Za-z0-9_./:=@%+,-]+$/u;

export function shellQuote(argument: string): string {
  return SAFE_ARGUMENT.test(argument) ? argument : `'${argument.replaceAll("'", "'\\''")}'`;
}
