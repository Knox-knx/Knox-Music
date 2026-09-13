// Smart Cache auto-clear after playback.
//
// Policy (Settings → Playback → Smart Cache → Auto-clear after playback):
//   "immediate" — delete the entry right after its natural end (default).
//   "1h"/"6h"/"24h" — persist a cleanup deadline on the same smartcache row;
//     a startup/maintenance sweep deletes it once due (survives restart).
//   "never" — never delete because playback finished (TTL/LRU/corruption/
//     manual-clear rules still apply).
//
// Guarantees (verified before ANY deletion):
//   1. track mode only (never live radio: playerMode radio / isLive).
//   2. genuine natural HTMLAudioElement "ended" (element reports ended).
//   3. track identity still matches the engine's owned source.
//   4. existing AudioEngine generation/ownership still valid (owned.gen ==
//      latest, caller gen == latest) — stale A→B→A ended events ignored.
//   5. ONLY the smartcache row for that track is touched (offline/library/
//      playlists/favorites/lyrics/artwork never touched).
//
// Cleanup is best-effort: IndexedDB failures never break playback — they log
// a diagnostic warning only.

import { logger } from '../core/logger';
import { getDb } from '../data/db';
import { getAudioEngine } from '../audio/AudioEngine';
import { useSettings } from '../settings/settingsStore';
import {
  SMART_CACHE_AUTO_CLEAR_DEFAULT,
  SMART_CACHE_AUTO_CLEAR_VALUES,
  type SmartCacheAutoClear,
} from './cacheTypes';
import {
  clearCacheAutoClearAt,
  listDueAutoClearEntries,
  removeCacheEntry,
  setCacheAutoClearAt,
} from './cacheStorage';

export type { SmartCacheAutoClear };
export { SMART_CACHE_AUTO_CLEAR_DEFAULT, SMART_CACHE_AUTO_CLEAR_VALUES };

/** Canonical diagnostic tag for every auto-clear decision. */
export const SMART_CACHE_AUTO_CLEAR_LOG = 'KNOX_SMART_CACHE_AUTO_CLEAR';

/** Normalize any persisted/unknown value to a valid policy (default immediate). */
export function normalizeSmartCacheAutoClear(v: unknown): SmartCacheAutoClear {
  if (v === 'immediate' || v === '1h' || v === '6h' || v === '24h' || v === 'never') return v;
  return SMART_CACHE_AUTO_CLEAR_DEFAULT;
}

/** Current policy (existing installs without a value migrate to "immediate"). */
export function getSmartCacheAutoClear(): SmartCacheAutoClear {
  try {
    return normalizeSmartCacheAutoClear(
      (useSettings.getState() as { smartCacheAutoClear?: unknown }).smartCacheAutoClear,
    );
  } catch {
    return SMART_CACHE_AUTO_CLEAR_DEFAULT;
  }
}

/** Delay in ms for delayed policies; 0 = immediate; null = never. */
export function smartCacheAutoClearDelayMs(policy: SmartCacheAutoClear): number | null {
  switch (policy) {
    case 'immediate':
      return 0;
    case '1h':
      return 3_600_000;
    case '6h':
      return 6 * 3_600_000;
    case '24h':
      return 24 * 3_600_000;
    case 'never':
      return null;
  }
}

/** Safe id for logs: stable song id only, truncated, never paths/secrets. */
export function safeAutoClearTrackId(id: string): string {
  try {
    return String(id ?? 'unknown').slice(0, 80) || 'unknown';
  } catch {
    return 'unknown';
  }
}

function logAutoClear(message: string, data?: unknown): void {
  try {
    logger.info('cache', `${SMART_CACHE_AUTO_CLEAR_LOG} ${message}`, data as never);
  } catch {
    /* diagnostics never break playback */
  }
}

function logAutoClearWarn(message: string, data?: unknown): void {
  try {
    logger.warn('cache', `${SMART_CACHE_AUTO_CLEAR_LOG} ${message}`, data as never);
  } catch {
    /* diagnostics never break playback */
  }
}

export interface NaturalEndedVerification {
  trackId: string;
  /** Playback generation of the track that ended (existing engine generation). */
  generation: number;
  playerMode: string;
  isLive?: boolean;
}

/**
 * Verify a natural-ended event against the existing AudioEngine
 * generation/ownership before ANY deletion. Returns false for stale events.
 *
 * Checks (all must pass):
 *  - track mode (never radio/live)
 *  - finished track still equals the engine's owned track
 *  - owned generation is still the latest claimed generation
 *  - caller generation is still current (not superseded)
 *  - the element really reports natural completion (ended === true)
 */
