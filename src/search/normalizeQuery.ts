// Query normalization for multilingual search (Hindi, Punjabi, Tamil, Telugu,
// Bengali, Marathi, Malayalam, Kannada, English, Hinglish, transliterated).
//
// Two outputs are always kept:
// - originalQuery: the raw user input, shown in the UI, never destroyed.
// - normalizedQuery: a folded form used ONLY for matching/ranking.
//
// Normalization folds case, strips diacritics/accents, normalizes apostrophes,
// hyphens and punctuation to spaces, and collapses whitespace — but it never
// removes non-Latin scripts, so Hindi/Punjabi/Tamil/Telugu queries survive.

export interface NormalizedQuery {
  originalQuery: string;
  normalizedQuery: string;
}

/** Lowercase + diacritic-strip a single string without destroying Unicode. */
export function normalizeKeyPart(s: string | undefined): string {
  return (s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    // Smart quotes / apostrophes → plain apostrophe, then to space below.
    .replace(/[’‘‚‛`´]/g, "'")
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining diacritics (é→e, ñ→n)
    .replace(/[^a-z0-9\u0900-\u097f\u0980-\u09ff\u0a00-\u0a7f\u0a80-\u0aff\u0b00-\u0b7f\u0b80-\u0bff\u0c00-\u0c7f\u0c80-\u0cff\u0d00-\u0d7f ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Full query normalization: preserves the original, folds a match form. */
export function normalizeQuery(query: string): NormalizedQuery {
  const originalQuery = query;
  const normalizedQuery = normalizeKeyPart(query);
  return { originalQuery, normalizedQuery };
}

/** Case-insensitive exact-equality on the folded forms. */
export function foldedEquals(a: string, b: string): boolean {
  if (!a || !b) return false;
  return normalizeKeyPart(a) === normalizeKeyPart(b);
}
