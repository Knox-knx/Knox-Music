// Smart Cache facade — persistent playback cache (reconstructed,
// CASE D: no original source was recoverable on this machine).
//
// Automatic, disposable playback optimization — NOT user offline storage.
// Enable/disable + size/retention come from Settings → Playback.
// "Clear Smart Cache" wipes ONLY the smartcache table.

import { logger } from '../core/logger';
import { useSettings } from '../settings/settingsStore';
import { SMART_CACHE_LOG } from './cacheTypes';
import {
  clearCacheEntries,
  countCacheEntries,
  totalCacheBytes,
} from './cacheStorage';

export {
  SMART_CACHE_AUTO_CLEAR_DEFAULT,
  SMART_CACHE_AUTO_CLEAR_VALUES,
  type SmartCacheAutoClear,
} from './cacheTypes';
export {
  SMART_CACHE_AUTO_CLEAR_LOG,
  cancelSmartCacheAutoClear,
  getSmartCacheAutoClear,
  handleSmartCacheNaturalEnded,
  normalizeSmartCacheAutoClear,
  runSmartCacheAutoClearMaintenance,
  safeAutoClearTrackId,
  smartCacheAutoClearDelayMs,
  verifyNaturalEndedForAutoClear,
  type NaturalEndedVerification,
} from './smartCacheAutoClear';

export function isSmartCacheEnabled(): boolean {
  try {
    return useSettings.getState().smartCacheEnabled !== false;
  } catch {
    return true;
  }
}

export function smartCacheLimits(): { maxBytes: number; ttlDays: number } {
  try {
    const s = useSettings.getState();
    return {
      maxBytes: s.maxSmartCacheBytes > 0 ? s.maxSmartCacheBytes : 512 * 1024 * 1024,
      ttlDays: s.smartCacheTtlDays > 0 ? s.smartCacheTtlDays : 30,
    };
  } catch {
    return { maxBytes: 512 * 1024 * 1024, ttlDays: 30 };
  }
}

/** Clear ONLY Smart Cache (library/favorites/playlists/downloads/lyrics/settings untouched). */
export async function clearSmartCache(): Promise<number> {
  const n = await clearCacheEntries();
  logger.info('cache', `smart cache cleared (${n} entries)`);
  return n;
}

export async function smartCacheStats(): Promise<{ entries: number; bytes: number }> {
  const [entries, bytes] = await Promise.all([countCacheEntries(), totalCacheBytes()]);
  return { entries, bytes };
}

export { SMART_CACHE_LOG };
