// Smart Cache eviction — size caps + age retention (LRU).
//
// Never evicts the currently-playing entry (excludeId). Eviction is
// disposable by design: an evicted track simply becomes a cache MISS
// (fresh provider fetch) next play. Never touches `offline` downloads.

import { logger } from '../core/logger';
import { listCacheByRecency, removeCacheEntry } from './cacheStorage';

export interface EvictionPolicy {
  maxBytes: number;
  /** Entries older than this (by cachedAt) are expired. <=0 disables age expiry. */
  ttlDays: number;
  /** Stable song id currently playing — never evicted. */
  excludeId?: string | null;
}

export interface EvictionResult {
  evicted: number;
  freedBytes: number;
}

export async function enforceCacheLimits(policy: EvictionPolicy, now = Date.now()): Promise<EvictionResult> {
  const out: EvictionResult = { evicted: 0, freedBytes: 0 };
  try {
    const all = await listCacheByRecency();
    const ttlMs = policy.ttlDays > 0 ? policy.ttlDays * 86_400_000 : 0;
    // 1. Expire by age first (oldest first).
    for (const e of all) {
      if (ttlMs > 0 && now - e.cachedAt > ttlMs && e.id !== policy.excludeId) {
        await removeCacheEntry(e.id);
        out.evicted += 1;
        out.freedBytes += e.fileSize || 0;
      }
    }
    // 2. Enforce size cap by LRU (oldest first, never the playing entry).
    if (policy.maxBytes > 0) {
      const fresh = await listCacheByRecency();
      let total = fresh.reduce((n, e) => n + (e.fileSize || 0), 0);
      for (const e of fresh) {
        if (total <= policy.maxBytes) break;
        if (e.id === policy.excludeId) continue;
        await removeCacheEntry(e.id);
        total -= e.fileSize || 0;
        out.evicted += 1;
        out.freedBytes += e.fileSize || 0;
      }
    }
    if (out.evicted > 0) {
      logger.info('cache', `SMART_CACHE_EVICT evicted=${out.evicted} freed=${out.freedBytes}`);
    }
  } catch (e) {
    logger.warn('cache', 'eviction scan failed', String(e).slice(0, 160));
  }
  return out;
}
