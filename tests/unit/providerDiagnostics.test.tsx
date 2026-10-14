// Provider diagnostics tests (§8 PROVIDERS 18–24 + isolation).
//
// FreeToUse: endpoint shape, empty-as-empty (catalog gaps are not outages),
// HTTP failures throw for isolation, timeouts surface as TIMEOUT.
// YouTube Music: sidecar health/search mapping, discovery-only invariants.
// Isolation: one provider failing never breaks the others.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { JioSaavnProvider } from '../../src/providers/jiosaavn/provider';
import { YouTubeMusicProvider } from '../../src/providers/youtubeMusic/provider';
import { checkYouTubeMusicHealth } from '../../src/providers/youtubeMusic/health';
import { searchYouTubeMusic, clearYouTubeMusicCache } from '../../src/providers/youtubeMusic/search';
import { ProviderManager } from '../../src/providers/ProviderManager';
import { ProviderError } from '../../src/core/errors';
import type { MusicProvider } from '../../src/providers/types';
import type { Song } from '../../src/core/types';
import { PartialResultsNotice } from '../../src/screens/SearchScreen';

function song(over: Partial<Song> = {}): Song {
  return {
    id: 'x:1', providerId: 'x', providerTrackId: '1', title: 'T', artist: 'A',
    album: '', durationMs: 1000, addedAt: 0, ...over,
  } as Song;
}

function stub(id: string, mode: 'ok' | 'throw' = 'ok'): MusicProvider {
  return {
    id, name: id,
    capabilities: {
      supportsSearch: true, supportsStreaming: true, supportsOffline: true,
      supportsLyrics: false, supportsArtwork: false, supportsArtists: true, supportsAlbums: true,
    },
    searchSongs: async (q: string) => {
      if (mode === 'throw') throw new ProviderError('NETWORK', `${id} down`);
      return [song({ id: `${id}:1`, providerId: id, providerTrackId: '1', title: `${q} hit` })];
    },
    searchArtists: async () => [], searchAlbums: async () => [], searchPlaylists: async () => [],
    getSong: async () => null, getArtist: async () => null, getAlbum: async () => null,
    getPlaylist: async () => null, getAlbumTracks: async () => [],
    getStream: async () => { throw new ProviderError('UNSUPPORTED', 'no'); },
    getArtwork: async () => null, getLyrics: async () => null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearYouTubeMusicCache();
});

describe('JioSaavn in-app server (18–20)', () => {
  const okPayload = {
    results: [{
      id: 'js-track-1',
      title: 'Soch',
      subtitle: 'Hardy Sandhu',
      perma_url: 'https://www.jiosaavn.com/song/soch/js-track-1',
      image: 'https://c.saavncdn.com/123/soch-150x150.jpg',
      duration: '248',
      more_info: {
        album: 'Soch Single',
        vlink: 'https://aac.saavncdn.com/123/soch_96.mp4',
        artistMap: { primary_artists: [{ id: 'a1', name: 'Hardy Sandhu' }] },
      },
    }],
  };

  it('18/19. searches JioSaavn and maps results with 320kbps AAC stream', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(okPayload), {
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const songs = await new JioSaavnProvider().searchSongs('soch');
    expect(songs).toHaveLength(1);
    expect(songs[0].providerId).toBe('jiosaavn');
    expect(songs[0].streamUrl).toContain('_320.mp4');
  });

  it('19b. empty catalog results are empty, not a failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ results: [] }),
      { headers: { 'content-type': 'application/json' } },
    )));
    await expect(new JioSaavnProvider().searchSongs('hardy sandhu soch')).resolves.toEqual([]);
  });

  it('19c. HTTP 500 throws so isolation marks a failure (never fake-available)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(new JioSaavnProvider().searchSongs('love')).rejects.toThrow();
  });
});

describe('YouTube Music sidecar (21–23)', () => {
  it('21. health is true when the sidecar answers', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ ok: true, service: 'knox-youtube-music' }),
      { headers: { 'content-type': 'application/json' } },
    )));
    await expect(checkYouTubeMusicHealth()).resolves.toBe(true);
  });

  it('21b. health is false (never throws) when the sidecar is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(checkYouTubeMusicHealth()).resolves.toBe(false);
  });

  it('22. search maps sidecar results to songs', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/health')) {
        return new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({
        results: [{
          id: 'youtube-music:VID123', title: 'SOCH', artist: 'HARDY SANDHU',
          album: '', duration: 0, videoId: 'VID123', provider: 'youtube-music',
        }],
      }), { headers: { 'content-type': 'application/json' } });
    }));
    const songs = await searchYouTubeMusic('soch');
    expect(songs.length).toBeGreaterThan(0);
    expect(songs[0].providerId).toBe('youtube-music');
    expect(songs[0].title).toBe('SOCH');
  });

  it('23. YouTube Music in-app server supports search, streaming, download, and offline', async () => {
    const p = new YouTubeMusicProvider();
    expect(p.capabilities.supportsSearch).toBe(true);
    expect(p.capabilities.supportsStreaming).toBe(true);
    expect(p.capabilities.supportsOffline).toBe(true);
    expect(p.capabilities.supportsDownloads).toBe(true);
    expect(p.capabilities.supportsPlaybackCache).toBe(false);
    await expect(p.canDownload()).resolves.toBe(true);
  });
});

describe('failure isolation + honest banner (24, §3D/§3E)', () => {
  it('one provider failing never breaks the other in-app servers', async () => {
    const pm = new ProviderManager(2000);
    pm.register(stub('spotify', 'throw'));
    pm.register(stub('jiosaavn'));
    pm.register(stub('youtube'));
    const { items, failures } = await pm.searchAll('soch', 'songs');
    expect(failures).toEqual(['spotify']);
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((i) => (i as Song).providerId)).not.toContain('spotify');
  });

  it('playback failures name sources without claiming offline', () => {
    render(<PartialResultsNotice failures={['jiosaavn']} />);
    expect(screen.getByText(/some sources are temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/jiosaavn/i)).toBeInTheDocument();
    expect(screen.queryByText(/offline/i)).not.toBeInTheDocument();
  });

  it('youtube-music failure is reported as a source failure', () => {
    render(<PartialResultsNotice failures={['youtube-music']} />);
    expect(screen.getByText(/some sources are temporarily unavailable/i)).toBeInTheDocument();
    expect(screen.getByText(/youtube music/i)).toBeInTheDocument();
  });
});
