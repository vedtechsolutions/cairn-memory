/** T8a (§6): two active canonicals with equal canonical hash cannot
 *  exist in a valid ordered stream. The batch transaction rolls back —
 *  nothing applies — and the CALLER stops sync for the project and
 *  flags it for replay/snapshot rebootstrap (the halt flag is the
 *  owner-RPC slice's concern; core apply only detects and refuses). */
export class ProtocolInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolInvariantError';
  }
}

/** Inbound apply predicate failure (D2): unsupported versions, invalid
 *  shape, unknown kind, project mismatch, unknown event type in the
 *  closed vocabulary. The batch is refused whole. */
export class ApplyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplyValidationError';
  }
}
