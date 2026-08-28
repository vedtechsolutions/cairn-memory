/**
 * CAS token kind codes (W4 v3.1 §4) — the single source for the
 * kind ↔ 3-letter-code bijection used by rendering, parsing, and
 * resolution. Keep the two maps exact mirrors.
 */
export const KIND_CODES: Readonly<Record<string, string>> = {
  pitfall: 'pit',
  decision: 'dec',
  correction: 'cor',
  fact: 'fac',
  user_profile: 'usr',
  reference: 'ref',
  pattern: 'pat',
  goal: 'gol',
} as const;

export const CODE_KINDS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(KIND_CODES).map(([kind, code]) => [code, kind])),
);
