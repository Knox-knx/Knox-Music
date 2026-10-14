// Local-first Web Discovery — production path tests.
//
// Proves Web Discovery works WITHOUT VITE_WEB_DISCOVERY_URL:
//  - builtin registration always includes the local-desktop provider
//  - public metadata lookup (MusicBrainz) maps to reference-only results
//  - failures yield [] (never block provider search)
//  - musicbrainz.org pages are detected as song references
//  - oversized pages / over-limit redirects / localhost are rejected
//  - web hits stay non-playable / non-downloadable (no fake URLs)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  registerBuiltinWebSearch,
  listWebSearchProviders,
  clearWebSearchProviders,
  searchWeb,
  __resetWebSearchRateLimitsForTests,
  __clearWebSearchCacheForTests,
} from '../../src/discovery/webSearch';
import {
  buildMusicBrainzQuery,
  discoverySearchViaPublicMetadata,
  localDesktopDiscoverySearch,
} from '../../src/discovery/localDiscoveryService';
import {
  clearWebPageProviders,
  detectMusicPage,
  registerBuiltinWebPageProviders,
} from '../../src/discovery/providerDetector';
import { resolveMusicPage } from '../../src/discovery/pageResolver';
import { clearDiscoveryCache } from '../../src/discovery/discoveryCache';
import { discoverWebReferences } from '../../src/discovery/webDiscovery';

function mbJson(title = 'Soch', artist = 'Hardy Sandhu', length = 346000) {
  return {
    recordings: [
      {
        id: 'abc-123',
        title,
        length,
        'artist-credit': [{ name: artist, artist: { name: artist } }],
        releases: [{ title: 'Album X' }],
      },
    ],
  };
}

function jsonFetch(body: unknown, status = 200) {
  return (async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch;
}

beforeEach(() => {
  clearWebSearchProviders();
  clearWebPageProviders();
  registerBuiltinWebPageProviders();
  clearDiscoveryCache();
  __resetWebSearchRateLimitsForTests();
  __clearWebSearchCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('local-first registration (never VITE-only)', () => {
  it('builtin search always includes the local-desktop provider', () => {
    registerBuiltinWebSearch();
    const ids = listWebSearchProviders().map((p) => p.id);
    expect(ids).toContain('local-desktop');
  });

  it('searchWeb returns local results with no VITE_WEB_DISCOVERY_URL configured', async () => {
    registerBuiltinWebSearch();
    const fetchImpl = jsonFetch(mbJson()) as unknown as typeof fetch;
    const { results } = await searchWeb('soch hardy sandhu', { fetchImpl });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].url).toContain('musicbrainz.org');
  });

  it('configured-json backend stays inert without configuration', async () => {
    const { ConfiguredJsonSearchProvider } = await import('../../src/discovery/webSearch');
    const p = new ConfiguredJsonSearchProvider();
    expect(await p.search('soch')).toEqual([]);
  });
});

describe('public metadata lookup (MusicBrainz, no key)', () => {
  it('maps recordings to reference results', async () => {
    const out = await discoverySearchViaPublicMetadata('soch', {
      fetchImpl: jsonFetch(mbJson()),
    });
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('Soch');
    expect(out[0].artist).toBe('Hardy Sandhu');
    expect(out[0].durationMs).toBe(346000);
    expect(out[0].provider).toBe('musicbrainz');
    expect(out[0].sourceType).toBe('web');
  });

  it('buildMusicBrainzQuery handles title/artist/album text', () => {
    expect(buildMusicBrainzQuery('soch')).toContain('soch');
    expect(buildMusicBrainzQuery('soch hardy sandhu')).toContain('hardy sandhu');
    expect(buildMusicBrainzQuery('')).toBe('');
    expect(buildMusicBrainzQuery('   ')).toBe('');
  });

  it('lookup failure yields [] (never blocks provider search)', async () => {
    const failing = (async () => {
      throw new Error('net down');
    }) as unknown as typeof fetch;
    expect(await discoverySearchViaPublicMetadata('soch', { fetchImpl: failing })).toEqual([]);
    expect(await localDesktopDiscoverySearch('soch', { fetchImpl: failing })).toEqual([]);
  });
});

describe('musicbrainz page family detection', () => {
  it('recognizes musicbrainz recording pages as song references', () => {
    const d = detectMusicPage('https://musicbrainz.org/recording/abc-123-def');
    expect(d).not.toBeNull();
    expect(d!.webProviderId).toBe('musicbrainz');
    expect(d!.kind).toBe('song');
  });
});

describe('page fetch guards (redirect/size/SSRF)', () => {
  it('localhost page URLs are blocked', async () => {
    expect(await resolveMusicPage('http://127.0.0.1/song/x')).toBeNull();
  });

  it('file:// and javascript: URLs are blocked', async () => {
    expect(await resolveMusicPage('file:///etc/passwd')).toBeNull();
    expect(await resolveMusicPage('javascript:alert(1)')).toBeNull();
  });

  it('oversized HTML is rejected', async () => {
    const big = `<html><head><title>${'x'.repeat(2_000_000)}</title></head></html>`;
    const fetchImpl = (async () => new Response(big, {
      status: 200, headers: { 'content-type': 'text/html' },
    })) as unknown as typeof fetch;
    const out = await resolveMusicPage('https://musicbrainz.org/recording/abc', {
      fetchImpl,
      maxBytes: 1000,
    });
    expect(out).toBeNull();
  });

  it('redirects beyond the limit are rejected', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://musicbrainz.org/recording/abc' },
      });
    }) as unknown as typeof fetch;
    const out = await resolveMusicPage('https://musicbrainz.org/recording/abc', {
      fetchImpl,
      maxRedirects: 2,
    });
    expect(out).toBeNull();
    // Bounded: local-proxy attempt + manual redirect chain within the limit.
    expect(n).toBeLessThanOrEqual(4);
  });
});

describe('end-to-end local discovery (reference-only)', () => {
  it('soch-style query yields web references with no fake playable URL', async () => {
    clearWebSearchProviders();
    registerBuiltinWebSearch();
    const mbFetch = (async (url: unknown) => {
      const u = String(url);
      if (u.includes('musicbrainz.org/ws/2')) {
        return new Response(JSON.stringify(mbJson('Soch', 'Hardy Sandhu')), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // Page fetch for the recording URL: minimal JSON-LD metadata.
      const html = `<html><head><script type="application/ld+json">{"@type":"MusicRecording","name":"Soch","byArtist":"Hardy Sandhu"}</script></head></html>`;
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
    }) as unknown as typeof fetch;
    const out = await discoverWebReferences('soch hardy sandhu', { fetchImpl: mbFetch });
    expect(out.references.length).toBeGreaterThanOrEqual(1);
    for (const r of out.references) {
      expect(r.playable).toBe(false);
      expect(r.downloadable).toBe(false);
    }
  });
});
