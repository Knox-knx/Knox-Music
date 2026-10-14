// LRCLIB lyrics provider (https://lrclib.net) — public API, no key.
//
// Strategy: exact `/api/get` (track + artist + album + duration) first,
// `/api/search` fallback second, preferring synced results. Results are
// cached locally (30d TTL) so repeat plays never hammer the service.
//
// Failure contract (lyrics must NEVER interrupt playback):
//   404       → null (no lyrics — honest empty state)
//   429       → ProviderError RATE_LIMIT (caller backs off; helper → null)
//   5xx/abort → ProviderError from fetchJson (helper → null)
//   malformed → null (never invent lyrics)
//
// Note: browsers forbid overriding the User-Agent header via fetch(), so the
// stock browser UA is sent. LRCLIB tolerates browser traffic; a descriptive
// app UA only applies to non-browser (Tauri/Electron-node) runtimes.

import { ProviderError } from '../../core/errors';
import { logger } from '../../core/logger';
import type { Song } from '../../core/types';
import { getDb } from '../../data/db';
import { parseLrc } from '../../library/lyrics';
import { fetchJson } from '../http';
import { providerEnv } from '../env';
import type { LyricsProvider, LyricsQuery, LyricsResult } from './types';

export const LRCLIB_SOURCE = 'LRCLIB (lrclib.net)';
const CACHE_TTL_MS = 30 * 24 * 3600 * 1000;

interface LrclibTrack {
  id?: number;
  trackName?: string;
  artistName?: string;
  albumName?: string;
  duration?: number; // seconds
  instrumental?: boolean;
  plainLyrics?: string;
  syncedLyrics?: string;
}

function cacheKey(q: LyricsQuery): string {
  const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase().slice(0, 160);
  return `lrclib:${norm(q.artist)}|${norm(q.track)}`;
}

/** Convert one LRCLIB record to lines. Null when it carries no usable text. */
export function toLyricsResult(t: LrclibTrack | null | undefined): LyricsResult | null {
  if (!t || typeof t !== 'object') return null;
  if (t.instrumental) return { lines: [], synced: false, source: LRCLIB_SOURCE };
  const synced = typeof t.syncedLyrics === 'string' ? parseLrc(t.syncedLyrics) : null;
  if (synced && synced.length > 0) {
    return { lines: synced, synced: true, source: LRCLIB_SOURCE };
  }
  if (typeof t.plainLyrics === 'string' && t.plainLyrics.trim()) {
    const lines = t.plainLyrics
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((text) => ({ timeMs: 0, text }));
    if (lines.length > 0) return { lines, synced: false, source: LRCLIB_SOURCE };
  }
  return null;
}

