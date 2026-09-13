// KNOX Autoplay manager — orchestration between the player store and the
// recommendation engine.
//
// Responsibilities:
//   - autoplay on/off (reads the persisted settingsStore.autoplay)
//   - radio guard (playerMode === 'radio' never autoplays)
//   - recommendation history (small, in-memory — no immediate repeats)
//   - candidate prefetch cache (fast transition, no per-second searching)
//   - ended-event transition lock (exactly one transition per ended event)
//
// What it does NOT do:
//   - No AudioEngine, no <audio> element, no timers for ended detection.
//   - No stream-URL fabrication, no discovery-only playback, no temp-file
//     writes (the player store's existing playSong path owns temp I/O).
//   - No library/favorites writes (signals are read-only).

import type { Song } from '../core/types';
import { useSettings } from '../settings/settingsStore';
import { logger } from '../core/logger';
import { getRecommendations } from './recommendationEngine';

/** Max autoplay attempts per transition (A fails → B → C → stop). */
export const MAX_AUTOPLAY_ATTEMPTS = 3;
/** Recommendation history cap (duplicate prevention window). */
export const MAX_RECOMMENDATION_HISTORY = 30;
/** Prefetched candidate cache TTL — refreshed lazily, never polled. */
export const PREFETCH_CACHE_TTL_MS = 120_000;
/** How many ranked candidates to keep per round (1 plays + fallbacks). */
export const PREFETCH_CANDIDATE_LIMIT = 5;

// --- transition lock (§15): the ended event must trigger exactly one
// transition even with duplicate events / remounts / rerenders. ---
let transitionInProgress = false;

/** Acquire the ended-transition lock. False = a transition is already running. */
export function tryAcquireTransition(): boolean {
  if (transitionInProgress) {
    logger.debug('autoplay', 'ended event ignored (transition already running)');
    return false;
  }
  transitionInProgress = true;
  return true;
}

/** Release the ended-transition lock (always called after next() settles). */
export function releaseTransition(): void {
  transitionInProgress = false;
}

/** For tests: read the lock without mutating it. */
export function isTransitionInProgress(): boolean {
  return transitionInProgress;
}

// --- recommendation history (§6): provider-aware ids, small window. ---

const recommendationHistory: string[] = [];

function historyKey(song: Song): string {
  return song.id;
}

/** Record a successfully started autoplay track (never failed candidates). */
export function recordRecommendation(song: Song): void {
  recommendationHistory.push(historyKey(song));
  while (recommendationHistory.length > MAX_RECOMMENDATION_HISTORY) {
    recommendationHistory.shift();
  }
}

/** Ids recommended recently (excluded from new rounds). */
export function recentRecommendationIds(): string[] {
  return [...recommendationHistory];
}

/** True when this song was recommended recently. */
export function wasRecentlyRecommended(song: Song): boolean {
  return recommendationHistory.includes(historyKey(song));
}

// --- candidate prefetch cache (§9/§20): fetch once per track, reuse. ---

interface PrefetchEntry {
  at: number;
  forTrackId: string;
  candidates: Song[];
}

let prefetch: PrefetchEntry | null = null;
let prefetchForTrackId: string | null = null;

function readPrefetch(trackId: string): Song[] | null {
  if (!prefetch || prefetch.forTrackId !== trackId) return null;
  if (Date.now() - prefetch.at > PREFETCH_CACHE_TTL_MS) {
    prefetch = null;
    return null;
  }
  return prefetch.candidates;
}

/** True when autoplay may run at all (setting ON, track mode, not offline-blocked). */
export function isAutoplayEnabled(): boolean {
  try {
    return useSettings.getState().autoplay === true;
  } catch {
    return true; // settings not loaded yet (boot) — default ON per spec
  }
}

/** Radio never autoplays: no recommendation, no fake ended event, no cache. */
export function shouldAutoplayForMode(playerMode: 'track' | 'radio'): boolean {
  return playerMode === 'track';
}

/** Build the exclusion set: queue ids + current + recent history + past recommendations. */
export function buildExclusionIds(
  queue: Song[],
  opts: { current?: Song | null; recentIds?: string[] } = {},
): Set<string> {
  const ids = new Set<string>();
  for (const q of queue) ids.add(q.id);
  if (opts.current) ids.add(opts.current.id);
  for (const id of opts.recentIds ?? []) ids.add(id);
  for (const id of recommendationHistory) ids.add(id);
  return ids;
}

