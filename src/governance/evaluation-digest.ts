import { createHash } from 'node:crypto';

export interface GateWorktreeDigest {
  gateId: string;
  digest: string;
}

/** One binding/fingerprint coordinate over all gate-scoped current digests. */
export function evaluationWorktreeDigest(entries: readonly GateWorktreeDigest[]): string {
  const canonical = JSON.stringify([...entries]
    .sort((left, right) => left.gateId < right.gateId ? -1 : left.gateId > right.gateId ? 1 : 0)
    .map(entry => [entry.gateId, entry.digest]));
  return createHash('sha256').update(canonical).digest('hex');
}
