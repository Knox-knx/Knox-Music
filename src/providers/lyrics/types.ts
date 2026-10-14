// Dedicated lyrics provider abstraction — lyrics are NOT a music provider.
// A LyricsProvider only resolves text/synced lines for a track; it never
// streams audio and never affects playback.

import type { Song } from '../../core/types';

export interface LyricsQuery {
  track: string;
  artist: string;
  album?: string;
  /** Full-track length in ms (used for exact matching, not displayed). */
  durationMs?: number;
}

export interface LyricsResult {
  lines: { timeMs: number; text: string }[];
  synced: boolean;
  source: string;
}

export interface LyricsProvider {
  readonly id: string;
  readonly name: string;
  /** Exact match first, provider-internal fallback second. Null = no lyrics (never throws for 404). */
  getLyrics(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult | null>;
  /** Loose text search for lyrics (used for manual lookup / fallback). */
  searchLyrics(query: string, signal?: AbortSignal): Promise<LyricsResult[]>;
}

export function queryFromSong(song: Song): LyricsQuery {
  return {
    track: song.title,
    artist: song.artist,
    album: song.album || undefined,
    durationMs: song.durationMs || undefined,
  };
}
