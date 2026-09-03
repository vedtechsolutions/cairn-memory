/**
 * Time budgets for tests that drive real git and real sockets. Production
 * ceilings (a 1 s digest, a 3 s relay wait) bound the code's own work; a
 * loaded test host stretches any sample, so tests that assert on outcomes
 * rather than timing run under these generous budgets instead.
 */
import { WORKTREE_DIGEST } from '../../src/constants/index.js';

/** Deadline budget for a corpus/digest capture that must complete. Equal to
 *  the per-git-call timeout: a wedged git is cut by that timeout anyway, so a
 *  larger budget would only lengthen the stall, never the coverage. */
export const GENEROUS_DIGEST_BUDGET_MS = WORKTREE_DIGEST.GIT_TIMEOUT_MS;

/** Daemon-wait budget handed to the compiled relay (as its env override) so
 *  a mock daemon answering under load never trips the 3 s production wait. */
export const GENEROUS_RELAY_TIMEOUT_MS = 30_000;
