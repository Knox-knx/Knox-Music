// Web Discovery — short-lived query→candidates cache.
//
// TTL 2 min, bounded (max 100 queries). Stores metadata only — never audio,
// never authorization data, cookies, or protected info.

import type { WebCandidate } from './types';

interface Row {
  at: number;
  candidates: WebCandidate[];
}

const TTL_MS = 2 * 60_000;
const MAX_ROWS = 100;
const cache = new Map<string, Row>();

function keyFor(query: string): string {
  return query.trim().toLowerCase().slice(0, 200);
}

export function readWebDiscoveryCache(query: string, now = Date.now()): WebCandidate[] | null {
  const row = cache.get(keyFor(query));
  if (!row) return null;
  if (now - row.at > TTL_MS) {
    cache.delete(keyFor(query));
    return null;
  }
  return row.candidates;
}

export function writeWebDiscoveryCache(query: string, candidates: WebCandidate[]): void {
  if (cache.size >= MAX_ROWS) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at)[0]?.[0];
    if (oldest) cache.delete(oldest);
  }
  // Defensive copy without anything sensitive (candidates carry no creds).
  cache.set(keyFor(query), {
    at: Date.now(),
    candidates: candidates.map((c) => ({ ...c, canonicalUrl: c.canonicalUrl.slice(0, 2048) })),
  });
}

export function clearWebDiscoveryCache(): void {
  cache.clear();
}

export const WEB_DISCOVERY_CACHE_TTL_MS = TTL_MS;
