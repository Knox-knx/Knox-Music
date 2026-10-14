import { describe, it, expect, vi, afterEach } from 'vitest';
import { JioSaavnProvider, mapJioSaavnSong } from '../../src/providers/jiosaavn';
import { SpotifyProvider, mapSpotifyTrack } from '../../src/providers/spotify';
import { YouTubeMusicProvider, mapYouTubeMusicTrack } from '../../src/providers/youtubeMusic/provider';
import { ProviderManager } from '../../src/providers/ProviderManager';
import {
  dedupeSongs,
  equivalenceKey,
  findEquivalents,
  isValidSong,
  mergeAndRank,
  normalizeKeyPart,
  providerLabel,
  sortSongs,
} from '../../src/providers/merge';
import type { Song } from '../../src/core/types';

afterEach(() => { vi.unstubAllGlobals(); });

function song(over: Partial<Song> & { id: string }): Song {
  return {
    providerId: 'jiosaavn', providerTrackId: 'x', title: 'T', artist: 'A',
    album: '', durationMs: 1000, addedAt: 0, ...over,
  } as Song;
}

// ---------- JioSaavn ----------

describe('JioSaavn provider (in-app server)', () => {
  it('maps JioSaavn track and upgrades CDN audio to 320kbps AAC', () => {
    const s = mapJioSaavnSong({
      id: '1278736',
      title: 'Faded Letters',
      artist: 'Pablo Samonta',
      album: 'Melancholy',
      durationSec: 35,
      artworkUrl: 'https://c.saavncdn.com/152/cover-150x150.jpg',
      streamUrl: 'https://aac.saavncdn.com/152/track_96.mp4',
      sourceUrl: 'https://www.jiosaavn.com/song/faded-letters/1278736',
    })!;
    expect(s.id).toBe('jiosaavn:1278736');
    expect(s.durationMs).toBe(35000);
    expect(s.downloadAllowed).toBe(true);
    expect(s.streamUrl).toBe('https://aac.saavncdn.com/152/track_320.mp4');
    expect(s.artworkUrl).toContain('500x500');
  });

  it('searchSongs hits JioSaavn API and maps tracks (mocked fetch)', async () => {
    const payload = {
      results: [{
        id: 'js1',
        title: 'Faded',
        subtitle: 'Alan Walker',
        perma_url: 'https://www.jiosaavn.com/song/faded/js1',
        image: 'https://c.saavncdn.com/1/faded-150x150.jpg',
        duration: '212',
        more_info: {
          album: 'Different World',
          vlink: 'https://aac.saavncdn.com/1/faded_96.mp4',
          artistMap: { primary_artists: [{ id: 'a1', name: 'Alan Walker' }] },
        },
      }],
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload), {
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);
    const p = new JioSaavnProvider();
    const res = await p.searchSongs('faded');
    expect(res).toHaveLength(1);
    expect(res[0].id).toBe('jiosaavn:js1');
    expect(res[0].streamUrl).toBe('https://aac.saavncdn.com/1/faded_320.mp4');
  });

  it('getStream returns 320kbps AAC stream with offline flag', async () => {
    const p = new JioSaavnProvider();
    const stream = await p.getStream(song({
      id: 'jiosaavn:1',
      providerTrackId: '1',
      title: 'Faded Letters',
      artist: 'Pablo',
      streamUrl: 'https://aac.saavncdn.com/1/track_96.mp4',
    }));
    expect(stream.url).toContain('_320.mp4');
    expect(stream.allowsOffline).toBe(true);
    expect(stream.mimeType).toBe('audio/mp4');
  });
});

// ---------- Spotify ----------

