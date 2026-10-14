// Autoplay recommendation engine.
//
// Uses the EXISTING provider/search infrastructure — no separate search
// system. Candidate collection (small limits, isolated providers):
//   - local library: songRepo.searchLocal (artist/title), favorites,
//     frequently-played tracks
//   - remote: ProviderManager.searchAll with 1–2 small queries
//     (same artist first, then genre/album), honoring the existing search
//     cache, provider timeout, and provider isolation.
//
// Provider capability rules (§7):
//   - discovery-only providers (supportsStreaming === false, e.g. YouTube
//     Music) are NEVER returned as playable recommendations. A
//     discovery-only hit is only used to discover metadata: the engine tries
//     to resolve an actually playable equivalent (same normalized
//     title+artist) through an authorized provider via findEquivalents.
//     When no playable equivalent exists, the hit is discarded.
//   - No fake stream URLs are ever generated, nothing discovery-only is
//     downloaded or cached.
//
// Never throws: every I/O step is guarded and degrades to fewer candidates.

import type { Song } from '../core/types';
import { getProviderManager } from '../providers/ProviderManager';
import { findEquivalents, dedupeSongs, equivalenceKey } from '../providers/merge';
import { isPreviewSong } from '../providers/capabilities';
import { logger } from '../core/logger';
import { rankCandidates } from './candidateScoring';
import type { RecommendationOptions, RecommendationResult } from './recommendationTypes';

/** Max provider searches per recommendation round (keeps load small). */
export const MAX_PROVIDER_SEARCHES = 2;
/** Max songs kept per provider search (small candidate limits). */
export const MAX_RESULTS_PER_SEARCH = 10;

function providerTrackKey(song: Song): string {
  return `${song.providerId}:${song.providerTrackId}`;
}

/**
 * True when this track may be queued for playback. Discovery-only sources
 * (streaming === false) and tracks explicitly flagged unstreamable are
 * rejected here — the caller may still try resolvePlayableEquivalent().
 */
export function isPlayableCandidate(song: Song): boolean {
  try {
    const pm = getProviderManager();
    const provider = pm.get(song.providerId);
    if (provider && provider.capabilities.supportsStreaming === false) return false;
    if (song.capabilities?.streamable === false && !song.streamUrl && !song.isLocalFile && !song.isOfflineAvailable) {
      return false;
    }
    return true;
  } catch {
    return song.capabilities?.streamable !== false;
  }
}

/**
 * Resolve a playable equivalent for a discovery-only hit: same normalized
 * title+artist from an authorized (streaming) provider. Returns null when
 * none exists — the caller must then discard the hit.
 */
export function resolvePlayableEquivalent(discoverySong: Song, pool: Song[]): Song | null {
  const equivalents = findEquivalents(discoverySong, pool).filter(isPlayableCandidate);
  // Prefer full tracks with artwork first (honest quality signal).
  equivalents.sort(
    (a, b) =>
      Number(isPreviewSong(a)) - Number(isPreviewSong(b)) ||
      Number(Boolean(b.artworkUrl)) - Number(Boolean(a.artworkUrl)),
  );
  return equivalents[0] ?? null;
}

/** Drop the current track, queued tracks, and recently played tracks. */
export function filterExcluded(
  candidates: Song[],
  current: Song,
  excludeIds: Set<string>,
): Song[] {
  const currentKey = equivalenceKey(current);
  return candidates.filter((c) => {
    if (c.id === current.id) return false;
    if (excludeIds.has(c.id)) return false;
    if (providerTrackKey(c) === providerTrackKey(current)) return false;
    // Same normalized title+artist as the current track is still "Faded"
    // even from another provider — never recommend it immediately.
    if (equivalenceKey(c) === currentKey) return false;
    return true;
  });
}

/** Collect local-library candidates (no network). Best-effort, never throws. */
async function collectLocalCandidates(current: Song): Promise<Song[]> {
  const out: Song[] = [];
  try {
    const { songRepo, favoriteRepo } = await import('../data/repositories');
    // Same-artist tracks from the local library.
    if (current.artist.trim()) {
      const sameArtist = await songRepo.searchLocal(current.artist, 10).catch(() => [] as Song[]);
      out.push(...sameArtist);
    }
    // Frequently played tracks (taste signal).
    const frequent = await songRepo.list(0, 20, 'played').catch(() => [] as Song[]);
    out.push(...frequent);
    // Favorites (taste signal — read-only here).
    const favIds = new Set(await favoriteRepo.listSongIds().catch(() => [] as string[]));
    if (favIds.size > 0) {
      const favSongs = await favoriteRepo.listSongs().catch(() => [] as Song[]);
      out.push(...favSongs.slice(0, 10));
    }
  } catch (e) {
    logger.debug('autoplay', `local candidates skipped (${String(e)})`);
  }
  return dedupeSongs(out.filter((s) => s && s.id && s.title && s.artist));
}

