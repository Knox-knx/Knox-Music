// Smart Cache storage — persistent audio bytes in IndexedDB (Dexie).
//
// Table `smartcache` (schema v4, keyed by stable song id) is STRICTLY
// separate from `offline` (user-owned permanent downloads). Only complete,
// validated entries are ever committed (atomic single put).

import { getDb } from '../data/db';
import { logger } from '../core/logger';
import type { SmartCacheEntry } from './cacheTypes';

/**
 * Coerce stored audio bytes back to Uint8Array. Real IndexedDB preserves
 * TypedArrays via structured clone, but defensive normalization keeps a
 * HIT readable on any storage backend (a previous revision proved that a
 * plain-object payload otherwise fails validation and wrongly invalidates
 * a perfectly good entry).
 */
function normalizeCachedBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    try {
      return Uint8Array.from(data as number[]);
    } catch {
      return null;
    }
  }
  if (data && typeof data === 'object') {
    const keys = Object.keys(data);
    if (keys.length === 0 || keys.length > 100 * 1024 * 1024) return null;
    const out = new Uint8Array(keys.length);
    for (let i = 0; i < keys.length; i++) {
      if (String(i) !== keys[i]) return null;
      const v = (data as Record<string, unknown>)[keys[i]];
      if (typeof v !== 'number' || v < 0 || v > 255) return null;
      out[i] = v;
    }
    return out;
  }
  return null;
}

export async function getCacheEntry(id: string): Promise<SmartCacheEntry | undefined> {
  try {
    const entry = await getDb().smartcache.get(id);
    if (!entry) return undefined;
    const normalized = normalizeCachedBytes(entry.data as unknown);
    if (normalized) entry.data = normalized;
    // Un-normalizable payloads are left as-is: validation rejects them and
    // the caller auto-invalidates the row.
    return entry;
  } catch {
    return undefined;
  }
}

export async function putCacheEntry(entry: SmartCacheEntry): Promise<void> {
  if (!entry || entry.complete !== true || !entry.data || entry.data.byteLength === 0) {
    throw new Error('Smart Cache refuses incomplete entries');
  }
  await getDb().smartcache.put(entry);
}

export async function removeCacheEntry(id: string): Promise<void> {
  try {
    await getDb().smartcache.delete(id);
  } catch {
    /* removal is best-effort */
  }
}

/** Clear ONLY the Smart Cache table — library/favorites/playlists/downloads/lyrics untouched. */
export async function clearCacheEntries(): Promise<number> {
  try {
    const n = await getDb().smartcache.count();
    if (n > 0) await getDb().smartcache.clear();
    return n;
  } catch (e) {
    logger.warn('cache', 'smart cache clear failed', String(e).slice(0, 160));
    return 0;
  }
}

export async function countCacheEntries(): Promise<number> {
  try {
    return await getDb().smartcache.count();
  } catch {
    return 0;
  }
}

export async function totalCacheBytes(): Promise<number> {
  try {
    const all = await getDb().smartcache.toArray();
    return all.reduce((n, r) => n + (r.fileSize || 0), 0);
  } catch {
    return 0;
  }
}

/** All entries oldest-played-first (LRU order) for eviction scans. */
export async function listCacheByRecency(): Promise<SmartCacheEntry[]> {
  try {
    return await getDb().smartcache.orderBy('lastPlayedAt').toArray();
  } catch {
    return [];
  }
}

export async function touchCacheEntry(id: string, now = Date.now()): Promise<void> {
  try {
    await getDb().smartcache.update(id, { lastPlayedAt: now, lastVerifiedAt: now });
  } catch {
    /* touch is best-effort */
  }
}

/**
 * Record a persistent delayed auto-clear deadline on an existing Smart Cache
 * row (no second DB — same `smartcache` table). Best-effort; never throws.
 * Overwrites any previous deadline (each natural end reschedules).
 */
export async function setCacheAutoClearAt(
  id: string,
  autoClearAt: number,
  autoClearPolicy: string,
): Promise<void> {
  try {
    await getDb().smartcache.update(id, {
      autoClearAt,
      autoClearPolicy: autoClearPolicy as never,
    });
  } catch {
    /* scheduling is best-effort */
  }
}

/**
 * Cancel a pending delayed auto-clear (e.g. track replayed before its
 * deadline). Best-effort; never throws. Leaves all other fields untouched.
 */
export async function clearCacheAutoClearAt(id: string): Promise<void> {
  try {
    await getDb().smartcache.update(id, { autoClearAt: null, autoClearPolicy: null });
  } catch {
    /* cancel is best-effort */
  }
}

/** All rows whose persistent auto-clear deadline has passed (oldest first). */
export async function listDueAutoClearEntries(now = Date.now()): Promise<SmartCacheEntry[]> {
  try {
    const all = await getDb().smartcache.toArray();
    return all
      .filter((e) => typeof e.autoClearAt === 'number' && (e.autoClearAt as number) <= now)
      .sort((a, b) => (a.autoClearAt as number) - (b.autoClearAt as number));
  } catch {
    return [];
  }
}
