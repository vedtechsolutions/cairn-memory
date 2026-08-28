const SECRET_FLAG = /^(?:--?)?(?:token|secret|password|passwd|api[-_]?(?:key)|private[-_]?(?:key)|credential|auth)(?:=|$)/iu;

/** Redact values while preserving enough argv shape for a diagnostic display. */
export function redactArgv(argv: readonly string[]): string[] {
  const redacted: string[] = [];
  let redactNext = false;
  for (const argument of argv) {
    if (redactNext) {
      redacted.push('[REDACTED]');
      redactNext = false;
      continue;
    }
    const assignment = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su);
    if (assignment !== null) {
      redacted.push(`${assignment[1]}=[REDACTED]`);
      continue;
    }
    if (SECRET_FLAG.test(argument)) {
      const equals = argument.indexOf('=');
      if (equals >= 0) redacted.push(`${argument.slice(0, equals + 1)}[REDACTED]`);
      else {
        redacted.push(argument);
        redactNext = true;
      }
      continue;
    }
    redacted.push(argument.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, '$1[REDACTED]@'));
  }
  return redacted;
}
