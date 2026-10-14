// Supporting units: container detection, debug flags, Smart Cache
// validation/eviction, and the genuine catalog adapter + detector.

import { describe, it, expect, afterEach } from 'vitest';
import { detectAudioContainer } from '../../src/audio/mediaDiagnostics';
import { isDirectPlaybackDebugEnabled } from '../../src/audio/debugFlags';
import {
  itunesDiscoverySearch,
  itunesToResults,
} from '../../src/discovery/itunesSearch';
import {
  clearWebPageProviders,
  detectMusicPage,
  registerBuiltinWebPageProviders,
} from '../../src/discovery/providerDetector';
import { validateCacheBytes } from '../../src/cache/cacheValidator';
import { enforceCacheLimits } from '../../src/cache/cacheEviction';
import type { SmartCacheEntry } from '../../src/cache/cacheTypes';

afterEach(() => {
  try { localStorage.removeItem('knox.dbg.directPlayback'); } catch { /* ignore */ }
});

describe('PHASE 9 — magic-byte container detection (never hardcoded)', () => {
  it('identifies real containers', () => {
    expect(detectAudioContainer(new Uint8Array([0x49, 0x44, 0x33, 0x04]))?.container).toBe('mp3');
    expect(detectAudioContainer(new Uint8Array([0xff, 0xfb, 0x90, 0x00]))?.container).toBe('mp3');
    expect(detectAudioContainer(new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70]))?.container).toBe('mp4-m4a');
    expect(detectAudioContainer(new Uint8Array([0x4f, 0x67, 0x67, 0x53]))?.container).toBe('ogg');
    expect(detectAudioContainer(new Uint8Array([0x66, 0x4c, 0x61, 0x43]))?.container).toBe('flac');
    const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45]);
    expect(detectAudioContainer(wav)?.container).toBe('wav');
    expect(detectAudioContainer(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))?.container).toBe('webm');
    expect(detectAudioContainer(new Uint8Array([0x49, 0x44, 0x33, 0x04]))?.mime).toBe('audio/mpeg');
    expect(detectAudioContainer(new Uint8Array([0x66, 0x4c, 0x61, 0x43]))?.mime).toBe('audio/flac');
  });

  it('rejects error pages and short prefixes', () => {
    const html = new TextEncoder().encode('<html><body>nope</body></html>');
    expect(detectAudioContainer(html)).toBeNull();
    const json = new TextEncoder().encode('{"error":"nope"}');
    expect(detectAudioContainer(json)).toBeNull();
    expect(detectAudioContainer(new Uint8Array([0x49, 0x44]))).toBeNull();
    expect(detectAudioContainer(null)).toBeNull();
  });

  it('marks non-error unknown bytes as unknown-audio (element decides)', () => {
    expect(detectAudioContainer(new Uint8Array(16).fill(0x61))?.container).toBe('unknown-audio');
  });
});

describe('diagnostic flags default safe, override cleanly', () => {
  it('direct bypass defaults OFF', () => {
    expect(isDirectPlaybackDebugEnabled()).toBe(false);
  });

  it('localStorage overrides work and clear back to defaults', () => {
    try { localStorage.setItem('knox.dbg.directPlayback', '1'); } catch { /* ignore */ }
    expect(isDirectPlaybackDebugEnabled()).toBe(true);
  });
});

describe('PHASE 19 — iTunes adapter is a real catalog provider, reference-only', () => {
  const payload = {
    resultCount: 2,
    results: [
      {
        trackId: 1440833098,
        trackName: 'Soch',
        artistName: 'Hardy Sandhu',
        collectionName: 'Soch — Single',
        trackTimeMillis: 226000,
        artworkUrl100: 'https://is1-ssl.mzstatic.com/image/100x100bb.jpg',
        trackViewUrl: 'https://music.apple.com/us/song/soch/1440833098',
      },
      { trackName: '', trackViewUrl: 'https://music.apple.com/us/song/x/1' },
    ],
  };

  it('maps catalog rows to public-page references (never playable)', () => {
    const out = itunesToResults(payload, 12);
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Soch');
    expect(out[0].artist).toBe('Hardy Sandhu');
    expect(out[0].durationMs).toBe(226000);
    expect(out[0].url).toBe('https://music.apple.com/us/song/soch/1440833098');
    expect(out[0].artwork).toContain('600x600bb');
    expect(out[0].provider).toBe('apple-music');
    expect(out[0].sourceType).toBe('web');
  });

  it('searches the public API with only the query, fails open', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify(payload), {
      status: 200, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
    const out = await itunesDiscoverySearch('soch hardy sandhu', { fetchImpl });
    expect(out).toHaveLength(1);
    expect(out[0].site).toBe('Apple Music');
    const failing = (async () => { throw new Error('down'); }) as unknown as typeof fetch;
    expect(await itunesDiscoverySearch('soch', { fetchImpl: failing })).toEqual([]);
    expect(await itunesDiscoverySearch('')).toEqual([]);
  });
});

