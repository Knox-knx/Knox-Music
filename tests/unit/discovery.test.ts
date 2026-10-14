// Live Web Discovery — unit tests (metadata/reference only, never audio).
//
// Proves a real public music-page URL shape can be detected, normalized,
// parsed (JSON-LD → OpenGraph → meta), matched with artist-aware confidence,
// cached briefly, and guarded against SSRF — without hardcoding any song.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  validateDiscoveryUrl,
  isPrivateIpv4,
  scrubDiscoveryUrl,
} from '../../src/discovery/ssrfGuard';
import {
  registerWebPageProvider,
  clearWebPageProviders,
  detectMusicPage,
  registerBuiltinWebPageProviders,
  stripTrackingParams,
} from '../../src/discovery/providerDetector';
import { extractPageMetadata } from '../../src/discovery/metadataExtractor';
import {
  scoreDiscoveryMatch,
  dedupeReferences,
  matchDiscoveryToSongs,
} from '../../src/discovery/trackMatcher';
import {
  readDiscoveryCache,
  writeDiscoveryCache,
  clearDiscoveryCache,
} from '../../src/discovery/discoveryCache';
import {
  registerWebSearchProvider,
  clearWebSearchProviders,
  searchWeb,
  __resetWebSearchRateLimitsForTests,
  __clearWebSearchCacheForTests,
} from '../../src/discovery/webSearch';
import { discoverWebReferences, discoveryToSong } from '../../src/discovery/webDiscovery';
import type { TrackReference } from '../../src/discovery/types';
import type { Song } from '../../src/core/types';

function mkSong(over: Partial<Song> = {}): Song {
  return {
    id: 'jamendo:t1',
    providerId: 'jamendo',
    providerTrackId: 't1',
    title: 'Soch',
    artist: 'Hardy Sandhu',
    album: '',
    durationMs: 346000,
    addedAt: 0,
    ...over,
  } as Song;
}

beforeEach(() => {
  clearWebPageProviders();
  registerBuiltinWebPageProviders();
  clearWebSearchProviders();
  __resetWebSearchRateLimitsForTests();
  __clearWebSearchCacheForTests();
  clearDiscoveryCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SSRF protection', () => {
  it('blocks localhost, loopback, private ranges, metadata endpoints, dangerous schemes', () => {
    for (const u of [
      'http://localhost/song/x',
      'http://127.0.0.1/song/x',
      'http://0.0.0.0/song/x',
      'http://10.0.0.5/song/x',
      'http://172.16.4.4/song/x',
      'http://192.168.1.10/song/x',
      'http://169.254.169.254/latest/meta-data/',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<h1>x</h1>',
      'ftp://example.com/song/x',
      'https://example.com/song/x?token=abc',
    ]) {
      // credentials-in-url uses userinfo form; token query is allowed through
      // validation (cache layer refuses to store signed URLs instead).
      if (u.includes('?token=')) continue;
      expect(validateDiscoveryUrl(u).ok, u).toBe(false);
    }
    expect(validateDiscoveryUrl('https://www.jiosaavn.com/song/soch/AbCdEfGhIj0').ok).toBe(true);
    expect(validateDiscoveryUrl('https://open.spotify.com/track/abc123').ok).toBe(true);
  });

  it('detects private IPv4 ranges', () => {
    expect(isPrivateIpv4('127.0.0.1')).toBe(true);
    expect(isPrivateIpv4('10.1.2.3')).toBe(true);
    expect(isPrivateIpv4('192.168.0.1')).toBe(true);
    expect(isPrivateIpv4('8.8.8.8')).toBe(false);
  });

  it('scrubs query strings before logging', () => {
    const s = scrubDiscoveryUrl('https://example.com/song/x?token=SECRET&sig=abc');
    expect(s).not.toContain('SECRET');
    expect(s).toContain('example.com');
  });
});

