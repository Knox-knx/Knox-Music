// LRCLIB lyrics provider tests: exact-first, search fallback, failure
// contract (404/429/5xx/malformed), local caching, enable flag.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LrclibProvider, fetchLyricsForSong, toLyricsResult } from '../../src/providers/lyrics/lrclib';
import { getDb } from '../../src/data/db';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const SYNCED = '[00:01.00] Hello\n[00:05.50] World\n';

beforeEach(async () => {
  await getDb().cache.clear().catch(() => undefined);
  await getDb().lyrics.clear().catch(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('toLyricsResult', () => {
  it('parses synced lyrics', () => {
    const r = toLyricsResult({ syncedLyrics: SYNCED, plainLyrics: 'Hello\nWorld' });
    expect(r?.synced).toBe(true);
    expect(r?.lines).toHaveLength(2);
    expect(r?.lines[0]).toEqual({ timeMs: 1000, text: 'Hello' });
  });

  it('falls back to plain lyrics without inventing timestamps', () => {
    const r = toLyricsResult({ plainLyrics: 'Hello\nWorld' });
    expect(r?.synced).toBe(false);
    expect(r?.lines).toHaveLength(2);
  });

  it('returns null for empty/malformed records', () => {
    expect(toLyricsResult(null)).toBeNull();
    expect(toLyricsResult({})).toBeNull();
    expect(toLyricsResult({ plainLyrics: '   ' })).toBeNull();
  });
});

describe('LrclibProvider.getLyrics', () => {
  it('resolves an exact match with synced lines', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      expect(String(url)).toContain('/api/get?');
      return jsonResponse({ trackName: 'Faded', artistName: 'Alan Walker', syncedLyrics: SYNCED, plainLyrics: 'x' });
    }));
    const r = await new LrclibProvider().getLyrics({ track: 'Faded', artist: 'Alan Walker', durationMs: 212000 });
    expect(r?.synced).toBe(true);
    expect(r?.lines).toHaveLength(2);
  });

  it('falls back to search when exact misses, preferring synced hits', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/get?')) return jsonResponse({ message: 'not found' }, 404);
      return jsonResponse([
        { trackName: 'Faded', artistName: 'Someone', plainLyrics: 'plain only' },
        { trackName: 'Faded', artistName: 'Alan Walker', syncedLyrics: SYNCED },
      ]);
    }));
    const r = await new LrclibProvider().getLyrics({ track: 'Faded', artist: 'Alan Walker' });
    expect(r?.synced).toBe(true);
    expect(r?.lines[0].text).toBe('Hello');
  });

  it('returns null when nothing matches (honest empty state)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      if (String(url).includes('/api/get?')) return jsonResponse({ message: 'nf' }, 404);
      return jsonResponse([]);
    }));
    expect(await new LrclibProvider().getLyrics({ track: 'Nope', artist: 'Nobody' })).toBeNull();
  });

  it('surfaces rate limiting instead of faking lyrics', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 429)));
    await expect(new LrclibProvider().getLyrics({ track: 'Faded', artist: 'Alan Walker' }))
      .rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('treats server errors as graceful misses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 500)));
    expect(await new LrclibProvider().getLyrics({ track: 'Faded', artist: 'Alan Walker' })).toBeNull();
  });

  it('caches results so repeat plays never hit the network', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ syncedLyrics: SYNCED }));
    vi.stubGlobal('fetch', fetchMock);
    const p = new LrclibProvider();
    const q = { track: 'Cached Song', artist: 'Cache Artist' };
    const first = await p.getLyrics(q);
    expect(first?.synced).toBe(true);
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);
    const second = await p.getLyrics(q);
    expect(second?.lines).toEqual(first?.lines);
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('rejects blank queries without fetching', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    expect(await new LrclibProvider().getLyrics({ track: ' ', artist: 'X' })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchLyricsForSong', () => {
  it('prefers the local .lrc sidecar over the network', async () => {
    await getDb().lyrics.put({
      songId: 'local:1', lines: [{ timeMs: 100, text: 'Local line' }], synced: true, source: 'test.lrc',
    });
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchLyricsForSong({
      id: 'local:1', providerId: 'local', providerTrackId: '1',
      title: 'T', artist: 'A', album: '', durationMs: 1000, addedAt: 0,
    });
    expect(r?.lines[0].text).toBe('Local line');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays silent when disabled (no network)', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal('fetch', fetchMock);
    const r = await fetchLyricsForSong({
      id: 'x:1', providerId: 'x', providerTrackId: '1',
      title: 'T', artist: 'A', album: '', durationMs: 1000, addedAt: 0,
    }, { enabled: false });
    expect(r).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