/** Recently played song ids (small window — best-effort, never throws). */
export async function getRecentPlayedIds(limit = 30): Promise<string[]> {
  try {
    const { historyRepo } = await import('../data/repositories');
    const recent = await historyRepo.recent(limit).catch(() => []);
    return recent.map((h) => h.songId);
  } catch {
    return [];
  }
}

/** Favorite song ids + play counts (recommendation signals, read-only). */
export async function getLibrarySignals(): Promise<{ favoriteIds: Set<string>; playCounts: Map<string, number> }> {
  const favoriteIds = new Set<string>();
  const playCounts = new Map<string, number>();
  try {
    const { favoriteRepo, songRepo } = await import('../data/repositories');
    const favIds = await favoriteRepo.listSongIds().catch(() => [] as string[]);
    for (const id of favIds) favoriteIds.add(id);
    const frequent = await songRepo.list(0, 50, 'played').catch(() => [] as Song[]);
    for (const s of frequent) {
      if (typeof s.playCount === 'number' && s.playCount > 0) playCounts.set(s.id, s.playCount);
    }
  } catch {
    /* signals are optional — autoplay continues without them */
  }
  return { favoriteIds, playCounts };
}

/**
 * Ranked autoplay candidates for the current track (best first, up to
 * PREFETCH_CANDIDATE_LIMIT + fallbacks). Honors the exclusion set and the
 * recommendation history. Never throws — worst case returns [].
 */
export async function getNextCandidates(
  current: Song,
  queue: Song[],
  opts: { recentIds?: string[] } = {},
): Promise<Song[]> {
  try {
    const recentIds = opts.recentIds ?? (await getRecentPlayedIds());
    const { favoriteIds, playCounts } = await getLibrarySignals();
    const excludeIds = buildExclusionIds(queue, { recentIds });
    // The current track is excluded inside the engine too (belt-and-braces:
    // equivalence-key match across providers), but exclude it here as well.
    excludeIds.add(current.id);
    const { candidates } = await getRecommendations(current, {
      limit: PREFETCH_CANDIDATE_LIMIT,
      excludeIds,
      recentIds: new Set(recentIds),
      favoriteIds,
      playCounts,
    });
    // Drop anything recommended very recently (history races the DB read).
    const fresh = candidates.filter((c) => !wasRecentlyRecommended(c));
    const result = (fresh.length > 0 ? fresh : candidates).slice(0, PREFETCH_CANDIDATE_LIMIT);
    if (result.length > 0) {
      prefetch = { at: Date.now(), forTrackId: current.id, candidates: result };
    }
    return result;
  } catch (e) {
    logger.warn('autoplay', 'getNextCandidates failed', String(e));
    return [];
  }
}

/**
 * Gapless-like preparation (§9): while the current song is close to
 * completion, resolve the next candidates ONCE so the ended transition only
 * plays (fresh provider URL → Temporary Playback Buffer via the existing
 * playSong path). Fire-and-forget BY CONTRACT — callers must `void` it. Never
 * throws, never touches the audio engine, throttled per track so it can be
 * called from position updates without cost.
 */
export function prefetchFor(current: Song, queue: Song[]): void {
  try {
    if (prefetchForTrackId === current.id) return; // already prefetched
    const cached = readPrefetch(current.id);
    if (cached && cached.length > 0) {
      prefetchForTrackId = current.id;
      return;
    }
    prefetchForTrackId = current.id;
    void getNextCandidates(current, queue)
      .then((candidates) => {
        if (candidates.length > 0) {
          prefetch = { at: Date.now(), forTrackId: current.id, candidates };
          logger.debug('autoplay', `prefetched ${candidates.length} candidate(s) for ${current.id}`);
        }
      })
      .catch(() => undefined);
  } catch {
    /* prefetch never breaks playback */
  }
}

/** Prefetched candidates for this track (null on miss/expiry). */
export function consumePrefetch(trackId: string): Song[] | null {
  return readPrefetch(trackId);
}

/** Clear the prefetch marker when the track changes (lets the next track prefetch). */
export function resetPrefetchFor(trackId: string | null): void {
  if (prefetchForTrackId !== trackId) prefetchForTrackId = trackId;
}

/** For tests: reset all in-memory autoplay state. */
export function resetAutoplayState(): void {
  transitionInProgress = false;
  recommendationHistory.length = 0;
  prefetch = null;
  prefetchForTrackId = null;
}