/** Collect remote candidates via the existing provider fan-out. Never throws. */
async function collectRemoteCandidates(current: Song): Promise<{ songs: Song[]; failures: string[] }> {
  const failures: string[] = [];
  const songs: Song[] = [];
  try {
    const pm = getProviderManager();
    const queries: string[] = [];
    if (current.artist.trim()) queries.push(current.artist.trim());
    // Second query adds breadth: genre preferred, album fallback.
    if (current.genre?.trim()) queries.push(current.genre.trim());
    else if (current.album.trim() && current.album.toLowerCase() !== 'unknown album') {
      queries.push(`${current.artist} ${current.album}`.trim());
    }
    for (const q of queries.slice(0, MAX_PROVIDER_SEARCHES)) {
      try {
        const { items, failures: f } = await pm.searchAll(q, 'songs');
        failures.push(...f);
        songs.push(...(items as Song[]).slice(0, MAX_RESULTS_PER_SEARCH));
      } catch (e) {
        logger.warn('autoplay', `provider search failed (${q})`, String(e));
      }
    }
  } catch (e) {
    logger.warn('autoplay', 'remote candidates skipped', String(e));
  }
  return { songs: dedupeSongs(songs.filter((s) => s && s.id && s.title && s.artist)), failures };
}

/**
 * Generate ranked autoplay recommendations for the current track.
 *
 * Excludes the current track, queued tracks, and recently played tracks;
 * rejects discovery-only hits unless a playable equivalent resolves;
 * ranks the rest (same artist → album → genre → related). Returns at most
 * `limit` candidates, best first. Never throws — worst case returns [].
 */
export async function getRecommendations(
  current: Song,
  opts: RecommendationOptions = {},
): Promise<RecommendationResult> {
  const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
  const excludeIds = opts.excludeIds ?? new Set<string>();
  const recentIds = opts.recentIds ?? new Set<string>();
  const favoriteIds = opts.favoriteIds ?? new Set<string>();
  const playCounts = opts.playCounts ?? new Map<string, number>();

  try {
    let pool: Song[];
    let failures: string[] = [];
    if (opts.candidatePool) {
      pool = [...opts.candidatePool];
    } else {
      const [local, remote] = await Promise.all([
        collectLocalCandidates(current),
        collectRemoteCandidates(current),
      ]);
      pool = dedupeSongs([...local, ...remote.songs]);
      failures = remote.failures;
      // One provider failing must not break autoplay — partial pool continues.
      void failures;
    }

    // Exclude current / queued / recent BEFORE capability filtering so a
    // discovery hit for the current track can never resolve to itself.
    const excluded = new Set<string>([...excludeIds, ...recentIds]);
    let candidates = filterExcluded(pool, current, excluded);

    // Provider capability gate: playable now, or resolve a playable
    // equivalent for discovery-only metadata hits, else discard.
    const playable: Song[] = [];
    const discoveryHits: Song[] = [];
    for (const c of candidates) {
      if (isPlayableCandidate(c)) playable.push(c);
      else discoveryHits.push(c);
    }
    for (const hit of discoveryHits.slice(0, 5)) {
      const equiv = resolvePlayableEquivalent(hit, playable);
      if (equiv && !playable.some((p) => p.id === equiv.id)) playable.push(equiv);
      else {
        logger.debug('autoplay', `discarded discovery-only hit (${hit.providerId}:${hit.providerTrackId})`);
      }
    }
    candidates = playable;

    // History ids also arrive inside excludeIds; recentIds get no extra
    // penalty beyond exclusion (they are simply never immediate repeats).
    const ranked = rankCandidates(candidates, current, (song) => ({
      isFavorite: favoriteIds.has(song.id),
      playCount: playCounts.get(song.id) ?? song.playCount ?? 0,
    }));

    return { candidates: ranked.slice(0, limit).map((r) => r.song), failures };
  } catch (e) {
    logger.warn('autoplay', 'recommendation round failed', String(e));
    return { candidates: [], failures: [] };
  }
}
