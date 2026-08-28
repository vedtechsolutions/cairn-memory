import { estimateTokensFast } from '../../../utils/tokens.js';
import type { GovernanceBriefingSection } from '../../../governance/briefing.js';

export const GOVERNANCE_TIER_MAX_TOKENS = 180;

export interface GovernanceTier {
  lines: string[];
  tokens: number;
}

function renderLines(section: GovernanceBriefingSection): string[] {
  const lines = ['[Cairn Governance — advisory; not enforced]'];
  if (section.rules.length > 0) {
    lines.push('Applicable pre-exit rules:');
    for (const rule of section.rules) lines.push(`  - ${rule}`);
  } else {
    lines.push('Applicable pre-exit rules: none');
  }
  lines.push(section.capabilityReasons.length > 0
    ? `Capability: degraded (${section.capabilityReasons.join(', ')})`
    : 'Capability: shadow observation available');
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
