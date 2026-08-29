import { PROACTIVE } from '../../constants/index.js';
import type { EditTracker } from './edit-tracker.js';

/** Start/reset the proactive-warning allowance at UserPromptSubmit. */
export function startWarningTurn(tracker: EditTracker, explicitTurnId?: string): void {
  const sequence = (tracker.warningBudgetSequence ?? 0) + 1;
  const turnKey = explicitTurnId ?? `prompt:${sequence}`;

  tracker.warningBudgetSequence = sequence;
  if (tracker.warningBudgetTurnKey === turnKey) return;
  tracker.warningBudgetTurnKey = turnKey;
  tracker.warningTokensInjectedThisTurn = 0;
  tracker.warningCountInjectedThisTurn = 0;
}

/**
 * Align a pre-tool event with its turn. Agents with `turn_id` get a strict
 * cross-tool budget. Without correlation, UserPromptSubmit's synthetic key
 * remains authoritative; if even that hook was absent, fail open per call.
 */
export function alignWarningTurn(
  tracker: EditTracker,
  explicitTurnId?: string,
  toolUseId?: string,
): void {
  if (explicitTurnId) {
    if (tracker.warningBudgetTurnKey !== explicitTurnId) {
      tracker.warningBudgetTurnKey = explicitTurnId;
      tracker.warningTokensInjectedThisTurn = 0;
      tracker.warningCountInjectedThisTurn = 0;
    }
    return;
  }

  if (!tracker.warningBudgetTurnKey || tracker.warningBudgetTurnKey.startsWith('uncorrelated:')) {
    const sequence = (tracker.warningBudgetSequence ?? 0) + 1;
    tracker.warningBudgetSequence = sequence;
    tracker.warningBudgetTurnKey = `uncorrelated:${toolUseId ?? sequence}`;
    tracker.warningTokensInjectedThisTurn = 0;
    tracker.warningCountInjectedThisTurn = 0;
  }
}

export function warningTokensRemaining(tracker: EditTracker): number {
  const used = tracker.warningTokensInjectedThisTurn ?? 0;
  return Math.max(0, PROACTIVE.WARNING_TOKEN_BUDGET_PER_TURN - used);
}

export function warningBudgetAvailable(tracker: EditTracker): boolean {
  return (tracker.warningCountInjectedThisTurn ?? 0) < PROACTIVE.MAX_WARNINGS_PER_TURN
    && warningTokensRemaining(tracker) > 0;
}

export function recordWarningInjection(tracker: EditTracker, tokens: number): void {
  tracker.warningTokensInjectedThisTurn = (tracker.warningTokensInjectedThisTurn ?? 0) + tokens;
  tracker.warningCountInjectedThisTurn = (tracker.warningCountInjectedThisTurn ?? 0) + 1;
}