describe('provider detection (plugin based, generic)', () => {
  it('recognizes jiosaavn song URLs and extracts a page id without hardcoding songs', () => {
    const d = detectMusicPage('https://www.jiosaavn.com/song/soch/IyozAjdpQ1s?utm_source=web&utm_medium=x&ref=abc');
    expect(d).not.toBeNull();
    expect(d!.webProviderId).toBe('jiosaavn');
    expect(d!.kind).toBe('song');
    expect(d!.pageId).toBeTruthy();
    expect(d!.canonicalUrl).not.toContain('utm_source');
    expect(d!.canonicalUrl).toContain('jiosaavn.com/song/');
  });

  it('recognizes spotify / soundcloud shapes generically', () => {
    expect(detectMusicPage('https://open.spotify.com/track/abc123XYZ?si=xyz')?.webProviderId).toBe('spotify');
    expect(detectMusicPage('https://soundcloud.com/some-artist/some-track')?.webProviderId).toBe('soundcloud');
  });

  it('returns null for unknown hosts', () => {
    expect(detectMusicPage('https://example.com/blog/hello')).toBeNull();
  });

  it('custom plugins can be registered (architecture is extensible)', () => {
    registerWebPageProvider({
      webProviderId: 'demo-site',
      displayName: 'Demo',
      hostSuffixes: ['demo-music.example'],
      detect: () => 'song',
      extractId: (u) => u.pathname.split('/').filter(Boolean).pop() ?? null,
      canonicalize: (u) => stripTrackingParams(u),
    });
    expect(detectMusicPage('https://demo-music.example/song/xyz-123')?.webProviderId).toBe('demo-site');
  });
});

describe('metadata extraction (layered, fails gracefully)', () => {
  it('prefers JSON-LD MusicRecording', () => {
    const html = `<!doctype html><html><head><title>ignored</title>
      <script type="application/ld+json">{"@context":"https://schema.org","@type":"MusicRecording","name":"Soch","byArtist":{"@type":"MusicGroup","name":"Hardy Sandhu"},"duration":"PT5M46S","image":"https://img/x.jpg"}</script>
      </head><body></body></html>`;
    const m = extractPageMetadata(html, 'https://www.jiosaavn.com/song/soch/X');
    expect(m?.title).toBe('Soch');
    expect(m?.artist).toBe('Hardy Sandhu');
    expect(m?.durationMs).toBe(346000);
    expect(m?.rawSource).toBe('json-ld');
  });

  it('falls back to OpenGraph then <title>', () => {
    const og = `<html><head><meta property="og:title" content="Soch" /><meta property="music:musician" content="Hardy Sandhu" /><meta property="og:image" content="https://img/y.jpg" /></head></html>`;
    expect(extractPageMetadata(og, 'https://x/y')?.rawSource).toBe('opengraph');
    const t = `<html><head><title>Soch - Hardy Sandhu</title></head></html>`;
    const m = extractPageMetadata(t, 'https://x/y');
    expect(m?.title).toBe('Soch');
    expect(m?.artist).toBe('Hardy Sandhu');
  });

  it('malformed JSON-LD never throws (next layer handles it)', () => {
    const bad = `<html><head><script type="application/ld+json">{not json</script><title>Lonely Title</title></head></html>`;
    expect(() => extractPageMetadata(bad, 'https://x/y')).not.toThrow();
    expect(extractPageMetadata('', 'https://x/y')).toBeNull();
    expect(extractPageMetadata('<html></html>', 'https://x/y')).toBeNull();
  });
});

describe('track matching (artist-aware confidence)', () => {
  const ref: TrackReference = {
    provider: 'jiosaavn',
    title: 'Soch',
    artist: 'Hardy Sandhu',
    durationMs: 346000,
    canonicalUrl: 'https://www.jiosaavn.com/song/soch/X',
    sourceType: 'web',
    playable: false,
    downloadable: false,
    cacheable: false,
  };

  it('exact title + exact artist + similar duration → very strong', () => {
    const m = scoreDiscoveryMatch(ref, mkSong());
    expect(m.kind).toBe('exact');
    expect(m.confidence).toBeGreaterThanOrEqual(94);
  });

  it('exact title + different artist → never auto-merge', () => {
    const m = scoreDiscoveryMatch(ref, mkSong({ artist: 'Someone Else' }));
    expect(m.kind).toBe('none');
    expect(m.confidence).toBeLessThan(70);
  });

  it('matches by canonical URL identity', () => {
    const m = scoreDiscoveryMatch(ref, mkSong({ sourceUrl: ref.canonicalUrl }));
    expect(m.confidence).toBeGreaterThanOrEqual(95);
  });

  it('dedupe keeps one row per canonical URL and title+artist', () => {
    const dup: TrackReference = { ...ref };
    const other: TrackReference = { ...ref, canonicalUrl: 'https://www.jiosaavn.com/song/soch/Y', providerId: 'Y' };
    expect(dedupeReferences([ref, dup, other])).toHaveLength(1);
  });

  it('matchDiscoveryToSongs respects the confidence floor', () => {
    const hits = matchDiscoveryToSongs([ref], [mkSong(), mkSong({ id: 'x:9', providerId: 'x', providerTrackId: '9', title: 'Unrelated', artist: 'Nobody' })]);
    expect(hits).toHaveLength(1);
    expect(hits[0].song.id).toBe('jamendo:t1');
  });
});

