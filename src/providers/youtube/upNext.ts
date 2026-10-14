// Real-Time Up Next — automatic real-time Mix / Radio playlist for YouTube,
// YouTube Music, Spotify, and JioSaavn tracks.
//
// Solves:
//   1. Real-time Mix / Station (YouTube RDAMVM/RD, JioSaavn reco.getreco,
//      Spotify Recommendations / Radio Mix): Automatically fetches the real-time
//      generated playlist for the played song and starts playing it seamlessly.
//   2. Clean Queue Replacement: Replaces the queue with ONLY the newly played song
//      and its newly generated playlist—never showing old previously played songs.
//   3. Genre & vibe continuity + Anti-same-singer repetition: Enforces artist diversity
//      and drops duplicate/remix variants of the played song.

import type { Song } from '../../core/types';
import { logger } from '../../core/logger';
import { YOUTUBE_PROVIDER_ID } from './mapper';
import {
  detectMusicVibe,
  enforceArtistDiversity,
  isCompilationOrJukebox,
  isNonMusicVideo,
  isSameSongOrVariant,
  type VibeInfo,
} from '../../audio/vibeClassifier';

/** Tracks added after the current one (current + these = 50+ song smart playlist). */
export const YT_UP_NEXT_COUNT = 50;

export const REALTIME_UPNEXT_PROVIDERS = [
  'youtube',
  'youtube-music',
  'spotify',
  'jiosaavn',
] as const;

export function isRealtimeUpNextProvider(providerId?: string): boolean {
  return Boolean(
    providerId &&
      (REALTIME_UPNEXT_PROVIDERS as readonly string[]).includes(providerId),
  );
}

let upNextGeneration = 0;
let activeUpNextController: AbortController | null = null;

/**
 * Pure playlist builder: provider-matched, streamable, de-duplicated siblings
 * of the played track, in list order, capped. Never throws.
 */
