/** Current ISO 8601 timestamp */
export function now(): string {
  return new Date().toISOString();
}

/** Days elapsed since an ISO timestamp */
export function daysSince(isoDate: string): number {
  const then = new Date(isoDate).getTime();
  const diff = Date.now() - then;
  return Math.floor(diff / (1000 * 60 * 60 * 24));
}

/** Whether the ISO date is within the last N days */
export function isWithinDays(isoDate: string | null, days: number): boolean {
  if (!isoDate) return false;
  return daysSince(isoDate) <= days;
}
