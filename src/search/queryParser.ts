// Title + artist query detection.
//
// Users type "Mi Gente", "Mi Gente J Balvin", "J Balvin Mi Gente",
// "Tum Hi Ho Arijit Singh" or "Arijit Singh Tum Hi Ho". We must NOT blindly
// assume every word is the title. Instead we produce candidate
// title/artist splits; confidence is calculated later against the returned
// metadata (see relevance.ts). Nothing here fabricates metadata.

import { normalizeKeyPart } from './normalizeQuery';

export interface ParsedQuery {
  originalQuery: string;
  normalizedQuery: string;
  /** Whole-query fallback (used for title/artist contains matching). */
  full: string;
  /** Candidate (title, artist) splits, strongest hypothesis first. */
  hypotheses: { title: string; artist: string }[];
  /** Quoted phrases extracted verbatim (folded for matching, original preserved separately). */
  quoted: string[];
  /** Explicit field hints via `artist:`, `title:`, `album:`, `genre:` prefixes (folded). */
  artistHint?: string;
  titleHint?: string;
  albumHint?: string;
  genreHint?: string;
  /** Folded tokens for overlap scoring (quoted phrases kept whole + split). */
  tokens: string[];
}

/** Explicit separators: "title - artist", "title by artist", "title | artist". */
function splitExplicit(q: string): { title: string; artist: string } | null {
  const by = q.split(/\s+by\s+/i);
  if (by.length === 2 && by[0].trim() && by[1].trim()) {
    return { title: by[0].trim(), artist: by[1].trim() };
  }
  for (const sep of [' - ', ' – ', ' — ', ' | ', ' / ']) {
    const i = q.indexOf(sep);
    if (i > 0 && i + sep.length < q.length) {
      const a = q.slice(0, i).trim();
      const b = q.slice(i + sep.length).trim();
      if (a && b) return { title: a, artist: b };
    }
  }
  return null;
}

/** Extract quoted phrases ("a b", 'a b', “a b”, «a b»). Unicode-safe. */
function extractQuoted(original: string): { quoted: string[]; stripped: string } {
  const quoted: string[] = [];
  // Match straight + curly + guillemet quotes; content preserved verbatim.
  const re = /["“”«»]([^"“”«»]+)["“”«»]|['‘’‚‛]([^'‘’‚‛]+)['‘’‚‛]/g;
  let m: RegExpExecArray | null;
  let stripped = original;
  while ((m = re.exec(original)) !== null) {
    const inner = (m[1] ?? m[2] ?? '').trim();
    if (inner) quoted.push(inner);
  }
  if (quoted.length > 0) {
    stripped = original.replace(re, ' ').replace(/\s+/g, ' ').trim();
  }
  return { quoted, stripped };
}

/** Explicit `field:value` hints (artist:/title:/album:/genre:). Case-insensitive. */
function extractFieldHints(q: string): {
  artistHint?: string;
  titleHint?: string;
  albumHint?: string;
  genreHint?: string;
  stripped: string;
} {
  let stripped = ` ${q} `;
  const hints: { artistHint?: string; titleHint?: string; albumHint?: string; genreHint?: string } = {};
  const fields: (keyof typeof hints)[] = ['artistHint', 'titleHint', 'albumHint', 'genreHint'];
  const names: Record<string, keyof typeof hints> = {
    artist: 'artistHint',
    title: 'titleHint',
    album: 'albumHint',
    genre: 'genreHint',
  };
  for (const [prefix, key] of Object.entries(names)) {
    const re = new RegExp(`\\s${prefix}\\s*:\\s*("[^"]+"|'[^']+'|\\S+)`, 'i');
    const m = re.exec(stripped);
    if (m?.[1]) {
      const raw = m[1].replace(/^["']|["']$/g, '').trim();
      const folded = normalizeKeyPart(raw);
      if (folded) (hints as Record<string, string>)[key] = folded;
      stripped = stripped.replace(m[0], ' ');
    }
  }
  void fields;
  return { ...hints, stripped: stripped.replace(/\s+/g, ' ').trim() };
}

/**
 * Parse a raw query into match hypotheses. All parts are kept in folded
 * form; the original is preserved on `originalQuery` for external searches.
 * Unicode is never destroyed — normalization is comparison-only.
 */
export function parseQuery(query: string): ParsedQuery {
  const originalQuery = query;
  // Collapse whitespace for parsing but keep original intact for display/external.
  const trimmed = (query ?? '').replace(/\s+/g, ' ').trim();
  const { quoted, stripped: unquoted } = extractQuoted(trimmed);
  const { artistHint, titleHint, albumHint, genreHint, stripped } = extractFieldHints(unquoted);
  const full = normalizeKeyPart(stripped || trimmed);
  const hypotheses: { title: string; artist: string }[] = [];

  // Quoted phrases are the strongest signals: each quoted phrase is both a
  // title and an artist hypothesis. Two quoted phrases → title+artist pair.
  const foldedQuoted = quoted.map((q) => normalizeKeyPart(q)).filter(Boolean);
  if (foldedQuoted.length === 2) {
    hypotheses.push({ title: foldedQuoted[0], artist: foldedQuoted[1] });
    hypotheses.push({ title: foldedQuoted[1], artist: foldedQuoted[0] });
  }
  for (const q of foldedQuoted) {
    hypotheses.push({ title: q, artist: '' });
    hypotheses.push({ title: '', artist: q });
  }

  // Explicit field hints outrank everything else.
  if (titleHint || artistHint) {
    hypotheses.push({ title: titleHint ?? '', artist: artistHint ?? '' });
    if (titleHint && artistHint) hypotheses.push({ title: artistHint, artist: titleHint });
  }

  const explicit = splitExplicit(stripped.trim() || trimmed);
  if (explicit) {
    const t = normalizeKeyPart(explicit.title);
    const a = normalizeKeyPart(explicit.artist);
    if (t && a) {
      hypotheses.push({ title: t, artist: a });
      hypotheses.push({ title: a, artist: t }); // "artist - title" order
    }
  }

  const words = full.split(' ').filter(Boolean);
  // Whole query as title (single-concept searches: "Mi Gente", "Kesariya").
  if (full) hypotheses.push({ title: full, artist: '' });
  // Whole query as artist (e.g. "Arijit Singh", "Shreya Ghoshal").
  if (full) hypotheses.push({ title: '', artist: full });
  // Progressive splits for "title artist" / "artist title" in either order.
  // "tum hi ho arijit singh" → ("tum hi ho","arijit singh") and reverse.
  if (words.length >= 3) {
    for (let i = 1; i < words.length; i++) {
      const left = words.slice(0, i).join(' ');
      const right = words.slice(i).join(' ');
      hypotheses.push({ title: left, artist: right });
      hypotheses.push({ title: right, artist: left });
    }
  } else if (words.length === 2) {
    hypotheses.push({ title: words[0], artist: words[1] });
    hypotheses.push({ title: words[1], artist: words[0] });
  }

  // Dedupe identical hypotheses, keep order (strongest first).
  const seen = new Set<string>();
  const unique = hypotheses.filter((h) => {
    const k = `${h.title}|${h.artist}`;
    if (seen.has(k) || (!h.title && !h.artist)) return false;
    seen.add(k);
    return true;
  });

  const tokens = full.split(' ').filter(Boolean);
  return {
    originalQuery,
    normalizedQuery: full,
    full,
    hypotheses: unique,
    quoted: foldedQuoted,
    artistHint,
    titleHint,
    albumHint,
    genreHint,
    tokens,
  };
}