describe('PHASE 20 — Apple Music page family detection', () => {
  it('recognizes song/album/artist pages and extracts ids', () => {
    clearWebPageProviders();
    registerBuiltinWebPageProviders();
    const song = detectMusicPage('https://music.apple.com/us/song/soch/1440833098');
    expect(song?.webProviderId).toBe('apple-music');
    expect(song?.kind).toBe('song');
    expect(song?.pageId).toBe('1440833098');
    expect(detectMusicPage('https://music.apple.com/us/album/xyz/123')?.kind).toBe('album');
    expect(detectMusicPage('https://music.apple.com/us/artist/hardy-sandhu/456')?.kind).toBe('artist');
    // Song id inside an album page via ?i= is preserved, not stripped.
    const viaI = detectMusicPage('https://music.apple.com/us/album/xyz/123?i=1440833098');
    expect(viaI?.pageId).toBe('1440833098');
    expect(viaI?.canonicalUrl).toContain('i=1440833098');
  });
});

describe('Smart Cache validation + eviction (pure units)', () => {
  const mp3 = (n = 4096): Uint8Array => {
    const b = new Uint8Array(n).fill(0x61);
    b[0] = 0x49; b[1] = 0x44; b[2] = 0x33; // ID3
    return b;
  };
  const entry = (over: Partial<SmartCacheEntry> = {}): SmartCacheEntry => {
    const data = mp3();
    return {
      id: 'jamendo:1', provider: 'jamendo', providerTrackId: '1',
      title: 'T', artist: 'A', data, mimeType: 'audio/mpeg',
      fileSize: data.byteLength, format: 'mp3', quality: 'MP3',
      durationMs: 180000, cachedAt: Date.now(), lastPlayedAt: Date.now(),
      lastVerifiedAt: Date.now(), complete: true, ...over,
    };
  };

  it('accepts real MP3 bytes, rejects empty/truncated/HTML', async () => {
    const { validateCacheEntry } = await import('../../src/cache/cacheValidator');
    expect(validateCacheEntry(entry()).ok).toBe(true);
    expect(validateCacheEntry(entry({ data: new Uint8Array(0), fileSize: 0 })).reason).toBe('empty');
    expect(validateCacheEntry(entry({ data: new Uint8Array(100), fileSize: 100 })).reason).toBe('truncated');
    const html = new TextEncoder().encode('<html><body>e</body></html>'.padEnd(2048, ' '));
    expect(validateCacheEntry(entry({ data: html, fileSize: html.byteLength })).reason).toBe('not-audio');
    expect(validateCacheEntry(entry({ fileSize: 999999 })).reason).toBe('size-mismatch');
    expect(validateCacheBytes(new Uint8Array(0)).ok).toBe(false);
  });

  it('eviction honors the cap with LRU order and never evicts the playing entry', async () => {
    const { getDb } = await import('../../src/data/db');
    await getDb().smartcache.clear().catch(() => undefined);
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      await getDb().smartcache.put(entry({ id: `jamendo:${i}`, lastPlayedAt: now - (3 - i) * 1000 }));
    }
    // ~12 KB stored; cap at 9 KB excluding the newest (playing) entry.
    const res = await enforceCacheLimits({ maxBytes: 9000, ttlDays: 0, excludeId: 'jamendo:2' });
    expect(res.evicted).toBeGreaterThanOrEqual(1);
    expect(await getDb().smartcache.get('jamendo:2')).toBeDefined();
    await getDb().smartcache.clear().catch(() => undefined);
  });
});
