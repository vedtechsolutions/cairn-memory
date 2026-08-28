/**
 * Shared FTS5 query builder — used by MemoryRepository and ReminderRepository.
 * Strips special characters, optionally filters stopwords, and formats as OR-joined quoted terms.
 */

/** Common words that produce noisy FTS matches — filter before querying */
const FTS_STOPWORDS = new Set([
  'the', 'and', 'for', 'not', 'with', 'that', 'this', 'from',
  'are', 'was', 'were', 'been', 'have', 'has', 'had', 'does',
  'did', 'will', 'would', 'could', 'should', 'can', 'may',
  'how', 'what', 'why', 'where', 'when', 'which', 'who',
  'any', 'all', 'some', 'there', 'their', 'they', 'them',
  'you', 'your', 'use', 'using', 'also', 'but', 'other',
  'its', 'into', 'than', 'then', 'just', 'only', 'very',
  'about', 'more', 'most', 'over', 'such', 'each', 'make',
  'like', 'need', 'want', 'work', 'know', 'take', 'come',
  'get', 'let', 'now', 'new', 'way', 'our', 'out',
]);

export interface FtsQueryOptions {
  /** Whether to filter common stopwords (default: true) */
  filterStopwords?: boolean;
  /** Maximum number of terms to include (default: 8) */
  maxTerms?: number;
}

/**
 * Build an FTS5 query string from arbitrary text.
 * Returns null if no meaningful terms remain after filtering.
 */
export function buildFtsQuery(text: string, options: FtsQueryOptions = {}): string | null {
  const filterStopwords = options.filterStopwords ?? true;
  const maxTerms = options.maxTerms ?? 8;

  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && (!filterStopwords || !FTS_STOPWORDS.has(w)))
    .slice(0, maxTerms);

  if (words.length === 0) return null;
  // Use OR for broad recall — relevance scoring handles precision
  return words.map(w => `"${w}"`).join(' OR ');
}