async function readCache(key: string): Promise<LyricsResult | null> {
  try {
    const row = await getDb().cache.get(`lyrics:${key}`);
    if (!row || row.expiresAt < Date.now()) return null;
    const parsed = JSON.parse(row.value) as LyricsResult;
    if (!parsed || !Array.isArray(parsed.lines)) return null;
    // Returned as-is (possibly empty = known lyric-less); the caller maps
    // empty to null so a negative cache hit never refetches.
    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(key: string, result: LyricsResult): Promise<void> {
  try {
    await getDb().cache.put({
      key: `lyrics:${key}`,
      value: JSON.stringify(result),
      expiresAt: Date.now() + CACHE_TTL_MS,
      updatedAt: Date.now(),
    });
  } catch {
    /* cache must never break lyrics */
  }
}

export class LrclibProvider implements LyricsProvider {
  readonly id = 'lrclib';
  readonly name = 'LRCLIB Lyrics';

  private base(): string {
    return providerEnv.lrclibBaseUrl;
  }

  async getLyrics(query: LyricsQuery, signal?: AbortSignal): Promise<LyricsResult | null> {
    const track = query.track.trim();
    const artist = query.artist.trim();
    if (!track || !artist) return null;
    const key = cacheKey(query);
    const cached = await readCache(key);
    // Cached empty result = known instrumental/lyric-less track: no refetch.
    if (cached) return cached.lines.length > 0 ? cached : null;

    // 1. Exact match (duration in whole seconds, when known).
    try {
      const params = new URLSearchParams({ artist_name: artist, track_name: track });
      if (query.album?.trim()) params.set('album_name', query.album.trim());
      if (query.durationMs && query.durationMs > 0) {
        params.set('duration', String(Math.round(query.durationMs / 1000)));
      }
      const exact = await fetchJson<LrclibTrack>(`${this.base()}/api/get?${params.toString()}`, {
        timeoutMs: providerEnv.requestTimeoutMs, retries: 1, signal,
      });
      const result = toLyricsResult(exact);
      if (result) {
        void writeCache(key, result);
        return result.lines.length > 0 ? result : null;
      }
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'RATE_LIMIT') throw e;
      if (e instanceof ProviderError && e.code !== 'NOT_FOUND') {
        logger.warn('lyrics', 'lrclib exact lookup failed, trying search', String(e));
      }
      // NOT_FOUND / network / malformed → fall through to search.
    }

    // 2. Search fallback — prefer a synced hit, else the first usable one.
    try {
      const found = await this.searchLyrics(`${track} ${artist}`.trim(), signal);
      const best = found[0] ?? null;
      if (best) void writeCache(key, best);
      return best;
    } catch (e) {
      if (e instanceof ProviderError && e.code === 'RATE_LIMIT') throw e;
      logger.warn('lyrics', 'lrclib search failed', String(e));
      return null;
    }
  }

  async searchLyrics(query: string, signal?: AbortSignal): Promise<LyricsResult[]> {
    const q = query.trim();
    if (!q) return [];
    let data: unknown;
    try {
      data = await fetchJson<unknown>(`${this.base()}/api/search?q=${encodeURIComponent(q)}`, {
        timeoutMs: providerEnv.requestTimeoutMs, retries: 1, signal,
      });
    } catch (e) {
      if (e instanceof ProviderError && (e.code === 'NOT_FOUND' || e.code === 'NETWORK' || e.code === 'TIMEOUT')) return [];
      throw e;
    }
    if (!Array.isArray(data)) return [];
    const results: LyricsResult[] = [];
    for (const item of data as LrclibTrack[]) {
      const r = toLyricsResult(item);
      if (r && r.lines.length > 0) results.push(r);
      if (results.length >= 5) break;
    }
    // Synced results first — never above an exact caller-side match, but the
    // most useful fallback surfaces first.
    results.sort((a, b) => Number(b.synced) - Number(a.synced));
    return results;
  }
}

let singleton: LrclibProvider | null = null;
export function getLyricsProvider(): LrclibProvider {
  if (!singleton) singleton = new LrclibProvider();
  return singleton;
}

/**
 * Full resolution for one song: local .lrc sidecar → cached/network LRCLIB
 * (when enabled) → null. Never throws; never touches audio.
 */
export async function fetchLyricsForSong(
  song: Song,
  opts: { enabled?: boolean; signal?: AbortSignal } = {},
): Promise<LyricsResult | null> {
  try {
    const local = await getDb().lyrics.get(song.id).catch(() => undefined);
    if (local && local.lines.length > 0) {
      return { lines: local.lines, synced: local.synced, source: local.source };
    }
  } catch {
    /* fall through to network */
  }
  let enabled = opts.enabled;
  if (enabled === undefined) {
    try {
      const { useSettings } = await import('../../settings/settingsStore');
      enabled = useSettings.getState().providersEnabled['lrclib'] !== false;
    } catch {
      enabled = true;
    }
  }
  if (!enabled) return null;
  try {
    return await getLyricsProvider().getLyrics(
      { track: song.title, artist: song.artist, album: song.album, durationMs: song.durationMs },
      opts.signal,
    );
  } catch {
    return null;
  }
}
