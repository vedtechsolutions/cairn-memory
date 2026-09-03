import { estimateTokensFast } from '../../../utils/tokens.js';
import type { GovernanceBriefingSection } from '../../../governance/briefing.js';

export interface GovernanceTier {
  lines: string[];
  tokens: number;
}

/** An out-of-scope client is a DESIGN boundary, not a breakage: the
 *  advisory layer supports Claude Code sessions only today, and raw
 *  codes next to doctor's "wired and trusted 10/10" read as a health
 *  contradiction (field review). Branch on the SESSION's client
 *  identity, never on the unsupported_client code: a claude-code
 *  session reading a foreign-stamped state row carries that code too,
 *  and code-based inference would swallow its real degradations
 *  (review round 2 of this fix). */
function renderCapabilityLine(clientInScope: boolean, reasons: readonly string[]): string {
  if (!clientInScope) {
    return 'Capability: governance advisory is Claude Code-only today (informational for this client)';
  }
  if (reasons.length === 0) return 'Capability: shadow observation available';
  return `Capability: degraded (${reasons.join(', ')})`;
}

function renderLines(section: GovernanceBriefingSection): string[] {
  const lines = ['[Waykeep Governance — advisory; not enforced]'];
  if (section.rules.length > 0) {
    lines.push('Applicable pre-exit rules:');
    for (const rule of section.rules) lines.push(`  - ${rule}`);
  } else {
    lines.push('Applicable pre-exit rules: none');
  }
  lines.push(renderCapabilityLine(section.clientInScope, section.capabilityReasons));
  if (section.lastVerdict !== null) {
    const verdict = section.lastVerdict;
    lines.push(
      `Last shadow result: ${verdict.result}/${verdict.reason}; age ${verdict.ageEvents} event(s)`,
    );
  }
  return lines;
}

/** Optional high-priority tier; omitted as a whole when the remaining budget cannot hold it. */
export function renderGovernanceTier(
  section: GovernanceBriefingSection | null | undefined,
  budget: number,
): GovernanceTier {
  if (section === null || section === undefined || budget <= 0) return { lines: [], tokens: 0 };
  const lines = renderLines(section);
  while (lines.length > 1 && estimateTokensFast(lines.join('\n')) > budget) {
    lines.splice(lines.length - 2, 1);
  }
  const tokens = estimateTokensFast(lines.join('\n'));
  return tokens <= budget ? { lines, tokens } : { lines: [], tokens: 0 };
}
