// Live Web Discovery — short-lived metadata cache.
//
// Caches canonical URL, metadata, provider id, timestamp, match info.
// TTL 15–60 min depending on data (default 30 min). Bounded (max 200).
// Never stores credentials, cookies, tokens, signed audio URLs.

import type { TrackReference } from './types';

interface DiscoveryCacheRow {
  ref: TrackReference;
  cachedAt: number;
  ttlMs: number;
}

const cache = new Map<string, DiscoveryCacheRow>();
const MAX_ROWS = 200;

export const DISCOVERY_CACHE_TTL_MS = 30 * 60_000;
export const DISCOVERY_CACHE_MIN_TTL_MS = 15 * 60_000;
export const DISCOVERY_CACHE_MAX_TTL_MS = 60 * 60_000;

function keyFor(canonicalUrl: string): string {
  return canonicalUrl.trim().slice(0, 1024);
}

export function readDiscoveryCache(canonicalUrl: string, now = Date.now()): TrackReference | null {
  const row = cache.get(keyFor(canonicalUrl));
  if (!row) return null;
  if (now - row.cachedAt > row.ttlMs) {
    cache.delete(keyFor(canonicalUrl));
    return null;
  }
  return row.ref;
}

export function writeDiscoveryCache(ref: TrackReference, ttlMs = DISCOVERY_CACHE_TTL_MS): void {
  const ttl = Math.min(DISCOVERY_CACHE_MAX_TTL_MS, Math.max(DISCOVERY_CACHE_MIN_TTL_MS, ttlMs));
  // Defensive: never cache anything that looks like credentials/signed URLs.
  const url = ref.canonicalUrl ?? '';
  if (/[?&](token|sig|signature|auth|key)=/i.test(url)) return;
  if (cache.size >= MAX_ROWS) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].cachedAt - b[1].cachedAt)[0]?.[0];
    if (oldest) cache.delete(oldest);
  }
  cache.set(keyFor(ref.canonicalUrl), {
    ref: { ...ref, originalDiscoveredUrl: ref.originalDiscoveredUrl?.slice(0, 2048) },
    cachedAt: Date.now(),
    ttlMs: ttl,
  });
}

export function clearDiscoveryCache(): void {
  cache.clear();
}

export function discoveryCacheSize(): number {
  return cache.size;
}
