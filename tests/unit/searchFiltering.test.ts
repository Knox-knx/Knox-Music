// Scoped search view (§4): provider filter, capability honesty, merge
// survival, ranking, dedupe, and empty-state attribution.
import { describe, it, expect } from 'vitest';
import { scopeSearchView } from '../../src/search/filtering';
import { runSearchPipeline } from '../../src/search/searchEngine';
import { dedupeSongs } from '../../src/search/dedupe';
import type { Album, Artist, Playlist, Song } from '../../src/core/types';

function song(over: Partial<Song> & { id: string }): Song {
  return {
    providerId: 'jamendo',
    providerTrackId: 'x',
    title: 'T',
    artist: 'A',
    album: '',
    durationMs: 1000,
    addedAt: 0,
    ...over,
  } as Song;
}

const YT = (over: Partial<Song> & { id: string }): Song =>
  song({
    providerId: 'youtube-music',
    providerTrackId: over.id.replace(/^youtube-music:/, ''),
    durationMs: 0,
    capabilities: { searchable: true, streamable: false, downloadable: false, offline: false, previewOnly: false },
    ...over,
  } as Partial<Song> as Song);

const ALL_ENABLED = ['local', 'sample', 'jamendo', 'internet-archive', 'freetouse', 'airbeats', 'youtube-music'];

const ytSongs = [
  YT({ id: 'youtube-music:lNM9HlEK4q4', title: 'The Spectre', artist: 'Alan Walker' }),
  YT({ id: 'youtube-music:aZwklvDdaVw', title: 'Alone', artist: 'Alan Walker' }),
];

describe('provider filter identity (§4A)', () => {
  it('matches the selected id against result.providerId (youtube-music)', () => {
    const view = scopeSearchView({
      songs: [...ytSongs, song({ id: 'jamendo:1', providerId: 'jamendo', providerTrackId: '1', title: 'The Spectre', artist: 'Alan Walker' })],
      artists: [], albums: [], playlists: [], failures: [],
      providerFilter: 'youtube-music', enabledIds: ALL_ENABLED,
      loading: false, error: null, query: 'alan walker',
    });
    expect(view.visibleSongs).toHaveLength(2);
    expect(view.visibleSongs.every((s) => s.providerId === 'youtube-music')).toBe(true);
  });

  it('All sources shows youtube-music results alongside others', () => {
    const view = scopeSearchView({
      songs: [...ytSongs, song({ id: 'airbeats:1', providerId: 'airbeats', providerTrackId: '1' })],
      artists: [], albums: [], playlists: [], failures: [],
      providerFilter: 'all', enabledIds: ALL_ENABLED,
      loading: false, error: null, query: 'alan walker',
    });
    expect(view.visibleSongs).toHaveLength(3);
    expect(view.visibleSongs.some((s) => s.providerId === 'youtube-music')).toBe(true);
  });
});

describe('capability filtering (§4B)', () => {
  it('discovery-only tracks (stream false, no streamUrl) survive the pipeline', () => {
    const outcome = runSearchPipeline(ytSongs, 'alan walker');
    expect(outcome.songs.length).toBeGreaterThanOrEqual(2);
    expect(outcome.songs.some((s) => s.providerId === 'youtube-music')).toBe(true);
  });

  it('merge isolation: one provider failing never drops youtube-music rows', async () => {
    const { searchSongsIsolated } = await import('../../src/search/searchEngine');
    const good = {
      id: 'youtube-music', name: 'YouTube Music',
      capabilities: { supportsSearch: true, supportsStreaming: false, supportsOffline: false, supportsLyrics: false, supportsArtwork: false, supportsArtists: true, supportsAlbums: true },
      searchSongs: async () => ytSongs,
      searchArtists: async () => [], searchAlbums: async () => [], searchPlaylists: async () => [],
      getSong: async () => null, getArtist: async () => null, getAlbum: async () => null,
      getPlaylist: async () => null, getAlbumTracks: async () => [],
      getStream: async () => { throw new Error('discovery only'); },
      getArtwork: async () => null, getLyrics: async () => null,
    };
    const bad = { ...good, id: 'jamendo', searchSongs: async () => { throw new Error('down'); } };
    const { songs: merged, failures } = await searchSongsIsolated([good, bad] as never, 'alan walker');
    expect(merged.filter((s) => s.providerId === 'youtube-music')).toHaveLength(2);
    expect(failures).toEqual(['jamendo']);
  });
});

