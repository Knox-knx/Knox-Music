// lyricsApi — UI entry point for lyrics (local .lrc → LRCLIB → empty).
//
// Chain (unchanged): local .lrc → LRCLIB → provider lyrics → honest empty.
// Lyrics never interrupt playback; failures resolve to null.

import type { Song } from '../core/types';
import type { LyricsResult } from '../providers/lyrics/types';
import { fetchLyricsForSong, getLyricsProvider } from '../providers/lyrics/lrclib';
import { assertQuery } from './client';

export const lyricsApi = {
  /** Full resolution for one song. Never throws; null = no lyrics. */
  async get(song: Song, signal?: AbortSignal): Promise<LyricsResult | null> {
    if (!song || !song.title?.trim() || !song.artist?.trim()) return null;
    return fetchLyricsForSong(song, { signal });
  },

  /** LRCLIB text search (lyrics tab search box). */
  async search(query: string, signal?: AbortSignal): Promise<LyricsResult[]> {
    const q = assertQuery(query).slice(0, 160);
    try {
      return await getLyricsProvider().searchLyrics(q, signal);
    } catch {
      return [];
    }
  },
};
