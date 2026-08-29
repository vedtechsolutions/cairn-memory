import { estimateTokensFast } from '../../../utils/tokens.js';
import type { GovernanceBriefingSection } from '../../../governance/briefing.js';

export const GOVERNANCE_TIER_MAX_TOKENS = 180;

export interface GovernanceTier {
  lines: string[];
  tokens: number;
}

/** An unsupported client is a DESIGN boundary, not a breakage: the
 *  advisory layer supports Claude Code sessions only today. Raw codes
 *  ("unsupported_client, stale_heartbeat") next to doctor's "wired and
 *  trusted 10/10" read as a health contradiction (field review) — say
 *  it plainly, and drop the secondary reasons, which are meaningless
 *  once the client itself is out of scope. */
function renderCapabilityLine(reasons: readonly string[]): string {
  if (reasons.length === 0) return 'Capability: shadow observation available';
  if (reasons.includes('unsupported_client')) {
    return 'Capability: governance advisory is Claude Code-only today (informational for this client)';
  }
  return `Capability: degraded (${reasons.join(', ')})`;
}

function renderLines(section: GovernanceBriefingSection): string[] {
  const lines = ['[Cairn Governance — advisory; not enforced]'];
  if (section.rules.length > 0) {
    lines.push('Applicable pre-exit rules:');
    for (const rule of section.rules) lines.push(`  - ${rule}`);
  } else {
    lines.push('Applicable pre-exit rules: none');
  }
  lines.push(renderCapabilityLine(section.capabilityReasons));
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