describe('failure scoping (§4D/§4H)', () => {
  const fourDown = ['jamendo', 'internet-archive', 'freetouse', 'airbeats'];

  it('unrelated failures do not nag while browsing healthy youtube-music results', () => {
    const view = scopeSearchView({
      songs: ytSongs, artists: [], albums: [], playlists: [], failures: fourDown,
      providerFilter: 'youtube-music', enabledIds: ALL_ENABLED,
      loading: false, error: null, query: 'alan walker',
    });
    expect(view.scopedFailures).toEqual([]);
    expect(view.visibleEmpty).toBe(false);
    expect(view.allFailed).toBe(false);
  });

  it('youtube-music-only failure is reported (not masked as partial)', () => {
    const view = scopeSearchView({
      songs: [], artists: [], albums: [], playlists: [], failures: ['youtube-music'],
      providerFilter: 'youtube-music', enabledIds: ALL_ENABLED,
      loading: false, error: null, query: 'alan walker',
    });
    expect(view.visibleEmpty).toBe(true);
    expect(view.allFailed).toBe(true);
    expect(view.scopedFailures).toEqual(['youtube-music']);
  });

  it('empty state is scoped: other-provider hits do not mask an empty filter', () => {
    const view = scopeSearchView({
      songs: [song({ id: 'jamendo:9', providerId: 'jamendo', providerTrackId: '9' })],
      artists: [], albums: [], playlists: [], failures: [],
      providerFilter: 'youtube-music', enabledIds: ALL_ENABLED,
      loading: false, error: null, query: 'alan walker',
    });
    expect(view.visibleEmpty).toBe(true);
    expect(view.allFailed).toBe(false);
  });
});

describe('dedupe survival (§4E)', () => {
  it('youtube-music:<videoId> ids survive dedupe; same-id dupes collapse', () => {
    const dup = [...ytSongs, { ...ytSongs[0] }];
    expect(dedupeSongs(dup).map((s) => s.id)).toEqual(['youtube-music:lNM9HlEK4q4', 'youtube-music:aZwklvDdaVw']);
  });

  it('same title/artist from different providers is NOT collapsed', () => {
    const cross = [
      YT({ id: 'youtube-music:aaaaaa', title: 'Faded', artist: 'Alan Walker' }),
      song({ id: 'jamendo:1', providerId: 'jamendo', providerTrackId: '1', title: 'Faded', artist: 'Alan Walker' }),
    ];
    expect(dedupeSongs(cross)).toHaveLength(2);
  });
});

describe('ranking validity (§4F)', () => {
  it('youtube-music rows receive relevance scores and match types', () => {
    const outcome = runSearchPipeline(ytSongs, 'alan walker');
    for (const s of outcome.songs.filter((x) => x.providerId === 'youtube-music')) {
      expect(typeof s.relevanceScore).toBe('number');
      expect(s.relevanceScore).toBeGreaterThanOrEqual(0);
      expect(['exact', 'strong', 'partial', 'related']).toContain(s.matchType);
    }
  });
});

describe('result mapping consistency (§4G)', () => {
  it('maps title/artist/album/duration/artwork/year/videoId/provider/capabilities', async () => {
    const { mapYouTubeMusicTrack } = await import('../../src/providers/youtubeMusic/mapper');
    const s = mapYouTubeMusicTrack({
      id: 'youtube-music:lNM9HlEK4q4', title: 'The Spectre', artist: 'Alan Walker',
      album: '', duration: 0, artwork: 'https://x/img.jpg', year: null,
      videoId: 'lNM9HlEK4q4', provider: 'youtube-music',
    })!;
    expect(s.title).toBe('The Spectre');
    expect(s.artist).toBe('Alan Walker');
    expect(s.album).toBe('');
    expect(s.durationMs).toBe(0);
    expect(s.artworkUrl).toBe('https://x/img.jpg');
    expect(s.year).toBeUndefined();
    expect(s.providerTrackId).toBe('lNM9HlEK4q4');
    expect(s.providerId).toBe('youtube-music');
    expect(s.capabilities).toMatchObject({ searchable: true, streamable: true, downloadable: true, offline: true });
  });
});

describe('artist/album/playlist views', () => {
  it('filters artists/albums/playlists by the same provider id', () => {
    const artist = (id: string, providerId: string): Artist => ({ id, providerId, providerArtistId: 'x', name: 'Alan Walker' });
    const album = (id: string, providerId: string): Album => ({ id, providerId, providerAlbumId: 'x', title: 'A', artist: 'B' });
    const playlist = (id: string, providerId?: string): Playlist => ({
      id, name: 'P', createdAt: 0, updatedAt: 0, trackIds: [], isUserPlaylist: false, providerId,
    });
    const view = scopeSearchView({
      songs: [], artists: [artist('youtube-music:artist:Alan Walker', 'youtube-music'), artist('jamendo:artist:1', 'jamendo')],
      albums: [album('youtube-music:album:X', 'youtube-music')],
      playlists: [playlist('u:1'), playlist('youtube-music:playlist:1', 'youtube-music')],
      failures: [], providerFilter: 'youtube-music', enabledIds: ALL_ENABLED,
      loading: false, error: null, query: 'alan walker',
    });
    expect(view.visibleArtists).toHaveLength(1);
    expect(view.visibleAlbums).toHaveLength(1);
    expect(view.visiblePlaylists.map((p) => p.id)).toEqual(['youtube-music:playlist:1']);
  });
});