export function buildUpNextQueue(played: Song, list: Song[]): Song[] {
  try {
    const targetProvider = played?.providerId || YOUTUBE_PROVIDER_ID;
    const seen = new Set<string>([played.id]);
    const out: Song[] = [];
    for (const s of list ?? []) {
      if (out.length >= YT_UP_NEXT_COUNT) break;
      if (!isUpNextEligible(s, seen, played.id, targetProvider)) continue;
      seen.add(s.id);
      out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

function stripProviderPrefix(played: Song): string {
  if (played.providerTrackId) {
    return String(played.providerTrackId).replace(
      /^(youtube(-music)?|spotify|jiosaavn):(track:)?/,
      '',
    );
  }
  return String(played.id || '').replace(
    /^(youtube(-music)?|spotify|jiosaavn):(track:)?/,
    '',
  );
}

/**
 * Fetch the real-time generated Mix / Radio playlist directly from the active
 * provider (`youtube`, `jiosaavn`, `spotify`, `youtube-music`).
 */
async function fetchRealtimeMixTracks(
  played: Song,
  exclude: Set<string>,
  queryHint?: string,
  signal?: AbortSignal,
): Promise<Song[]> {
  try {
    const targetProviderId = played.providerId || YOUTUBE_PROVIDER_ID;
    const { getProviderManager } = await import('../ProviderManager');
    const pm = getProviderManager();
    const provider = pm.get(targetProviderId) as unknown as {
      getMixPlaylist?: (
        trackId: string,
        s?: AbortSignal,
        seed?: { title?: string; artist?: string; album?: string; queryHint?: string },
      ) => Promise<Song[]>;
    } | undefined;

    const trackId = stripProviderPrefix(played);
    let results: Song[] = [];

    if (provider && typeof provider.getMixPlaylist === 'function' && trackId) {
      results = await provider.getMixPlaylist(trackId, signal, {
        title: played.title,
        artist: played.artist,
        album: played.album,
        queryHint,
      });
    }

    if (!Array.isArray(results) || results.length === 0) return [];

    const out: Song[] = [];
    for (const s of results) {
      if (signal?.aborted) break;
      if (out.length >= YT_UP_NEXT_COUNT * 2) break;
      if (!isUpNextEligible(s, exclude, played.id, targetProviderId)) continue;
      if (isNonMusicVideo(s.title, s.artist)) continue;
      if (isCompilationOrJukebox(s.title)) continue;
      if (s.durationMs > 900000) continue;
      if (isSameSongOrVariant(s, played)) continue;
      exclude.add(s.id);
      out.push(s);
    }
    return out;
  } catch (e) {
    logger.debug('youtube', 'real-time mix fetch skipped:', String(e));
    return [];
  }
}

/** Fetch related tracks via smart vibe queries (fallback/supplement when Mix is small). */
async function fetchRelatedTracks(
  played: Song,
  exclude: Set<string>,
  vibe: VibeInfo,
  signal?: AbortSignal,
): Promise<Song[]> {
  try {
    const targetProviderId = played.providerId || YOUTUBE_PROVIDER_ID;
    const { getProviderManager } = await import('../ProviderManager');
    const provider = getProviderManager().get(targetProviderId);
    if (!provider || provider.capabilities.supportsSearch !== true) return [];

    const out: Song[] = [];
    // Search up to 4 vibe-specific related queries (e.g. Mix - Title, Title mix, Genre playlist)
    const queries = vibe.relatedQueries.slice(0, 4);
    for (const q of queries) {
      if (signal?.aborted) break;
      if (out.length >= YT_UP_NEXT_COUNT * 2) break;
      try {
        const results = await provider.searchSongs(q.slice(0, 200), signal);
        if (!Array.isArray(results)) continue;
        for (const s of results) {
          if (signal?.aborted) break;
          if (out.length >= YT_UP_NEXT_COUNT * 2) break;
          if (!isUpNextEligible(s, exclude, played.id, targetProviderId)) continue;
          if (isNonMusicVideo(s.title, s.artist)) continue;
          if (isCompilationOrJukebox(s.title)) continue;
          if (s.durationMs > 900000) continue;
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

function isUpNextEligible(
  s: Song,
  exclude: Set<string>,
  playedId: string,
  targetProviderId: string = YOUTUBE_PROVIDER_ID,
): boolean {
  if (!s || typeof s.id !== 'string') return false;
  if (s.id === playedId || exclude.has(s.id)) return false;
  if (s.providerId !== targetProviderId) return false;
  if (s.capabilities?.streamable === false) return false;
  return true;
}

export interface UpNextResult {
  queued: number;
  downloadsQueued: number;
  genreLabel?: string;
}

/**
 * Start real-time Up Next for a freshly-playing track from YouTube, YouTube Music,
 * Spotify, or JioSaavn. Call AFTER playSong / playSongs succeeded.
 * Replaces the queue with ONLY the currently playing song and its newly fetched
 * real-time station playlist so old played songs never remain.
 */
export async function startYouTubeUpNext(
  played: Song,
  list?: Song[],
  queryHint?: string,
): Promise<UpNextResult> {
  const none: UpNextResult = { queued: 0, downloadsQueued: 0 };
  try {
    if (!played || !isRealtimeUpNextProvider(played.providerId)) return none;
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

    // Cancel any previous Up Next generation so an older song's playlist never leaks in
    upNextGeneration += 1;
    const gen = upNextGeneration;
    if (activeUpNextController) {
      try {
        activeUpNextController.abort();
      } catch {
        /* ignore */
      }
    }
    const controller = new AbortController();
    activeUpNextController = controller;
    const { signal } = controller;

    // Immediately strip any old songs from the player queue so only the newly played song is present while loading
    const initialState = usePlayer.getState();
    if (initialState.current && initialState.current.id === played.id) {
      if (initialState.queue.length !== 1 || initialState.queue[0]?.id !== played.id || initialState.index !== 0) {
        usePlayer.setState({
          queue: [initialState.current],
          index: 0,
        });
      }
    }

    const vibe = detectMusicVibe(played, queryHint);
    const exclude = new Set<string>([played.id]);

    // 1. Fetch real-time generated Mix / Station playlist from the track's provider FIRST
    const realtimeMixTracks = await fetchRealtimeMixTracks(played, exclude, queryHint, signal);
    if (gen !== upNextGeneration || signal.aborted) return none;

    // 2. Gather eligible siblings from the current search list (if any), excluding variants
    const rawSiblings = buildUpNextQueue(played, list ?? []).filter((s) => {
      if (exclude.has(s.id)) return false;
      if (isNonMusicVideo(s.title, s.artist)) return false;
      if (isCompilationOrJukebox(s.title)) return false;
      if (isSameSongOrVariant(s, played)) return false;
      return true;
    });
    for (const s of rawSiblings) exclude.add(s.id);

    // 3. If the real-time Mix returned fewer than 20 tracks, supplement with smart vibe search
    let relatedTracks: Song[] = [];
    if (realtimeMixTracks.length < 20 && !signal.aborted) {
      relatedTracks = await fetchRelatedTracks(played, exclude, vibe, signal);
    }
    if (gen !== upNextGeneration || signal.aborted) return none;

    // 4. Pool candidates: Real-time Mix takes top priority, then related vibe tracks, then siblings
    const pool = [...realtimeMixTracks, ...relatedTracks, ...rawSiblings];

    // 5. Enforce artist diversity and variant rejection
    let diverseCandidates = enforceArtistDiversity(pool, played, YT_UP_NEXT_COUNT);

    // Fallback if pool was small: take remaining eligible tracks without duplicates or variants
    if (diverseCandidates.length < 5 && pool.length > 0) {
      for (const s of pool) {
        if (!diverseCandidates.some((c) => c.id === s.id) && s.id !== played.id && !isSameSongOrVariant(s, played)) {
          diverseCandidates.push(s);
        }
        if (diverseCandidates.length >= YT_UP_NEXT_COUNT) break;
      }
    }

    const finalCandidates = diverseCandidates.slice(0, YT_UP_NEXT_COUNT);
    if (finalCandidates.length === 0) return none;

    // Verify this song is still the active song before replacing the queue
    if (gen !== upNextGeneration || signal.aborted) return none;
    const st = usePlayer.getState();
    if (!st.current || st.current.id !== played.id) return none;

    const freshQueueItems: Song[] = finalCandidates.map((s) => ({
      ...s,
      queueSource: 'autoplay' as const,
    }));

    // Replace queue cleanly with ONLY [currentSong, ...newPlaylist] at index 0
    usePlayer.setState({
      queue: [st.current, ...freshQueueItems],
      index: 0,
    });

    logger.info(
      'youtube',
      `up-next (${played.providerId}): ${freshQueueItems.length} ${vibe.genreLabel} tracks queued (mix=${realtimeMixTracks.length}, related=${relatedTracks.length}) after ${played.id}`,
    );
    return { queued: freshQueueItems.length, downloadsQueued: 0, genreLabel: vibe.genreLabel };
  } catch (e) {
    logger.warn('youtube', 'up-next failed', String(e));
    return none;
  }
}

export const startRealtimeUpNext = startYouTubeUpNext;


