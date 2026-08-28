/**
 * LongMemEval dataset types + fail-closed validation.
 * Format reference: xiaowu0162/longmemeval-cleaned (HuggingFace, MIT) — each
 * question carries its OWN haystack (sessions + dates + evidence labels), which
 * is why evaluation uses one isolated store per question.
 */

export interface LmeTurn {
  role: string;
  content: string;
  /** Official evidence label: evidence turns carry has_answer: true (or
   *  false inside evidence sessions); unlabeled turns OMIT the field.
   *  Verified against the pinned dataset: zero null labels. */
  has_answer?: boolean;
}

export interface LmeQuestion {
  question_id: string;
  question_type: string;
  question: string;
  answer?: unknown;
  question_date?: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: LmeTurn[][];
  answer_session_ids: string[];
}

/** Official convention: abstention items carry a question_id suffixed `_abs`.
 *  They are skipped for retrieval scoring (no evidence to retrieve). */
export function isAbstention(q: LmeQuestion): boolean {
  return q.question_id.endsWith('_abs');
}

const VALID_ROLES = new Set(['user', 'assistant']);
/** Official session date format: "2023/05/20 (Sat) 02:21" (weekday optional) */
const DATE_RE = /^(\d{4})\/(\d{2})\/(\d{2})\s*(?:\([^)]*\)\s*)?(\d{2}):(\d{2})$/;

/** Explicit, locale-independent parse of the official date format via
 *  Date.UTC. FAILS CLOSED — a malformed date throws instead of inventing a
 *  timestamp, because backdated created_at feeds temporal-reasoning
 *  evaluation and a silent fallback would corrupt it. */
export function parseSessionDate(raw: string): string {
  const m = DATE_RE.exec(raw.trim());
  if (!m) {
    throw new Error(`unparseable session date "${raw}" — expected YYYY/MM/DD (Day) HH:MM`);
  }
  const [, y, mo, d, hh, mi] = m;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(hh), Number(mi));
  const dt = new Date(ms);
  // Reject out-of-range components that Date.UTC would silently roll over
  if (dt.getUTCFullYear() !== Number(y) || dt.getUTCMonth() !== Number(mo) - 1 || dt.getUTCDate() !== Number(d)) {
    throw new Error(`impossible calendar date "${raw}"`);
  }
  return dt.toISOString();
}

function isTurn(t: unknown): t is LmeTurn {
  return typeof t === 'object' && t !== null
    && typeof (t as LmeTurn).role === 'string'
    && typeof (t as LmeTurn).content === 'string';
}

function allStrings(arr: unknown[]): arr is string[] {
  return arr.every(x => typeof x === 'string');
}

/** Structural validation with precise errors — fail fast on format drift
 *  rather than producing silently-wrong metrics. Enforces (per review):
 *  string ids/dates, parseable dates, answer_session_ids ⊆ haystack ids,
 *  role ∈ {user, assistant}, strictly-boolean has_answer when present (null
 *  fails closed — the pinned dataset has none), unique question ids. A
 *  session id may repeat within a haystack ONLY with byte-identical turn
 *  content (real-data trait: identical filler at different dates); a
 *  duplicate id with conflicting content fails closed. */
export function validateDataset(data: unknown): LmeQuestion[] {
  if (!Array.isArray(data)) {
    throw new Error('dataset root must be an array of questions');
  }
  const seenQuestionIds = new Set<string>();

  data.forEach((q, i) => {
    const qq = q as LmeQuestion;
    const ctx = `question[${i}]${typeof qq.question_id === 'string' ? ` (${qq.question_id})` : ''}`;

    if (typeof qq.question_id !== 'string' || qq.question_id.length === 0) {
      throw new Error(`${ctx}: missing question_id`);
    }
    if (seenQuestionIds.has(qq.question_id)) {
      throw new Error(`${ctx}: duplicate question_id`);
    }
    seenQuestionIds.add(qq.question_id);

    if (typeof qq.question !== 'string') throw new Error(`${ctx}: missing question text`);
    if (typeof qq.question_type !== 'string') throw new Error(`${ctx}: missing question_type`);
    if (!Array.isArray(qq.haystack_sessions)) throw new Error(`${ctx}: missing haystack_sessions`);
    if (!Array.isArray(qq.haystack_session_ids) || !allStrings(qq.haystack_session_ids)) {
      throw new Error(`${ctx}: haystack_session_ids must be strings`);
    }
    if (qq.haystack_sessions.length !== qq.haystack_session_ids.length) {
      throw new Error(`${ctx}: sessions/ids length mismatch`);
    }
    if (!Array.isArray(qq.haystack_dates) || !allStrings(qq.haystack_dates)
      || qq.haystack_dates.length !== qq.haystack_sessions.length) {
      throw new Error(`${ctx}: haystack_dates length mismatch or non-string entries`);
    }
    qq.haystack_dates.forEach((d, di) => {
      try {
        parseSessionDate(d);
      } catch (err) {
        throw new Error(`${ctx}: haystack_dates[${di}]: ${(err as Error).message}`);
      }
    });

    const sessionIds = new Set<string>(qq.haystack_session_ids);

    if (!Array.isArray(qq.answer_session_ids) || !allStrings(qq.answer_session_ids)) {
      throw new Error(`${ctx}: answer_session_ids must be strings`);
    }
    qq.answer_session_ids.forEach(aid => {
      if (!sessionIds.has(aid)) {
        throw new Error(`${ctx}: answer_session_id "${aid}" not present in haystack`);
      }
    });

    qq.haystack_sessions.forEach((sess, si) => {
      if (!Array.isArray(sess) || !sess.every(isTurn)) {
        throw new Error(`${ctx}: session[${si}] has malformed turns`);
      }
      sess.forEach((turn, ti) => {
        if (!VALID_ROLES.has(turn.role)) {
          throw new Error(`${ctx}: session[${si}] turn[${ti}] has invalid role "${turn.role}"`);
        }
        // Pinned-dataset format: unlabeled turns OMIT has_answer; labeled
        // turns are strictly boolean. null does NOT occur (verified: zero
        // nulls in the manifest-pinned file) and fails closed.
        if (turn.has_answer !== undefined && typeof turn.has_answer !== 'boolean') {
          throw new Error(`${ctx}: session[${si}] turn[${ti}] has non-boolean has_answer`);
        }
      });
    });

    // Duplicate session ids within one haystack are REAL in the cleaned
    // dataset (13 cases across longmemeval_s, all non-answer filler whose
    // turn content is byte-identical but whose DATES differ — the same
    // conversation replayed at two timeline positions). Upstream keeps each
    // occurrence as a separate corpus entry, so identical duplicates are
    // accepted; a duplicate id with DIFFERENT content is corrupt data and
    // fails closed. Runs after per-turn validation so malformed sessions get
    // their precise error first.
    const firstIndexBySessionId = new Map<string, number>();
    qq.haystack_session_ids.forEach((sid, i) => {
      const first = firstIndexBySessionId.get(sid);
      if (first === undefined) {
        firstIndexBySessionId.set(sid, i);
        return;
      }
      const a = qq.haystack_sessions[first];
      const b = qq.haystack_sessions[i];
      const sameContent = a.length === b.length && a.every((turn, ti) =>
        turn.role === b[ti].role && turn.content === b[ti].content && turn.has_answer === b[ti].has_answer);
      if (!sameContent) {
        throw new Error(`${ctx}: duplicate session id "${sid}" with conflicting content (indices ${first}, ${i})`);
      }
    });
  });
  return data as LmeQuestion[];
}