describe('Spotify provider (in-app server)', () => {
  it('maps Spotify tracks as playable and downloadable via in-app audio server', () => {
    const s = mapSpotifyTrack({
      id: '3n3Ppam7vgaVa1iaRUc9Lp',
      title: 'Mr. Brightside',
      artist: 'The Killers',
      album: 'Hot Fuss',
      durationSec: 222,
      artworkUrl: 'https://i.scdn.co/image/abc',
      sourceUrl: 'https://open.spotify.com/track/3n3Ppam7vgaVa1iaRUc9Lp',
    })!;
    expect(s.id).toBe('spotify:3n3Ppam7vgaVa1iaRUc9Lp');
    expect(s.providerId).toBe('spotify');
    expect(s.durationMs).toBe(222000);
    expect(s.downloadAllowed).toBe(true);
    expect(s.capabilities).toMatchObject({
      searchable: true,
      streamable: true,
      downloadable: true,
      offline: true,
    });
  });

  it('resolves Spotify track URL via oEmbed when pasted into search', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes('open.spotify.com/oembed')) {
        return new Response(JSON.stringify({
          title: 'Blinding Lights',
          author_name: 'The Weeknd',
          thumbnail_url: 'https://i.scdn.co/image/blinding',
        }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    }));
    const p = new SpotifyProvider();
    const songs = await p.searchSongs('https://open.spotify.com/track/0VjIjW4GlUZAMYd2vXMi3b');
    expect(songs).toHaveLength(1);
    expect(songs[0].id).toBe('spotify:0VjIjW4GlUZAMYd2vXMi3b');
    expect(songs[0].title).toBe('Blinding Lights');
    expect(songs[0].artist).toBe('The Weeknd');
  });
});

// ---------- YouTube Music ----------

describe('YouTube Music provider (in-app server)', () => {
  it('maps YouTube Music tracks with full streaming and offline capabilities', () => {
    const s = mapYouTubeMusicTrack({
      id: 'youtube-music:dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      album: 'Whenever You Need Somebody',
      duration: 214,
      artwork: 'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg',
      year: 1987,
      videoId: 'dQw4w9WgXcQ',
      provider: 'youtube-music',
    })!;
    expect(s.id).toBe('youtube-music:dQw4w9WgXcQ');
    expect(s.downloadAllowed).toBe(true);
    expect(s.capabilities?.streamable).toBe(true);
    expect(s.capabilities?.downloadable).toBe(true);
    expect(s.capabilities?.offline).toBe(true);
    expect(new YouTubeMusicProvider().capabilities.supportsStreaming).toBe(true);
  });
});

// ---------- Parallel search / failure isolation ----------

describe('multi-provider parallel search', () => {
  function stub(id: string, titles: string[], fail = false) {
    return {
      id, name: id,
      capabilities: {
        supportsSearch: true, supportsStreaming: true, supportsOffline: true,
        supportsLyrics: false, supportsArtwork: false, supportsArtists: true, supportsAlbums: true,
      },
      searchSongs: async (q: string) => {
        if (fail) throw new Error(`${id} down`);
        return titles.filter((t) => t.toLowerCase().includes(q.toLowerCase())).map((title, i) => song({ id: `${id}:${i}`, providerId: id, providerTrackId: String(i), title, artist: 'A' }));
      },
      searchArtists: async () => [], searchAlbums: async () => [], searchPlaylists: async () => [],
      getSong: async () => null, getArtist: async () => null, getAlbum: async () => null,
      getPlaylist: async () => null, getAlbumTracks: async () => [],
      getStream: async () => { throw new Error('no'); }, getArtwork: async () => null, getLyrics: async () => null,
    };
  }

  it('queries jiosaavn + spotify + youtube-music in parallel and merges', async () => {
    const pm = new ProviderManager(2000);
    pm.register(stub('jiosaavn', ['Faded Letters']));
    pm.register(stub('spotify', ['Faded Town']));
    pm.register(stub('youtube-music', ['Faded Light']));
    const { items, failures } = await pm.searchAll('faded', 'songs');
    expect(failures).toEqual([]);
    expect(mergeAndRank(items as Song[], 'faded')).toHaveLength(3);
  });

  it('one provider failure never breaks the others', async () => {
    const pm = new ProviderManager(2000);
    pm.register(stub('jiosaavn', [], true));
    pm.register(stub('spotify', ['Faded Town']));
    pm.register(stub('youtube-music', ['Faded Light']));
    const { items, failures } = await pm.searchAll('faded', 'songs');
    expect(failures).toEqual(['jiosaavn']);
    expect(items).toHaveLength(2);
  });
});

