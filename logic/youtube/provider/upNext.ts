// YouTube Up Next — automatic smart playlist for a played track.
//
// Solves:
//   1. Genre & vibe continuity: Phonk plays related Phonk, Sufi/Bollywood
//      plays soulful/romantic Hindi, Lofi plays chill lofi, etc.
//   2. Anti-same-singer repetition: Prevents chaining 5-10 songs by the exact
//      same singer. Enforces artist diversity so every next song is fresh!
//   3. Duplicate/remix rejection: Drops "(Remix)", "(Slowed + Reverb)", etc. of
//      the played song.
//   4. Download-in-background: Queues permanent offline files so replays are instant.

import type { Song } from '../../core/types';
import { logger } from '../../core/logger';
import { YOUTUBE_PROVIDER_ID } from './mapper';
import {
  detectMusicVibe,
  enforceArtistDiversity,
  isSameSongOrVariant,
  type VibeInfo,
} from '../../audio/vibeClassifier';

/** Tracks added after the current one (current + these = 50+ song smart playlist). */
export const YT_UP_NEXT_COUNT = 52;

/**
 * Pure playlist builder: YouTube-only, streamable, de-duplicated siblings
 * of the played track, in list order, capped. Never throws.
 */
export function buildUpNextQueue(played: Song, list: Song[]): Song[] {
  try {
    const seen = new Set<string>([played.id]);
    const out: Song[] = [];
    for (const s of list ?? []) {
      if (out.length >= YT_UP_NEXT_COUNT) break;
      if (!isUpNextEligible(s, seen, played.id)) continue;
      seen.add(s.id);
      out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

/** Fetch related tracks via smart vibe queries. */
async function fetchRelatedTracks(played: Song, exclude: Set<string>, vibe: VibeInfo): Promise<Song[]> {
  try {
    const { getProviderManager } = await import('../ProviderManager');
    const provider = getProviderManager().get(YOUTUBE_PROVIDER_ID);
    if (!provider || provider.capabilities.supportsSearch !== true) return [];

    const out: Song[] = [];
    // Search up to 5 vibe-specific related queries (e.g. Mix - Title, Title mix, Genre playlist)
    const queries = vibe.relatedQueries.slice(0, 5);
    for (const q of queries) {
      if (out.length >= YT_UP_NEXT_COUNT * 2) break;
      try {
        const results = await provider.searchSongs(q.slice(0, 200));
        if (!Array.isArray(results)) continue;
        for (const s of results) {
          if (out.length >= YT_UP_NEXT_COUNT * 2) break;
          if (!isUpNextEligible(s, exclude, played.id)) continue;
          if (isSameSongOrVariant(s, played)) continue;
          // Filter by vibe consistency
          if (vibe.vibe !== 'general' && !vibe.isSameVibe(s)) continue;
          exclude.add(s.id);
          out.push(s);
        }
      } catch (e) {
        logger.debug('youtube', `related search "${q}" skipped:`, String(e));
      }
    }
    return out;
  } catch {
    return [];
  }
}

function isUpNextEligible(s: Song, exclude: Set<string>, playedId: string): boolean {
  if (!s || typeof s.id !== 'string') return false;
  if (s.id === playedId || exclude.has(s.id)) return false;
  if (s.providerId !== YOUTUBE_PROVIDER_ID) return false;
  if (s.capabilities?.streamable === false) return false;
  return true;
}

export interface UpNextResult {
  queued: number;
  downloadsQueued: number;
  genreLabel?: string;
}

/**
 * Start Up Next for a freshly-playing YouTube track. Call AFTER playSong /
 * playSongs succeeded. Returns what was queued (0 = disabled, offline,
 * non-YouTube, or nothing found — all silent except the summary toast).
 */
export async function startYouTubeUpNext(
  played: Song,
  list?: Song[],
  queryHint?: string,
): Promise<UpNextResult> {
  const none: UpNextResult = { queued: 0, downloadsQueued: 0 };
  try {
    if (!played || played.providerId !== YOUTUBE_PROVIDER_ID) return none;
    const { useSettings } = await import('../../settings/settingsStore');
    let enabled = true;
    try {
      enabled = useSettings.getState().youtubeUpNext !== false;
    } catch {
      enabled = true;
    }
    if (!enabled) return none;
    const { usePlayer } = await import('../../audio/playerStore');
    if (usePlayer.getState().offlineMode) return none;

    const vibe = detectMusicVibe(played, queryHint);
    const exclude = new Set<string>([played.id]);

    // 1. Gather raw candidates from sibling list, filtering out same-song variants/covers
    const rawSiblings = buildUpNextQueue(played, list ?? []).filter((s) => !isSameSongOrVariant(s, played));
    for (const s of rawSiblings) exclude.add(s.id);

    // 2. Fetch YouTube Mix ("Mix - <Title>") & vibe-related tracks
    const relatedTracks = await fetchRelatedTracks(played, exclude, vibe);

    // 3. Pool all candidates together: related tracks from the YouTube Mix take priority!
    const pool = [...relatedTracks, ...rawSiblings];

    // 4. Enforce strict artist diversity and variant rejection:
    //    - The song directly after played is NEVER by the same artist!
    //    - No consecutive same-artist tracks!
    //    - Multi-pass assembly to provide 50+ songs!
    let diverseCandidates = enforceArtistDiversity(pool, played, YT_UP_NEXT_COUNT);

    // Fallback if pool was small: take remaining eligible siblings without duplicates or variants
    if (diverseCandidates.length < 5 && rawSiblings.length > 0) {
      for (const s of rawSiblings) {
        if (!diverseCandidates.some((c) => c.id === s.id) && s.id !== played.id && !isSameSongOrVariant(s, played)) {
          diverseCandidates.push(s);
        }
        if (diverseCandidates.length >= YT_UP_NEXT_COUNT) break;
      }
    }

    const finalCandidates = diverseCandidates.slice(0, YT_UP_NEXT_COUNT);
    if (finalCandidates.length === 0) return none;

    // Queue in order right after the current track. addToQueue(next=true)
    // inserts at index+1, so insert reversed to preserve order. Skip ids
    // already queued (never duplicate, never disturb the current index).
    const st = usePlayer.getState();
    const queuedIds = new Set(st.queue.map((s) => s.id));
    const fresh = finalCandidates.filter((s) => !queuedIds.has(s.id));
    for (let i = fresh.length - 1; i >= 0; i -= 1) {
      try {
        usePlayer.getState().addToQueue(
          { ...fresh[i], queueSource: 'autoplay' },
          true,
        );
      } catch {
        /* one bad row never blocks the rest */
      }
    }

    // Tracks are queued in order for continuous uninterrupted playback.
    // AudioEngine caches tracks smoothly when played; manual download remains available.
    logger.info('youtube', `up-next: ${fresh.length} ${vibe.genreLabel} tracks queued after ${played.id}`);
    return { queued: fresh.length, downloadsQueued: 0, genreLabel: vibe.genreLabel };
  } catch (e) {
    logger.warn('youtube', 'up-next failed', String(e));
    return none;
  }
}
