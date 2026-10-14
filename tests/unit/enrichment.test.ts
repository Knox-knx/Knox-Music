// Progressive metadata enrichment: fast rows render first, details merge in.
import { describe, it, expect, vi } from 'vitest';
import {
  needsEnrichment,
  mergeEnrichedSongs,
  enrichSongs,
  createEnrichmentCache,
} from '../../src/search/enrichment';
import type { Song } from '../../src/core/types';

function song(over: Partial<Song> & { id: string }): Song {
  return {
    providerId: 'youtube-music',
    providerTrackId: 'dQw4w9WgXcQ',
    title: 'T',
    artist: 'A',
    album: '',
    durationMs: 0,
    addedAt: 0,
    ...over,
  } as Song;
}

const YT = (over: Partial<Song> = {}): Song =>
  song({ id: 'youtube-music:abc123', providerTrackId: 'abc123', ...over });

describe('needsEnrichment', () => {
  it('flags youtube-music rows with missing duration', () => {
    expect(needsEnrichment(YT())).toBe(true);
  });

  it('skips enriched rows (duration present)', () => {
    expect(needsEnrichment(YT({ durationMs: 194000 }))).toBe(false);
  });

  it('never gates on album/year (they may legitimately stay empty)', () => {
    expect(needsEnrichment(YT({ durationMs: 194000, album: '', year: undefined }))).toBe(false);
  });

  it('ignores other providers', () => {
    expect(needsEnrichment(song({ id: 'jamendo:1', providerId: 'jamendo', providerTrackId: '1' }))).toBe(false);
  });
});

describe('mergeEnrichedSongs', () => {
  it('merges details in place: order stable, no duplicates', () => {
    const current = [YT({ id: 'youtube-music:aaa111', title: 'A' }), YT({ id: 'youtube-music:bbb222', title: 'B' })];
    const enriched = [{ ...current[1], durationMs: 194000, album: '' }];
    const merged = mergeEnrichedSongs(current, enriched);
    expect(merged).toHaveLength(2);
    expect(merged[0].durationMs).toBe(0);
    expect(merged[1].durationMs).toBe(194000);
    expect(merged.map((s) => s.id)).toEqual(['youtube-music:aaa111', 'youtube-music:bbb222']);
  });

  it('keeps the original row when enrichment is empty', () => {
    const current = [YT()];
    expect(mergeEnrichedSongs(current, [])).toBe(current);
  });

  it('adopts artwork/year/title only when the detail is richer', () => {
    const current = YT({ title: 'Spectre', artist: 'Alan Walker', artworkUrl: 'https://x/small.jpg' });
    const [merged] = mergeEnrichedSongs([current], [
      { ...current, durationMs: 194000, title: 'Untitled', artist: 'Unknown artist', artworkUrl: 'https://x/big.jpg', year: 2017 },
    ]);
    expect(merged.title).toBe('Spectre');
    expect(merged.artist).toBe('Alan Walker');
    expect(merged.artworkUrl).toBe('https://x/big.jpg');
    expect(merged.year).toBe(2017);
    expect(merged.durationMs).toBe(194000);
  });
});

describe('enrichSongs', () => {
  it('fetches details once per track and caches across calls', async () => {
    const fetchDetail = vi.fn(async (s: Song) => ({ ...s, durationMs: 194000 }));
    const cache = createEnrichmentCache();
    const rows = [YT({ id: 'youtube-music:aaa111', providerTrackId: 'aaa111' })];
    const first = await enrichSongs(rows, { fetchDetail, cache });
    expect(first[0].durationMs).toBe(194000);
    expect(fetchDetail).toHaveBeenCalledTimes(1);
    // Second call with the same (stale) snapshot reuses the cache: no request.
    const second = await enrichSongs(rows, { fetchDetail, cache });
    expect(second[0].durationMs).toBe(194000);
    expect(fetchDetail).toHaveBeenCalledTimes(1);
  });

  it('does not enrich the same track twice within one batch', async () => {
    const dup = YT({ id: 'youtube-music:aaa111', providerTrackId: 'aaa111' });
    const fetchDetail = vi.fn(async (s: Song) => ({ ...s, durationMs: 1000 }));
    await enrichSongs([dup, { ...dup }], { fetchDetail, cache: createEnrichmentCache() });
    expect(fetchDetail).toHaveBeenCalledTimes(1);
  });

  it('fails gracefully: keeps the fast row, retries later', async () => {
    const fetchDetail = vi.fn(async () => null);
    const rows = [YT()];
    const merged = await enrichSongs(rows, { fetchDetail, cache: createEnrichmentCache() });
    expect(merged[0].durationMs).toBe(0);
  });

  it('treats rejections as misses, never throws', async () => {
    const fetchDetail = vi.fn(async () => {
      throw new Error('sidecar down');
    });
    const merged = await enrichSongs([YT()], { fetchDetail, cache: createEnrichmentCache() });
    expect(merged[0].durationMs).toBe(0);
  });

  it('honours cancellation (aborted batches resolve the original rows)', async () => {
    const fetchDetail = vi.fn(async (s: Song) => ({ ...s, durationMs: 5000 }));
    const controller = new AbortController();
    controller.abort();
    const rows = [YT()];
    expect(await enrichSongs(rows, { fetchDetail, cache: createEnrichmentCache(), signal: controller.signal })).toBe(rows);
    expect(fetchDetail).not.toHaveBeenCalled();
  });

  it('caps detail fan-out per batch', async () => {
    const fetchDetail = vi.fn(async (s: Song) => ({ ...s, durationMs: 1000 }));
    const rows = Array.from({ length: 20 }, (_, i) => YT({ id: `youtube-music:track${String(i).padStart(2, '0')}`, providerTrackId: `track${String(i).padStart(2, '0')}` }));
    await enrichSongs(rows, { fetchDetail, cache: createEnrichmentCache(), maxDetails: 5 });
    expect(fetchDetail).toHaveBeenCalledTimes(5);
  });
});