// ---------- Normalization / dedup / ranking ----------

describe('result merging', () => {
  it('normalizes case/punctuation for equivalence', () => {
    expect(normalizeKeyPart('  Faded! Letters ')).toBe('faded letters');
    expect(equivalenceKey({ title: 'Faded', artist: 'Alan Walker' }))
      .toBe(equivalenceKey({ title: ' faded! ', artist: 'ALAN  walker' }));
  });

  it('rejects invalid results', () => {
    expect(isValidSong(song({ id: 'a:1', title: '', artist: 'A' }))).toBe(false);
    expect(isValidSong(song({ id: 'a:1', title: 'T', artist: 'A' }))).toBe(true);
  });

  it('dedupes same-id but keeps cross-provider equivalents visible', () => {
    const a = song({ id: 'jiosaavn:1', providerId: 'jiosaavn', providerTrackId: '1', title: 'Faded', artist: 'Walker' });
    const b = song({ id: 'spotify:2', providerId: 'spotify', providerTrackId: '2', title: 'Faded', artist: 'Walker' });
    const dup = song({ id: 'jiosaavn:1', providerId: 'jiosaavn', providerTrackId: '1', title: 'Faded', artist: 'Walker' });
    const bad = song({ id: 'x:9', providerId: 'x', providerTrackId: '9', title: '', artist: 'Nobody' });
    expect(dedupeSongs([a, b, dup, bad])).toHaveLength(2);
    expect(findEquivalents(a, [a, b])).toEqual([b]);
  });

  it('never merges merely-similar names', () => {
    const a = song({ id: 'j:1', providerId: 'jiosaavn', providerTrackId: '1', title: 'Faded', artist: 'Walker' });
    const b = song({ id: 's:2', providerId: 'spotify', providerTrackId: '2', title: 'Fade', artist: 'Walker' });
    expect(findEquivalents(a, [a, b])).toEqual([]);
  });

  it('ranks exact title/artist matches first and prefers artwork', () => {
    const exact = song({ id: 'j:1', providerId: 'jiosaavn', providerTrackId: '1', title: 'Faded', artist: 'Walker', artworkUrl: 'https://x/y.jpg' });
    const partial = song({ id: 's:2', providerId: 'spotify', providerTrackId: '2', title: 'Faded Light Remix', artist: 'Someone' });
    expect(mergeAndRank([partial, exact], 'faded')[0].id).toBe('j:1');
  });

  it('sorts by title/artist/duration/provider', () => {
    const songs = [
      song({ id: 'b:1', providerId: 'spotify', providerTrackId: '1', title: 'Zebra', artist: 'B', durationMs: 3000 }),
      song({ id: 'a:2', providerId: 'jiosaavn', providerTrackId: '2', title: 'Apple', artist: 'A', durationMs: 1000 }),
    ];
    expect(sortSongs(songs, 'title')[0].title).toBe('Apple');
    expect(sortSongs(songs, 'artist')[0].artist).toBe('A');
    expect(sortSongs(songs, 'duration')[0].durationMs).toBe(1000);
    expect(sortSongs(songs, 'provider')[0].providerId).toBe('jiosaavn');
  });

  it('labels every provider for the UI badge', () => {
    expect(providerLabel('jiosaavn')).toBe('JioSaavn');
    expect(providerLabel('spotify')).toBe('Spotify');
    expect(providerLabel('youtube')).toBe('YouTube');
    expect(providerLabel('youtube-music')).toBe('YouTube Music');
    expect(providerLabel('local')).toBe('Local');
  });
});