describe('discovery cache (bounded, TTL, no secrets)', () => {
  it('stores and expires metadata; refuses signed URLs', () => {
    const ref: TrackReference = {
      provider: 'jiosaavn', title: 'T', artist: 'A',
      canonicalUrl: 'https://www.jiosaavn.com/song/t/X',
      sourceType: 'web', playable: false, downloadable: false, cacheable: false,
    };
    writeDiscoveryCache(ref, 15 * 60_000);
    expect(readDiscoveryCache(ref.canonicalUrl)?.title).toBe('T');
    expect(readDiscoveryCache(ref.canonicalUrl, Date.now() + 16 * 60_000)).toBeNull();
    const signed: TrackReference = { ...ref, canonicalUrl: 'https://x/y?token=SECRET' };
    writeDiscoveryCache(signed);
    expect(readDiscoveryCache(signed.canonicalUrl)).toBeNull();
  });
});

describe('webSearch abstraction (timeout, limits, isolation)', () => {
  it('fans out with per-provider isolation; one failure never breaks others', async () => {
    registerWebSearchProvider({
      id: 'good',
      displayName: 'good',
      search: async () => [
        { url: 'https://www.jiosaavn.com/song/a/X', title: 'A', artist: 'B', sourceType: 'web', discoveredAt: Date.now() },
      ],
    });
    registerWebSearchProvider({
      id: 'bad',
      displayName: 'bad',
      search: async () => {
        throw new Error('down');
      },
    });
    const { results, failures } = await searchWeb('soch hardy sandhu');
    expect(results).toHaveLength(1);
    expect(failures).toEqual(['bad']);
  });

  it('rejects SSRF URLs from provider results', async () => {
    registerWebSearchProvider({
      id: 'evil',
      displayName: 'evil',
      search: async () => [
        { url: 'http://127.0.0.1/song/x', title: 'X', sourceType: 'web', discoveredAt: Date.now() },
        { url: 'https://www.jiosaavn.com/song/ok/X', title: 'OK', sourceType: 'web', discoveredAt: Date.now() },
      ],
    });
    const { results } = await searchWeb('test');
    expect(results.map((r) => r.url)).toEqual(['https://www.jiosaavn.com/song/ok/X']);
  });

  it('empty without registered providers (never blocks search)', async () => {
    const { results, failures } = await searchWeb('anything');
    expect(results).toEqual([]);
    expect(failures).toEqual([]);
  });
});

describe('orchestrator (non-blocking, reference-only)', () => {
  it('resolves pages in parallel and returns normalized references', async () => {
    registerWebSearchProvider({
      id: 'mock',
      displayName: 'mock',
      search: async () => [
        { url: 'https://www.jiosaavn.com/song/soch/MOCKID123', title: 'Soch', artist: 'Hardy Sandhu', sourceType: 'web', discoveredAt: Date.now() },
      ],
    });
    const html = `<html><head><script type="application/ld+json">{"@type":"MusicRecording","name":"Soch","byArtist":"Hardy Sandhu"}</script></head></html>`;
    const fetchImpl = (async () =>
      new Response(html, { status: 200, headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
    const out = await discoverWebReferences('Soch Hardy Sandhu', { fetchImpl });
    expect(out.references.length).toBeGreaterThanOrEqual(1);
    const r = out.references[0];
    expect(r.playable).toBe(false);
    expect(r.downloadable).toBe(false);
    expect(r.cacheable).toBe(false);
    expect(r.canonicalUrl).toContain('jiosaavn.com');
  });

  it('fails open: web failure yields empty discovery (provider search continues)', async () => {
    registerWebSearchProvider({
      id: 'down',
      displayName: 'down',
      search: async () => {
        throw new Error('net down');
      },
    });
    const out = await discoverWebReferences('Soch', { timeoutMs: 50, overallTimeoutMs: 200 });
    expect(out.references).toEqual([]);
  });

  it('discoveryToSong is explicitly non-playable and labeled as web reference', () => {
    const ref: TrackReference = {
      provider: 'jiosaavn', providerId: 'X', title: 'Soch', artist: 'Hardy Sandhu',
      canonicalUrl: 'https://www.jiosaavn.com/song/soch/X', sourceType: 'web',
      playable: false, downloadable: false, cacheable: false, site: 'JioSaavn',
    };
    const song = discoveryToSong(ref);
    expect(song.capabilities?.streamable).toBe(false);
    expect(song.downloadAllowed).toBe(false);
    expect(song.sourceUrl).toBe(ref.canonicalUrl);
    expect(song.providerId).toBe('web-jiosaavn');
  });
});