export function verifyNaturalEndedForAutoClear(v: NaturalEndedVerification): boolean {
  try {
    if (v.playerMode === 'radio' || v.isLive === true) return false;
    if (!v.trackId) return false;
    const engine = getAudioEngine();
    const owned = engine.getOwnedSource();
    if (!owned) return false;
    if (owned.trackId !== v.trackId) return false;
    const latest = engine.getLatestGeneration();
    if (owned.generation !== latest) return false;
    if (!engine.isCurrentGeneration(v.generation)) return false;
    // Genuine natural completion: the element itself reports ended. A manual
    // skip (detach + new assign) or a stale event for an already-replaced
    // source leaves ended === false, so it is ignored here.
    const diag = engine.getDiagnostics();
    if (diag.ended !== true) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle a genuine natural playback end for one track. Best-effort; never
 * throws and never interrupts playback.
 *
 *  - "immediate": delete ONLY this track's smartcache row (after the caller
 *    already detached the element source, so playback cannot go silent).
 *  - "1h"/"6h"/"24h": persist autoClearAt = now + delay on the same row.
 *  - "never": no-op (normal TTL/LRU rules untouched).
 *  - radio/live: no-op.
 *  - stale events (track/generation mismatch, element not ended): no-op.
 */
export async function handleSmartCacheNaturalEnded(
  v: NaturalEndedVerification,
  opts: { now?: number } = {},
): Promise<{ action: 'deleted' | 'scheduled' | 'ignored'; policy: SmartCacheAutoClear }> {
  const policy = getSmartCacheAutoClear();
  const safe = safeAutoClearTrackId(v.trackId);
  if (policy === 'never') return { action: 'ignored', policy };
  if (!verifyNaturalEndedForAutoClear(v)) return { action: 'ignored', policy };
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  try {
    if (policy === 'immediate') {
      try {
        await getDb().smartcache.delete(v.trackId);
      } catch {
        // Fall back to the best-effort remover (also swallows errors).
        await removeCacheEntry(v.trackId);
        // If the row still exists, the delete genuinely failed.
        const still = await getDb().smartcache.get(v.trackId).catch(() => undefined);
        if (still) throw new Error('indexeddb delete failed');
      }
      logAutoClear(`track=${safe} policy=immediate reason=natural-ended result=deleted`);
      return { action: 'deleted', policy };
    }
    const delay = smartCacheAutoClearDelayMs(policy);
    if (delay === null) return { action: 'ignored', policy };
    const existing = await getDb().smartcache.get(v.trackId).catch(() => undefined);
    if (!existing) return { action: 'ignored', policy };
    await setCacheAutoClearAt(v.trackId, now + delay, policy);
    logAutoClear(`track=${safe} policy=${policy} action=scheduled`);
    // Opportunistically sweep other due rows (best-effort, never throws).
    await runSmartCacheAutoClearMaintenance({ now }).catch(() => undefined);
    return { action: 'scheduled', policy };
  } catch {
    logAutoClearWarn(`track=${safe} result=failed`);
    return { action: 'ignored', policy };
  }
}

/**
 * Cancel a pending delayed cleanup (track replayed before its deadline, or
 * fresh MISS commit superseded it). Best-effort; never throws.
 */
export async function cancelSmartCacheAutoClear(trackId: string): Promise<void> {
  try {
    await clearCacheAutoClearAt(trackId);
  } catch {
    /* best-effort */
  }
}

/**
 * Startup/cache-maintenance sweep: delete rows whose persistent autoClearAt
 * deadline has passed. Survives restart (deadlines live on the rows).
 * Never deletes the currently-playing entry (excludeId / owned track) and
 * never touches anything outside `smartcache`. Best-effort; never throws.
 */
export async function runSmartCacheAutoClearMaintenance(
  opts: { now?: number; excludeId?: string | null } = {},
): Promise<{ cleaned: number }> {
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  try {
    let exclude = opts.excludeId ?? null;
    if (exclude === null) {
      try {
        exclude = getAudioEngine().getOwnedSource()?.trackId ?? null;
      } catch {
        exclude = null;
      }
    }
    const due = await listDueAutoClearEntries(now);
    let cleaned = 0;
    for (const e of due) {
      if (exclude !== null && e.id === exclude) continue;
      try {
        await getDb().smartcache.delete(e.id);
        cleaned += 1;
        logAutoClear(`track=${safeAutoClearTrackId(e.id)} policy=${String((e as { autoClearPolicy?: unknown }).autoClearPolicy ?? 'delayed')} action=expired result=deleted`);
      } catch {
        logAutoClearWarn(`track=${safeAutoClearTrackId(e.id)} result=failed`);
      }
    }
    return { cleaned };
  } catch {
    return { cleaned: 0 };
  }
}
