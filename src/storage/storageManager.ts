import { getDb } from '../data/db';
import { offlineRepo } from '../data/repositories';
import { useSettings } from '../settings/settingsStore';
import { logger } from '../core/logger';

/** Platform-appropriate storage abstraction (web: IndexedDB/OPFS + navigator.storage). */
export const storageManager = {
  scopeDirs() {
    // Conceptual: database / artwork / lyrics / cache / offline / playlists / logs / backups
    // On web all live in IndexedDB; on Tauri/native these map to app-data dirs.
    return ['database', 'artwork', 'lyrics', 'cache', 'offline', 'playlists', 'logs', 'backups'];
  },

  async usage(): Promise<{ offline: number; cache: number; artwork: number; database: number; total: number }> {
    const offline = await offlineRepo.totalBytes().catch(() => 0);
    let cache = 0;
    let artwork = 0;
    try {
      const rows = await getDb().cache.toArray();
      cache = rows.reduce((n, r) => n + (r.value?.length ?? 0), 0);
      const art = await getDb().artwork.toArray();
      artwork = art.reduce((n, r) => n + (r.blob?.size ?? 0), 0);
    } catch { /* ignore */ }
    let database = 0;
    try {
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate();
        database = Math.max(0, (est.usage ?? 0) - offline - artwork);
      }
    } catch { /* ignore */ }
    return { offline, cache, artwork, database, total: offline + cache + artwork + database };
  },

  async canStore(bytes: number): Promise<{ ok: boolean; reason?: string }> {
    const { maxOfflineBytes } = useSettings.getState();
    if (maxOfflineBytes < 0) return { ok: true };
    const used = await offlineRepo.totalBytes().catch(() => 0);
    if (used + bytes > maxOfflineBytes) {
      return { ok: false, reason: 'Offline storage limit reached.' };
    }
    return { ok: true };
  },

  async clearCache(): Promise<number> {
    const db = getDb();
    const count = await db.cache.count().catch(() => 0);
    await db.cache.clear().catch(() => undefined);
    logger.info('storage', `cleared ${count} cache entries`);
    return count;
  },

  /** Auto-cleanup: expired cache + unplayed temp entries. NEVER touches explicit offline tracks or favorites unless configured. */
  async autoCleanup(favoriteIds: Set<string>): Promise<{ removedCache: number }> {
    const { autoCleanup, cacheTtlDays } = useSettings.getState();
    if (!autoCleanup) return { removedCache: 0 };
    const cutoff = Date.now() - cacheTtlDays * 86400000;
    let removed = 0;
    try {
      const expired = await getDb().cache.where('expiresAt').below(Date.now()).toArray();
      const stale = await getDb().cache.where('updatedAt').below(cutoff).toArray();
      const ids = new Set([...expired, ...stale].map((r) => r.key));
      // safety: never delete keys referencing favorites
      favoriteIds.forEach((id) => ids.delete(`song:${id}`));
      if (ids.size > 0) {
        await getDb().cache.bulkDelete([...ids]);
        removed = ids.size;
      }
    } catch { /* ignore */ }
    return { removedCache: removed };
  },

  async removeAllOffline(): Promise<void> {
    await getDb().offline.clear();
  },
};
