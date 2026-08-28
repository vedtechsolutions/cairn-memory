/** Current ISO 8601 timestamp (UTC — the stable form for storage and sync). */
export function now(): string {
  return new Date().toISOString();
}

/**
 * Format a stored UTC timestamp for HUMAN display. Storage stays UTC (stable
 * across timezones for sync); this only localizes what a person reads, so a
 * user in, say, UTC-5 doesn't see tomorrow's date in the evening. Opt-in via
 * the CAIRN_TZ env var (an IANA zone like "America/Jamaica"); when it is unset
 * the raw ISO string is returned unchanged.
 */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const tz = process.env.CAIRN_TZ;
  if (!tz) return iso;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  try {
    return new Intl.DateTimeFormat('sv-SE', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', timeZoneName: 'short',
    }).format(date);
  } catch {
    return iso; // invalid CAIRN_TZ — fall back to the stored UTC form
  }
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
