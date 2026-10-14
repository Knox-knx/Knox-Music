import { describe, it, expect, beforeEach } from 'vitest';
import type { Song } from '../../src/core/types';
import { buildUpNextQueue, startYouTubeUpNext, YT_UP_NEXT_COUNT } from '../../src/providers/youtube/upNext';
import { usePlayer } from '../../src/audio/playerStore';
import { getProviderManager } from '../../src/providers/ProviderManager';

function yt(id: string, extra?: Partial<Song>): Song {
  return {
    id: `youtube:${id}`,
    providerId: 'youtube',
    providerTrackId: id,
    title: `Title ${id}`,
    artist: `Artist ${id}`,
    album: '',
    durationMs: 200000,
    artworkUrl: undefined,
    downloadAllowed: true,
    isLocalFile: false,
    isOfflineAvailable: false,
    isFavorite: false,
    playCount: 0,
    addedAt: Date.now(),
    capabilities: { searchable: true, streamable: true, downloadable: true, offline: true, previewOnly: false },
    ...extra,
  } as Song;
}

describe('buildUpNextQueue', () => {
  it('takes siblings after the played track, capped', () => {
    const played = yt('v0');
    const list = [played, ...Array.from({ length: YT_UP_NEXT_COUNT + 10 }, (_, i) => yt(`v${i + 1}`))];
    const out = buildUpNextQueue(played, list);
    expect(out).toHaveLength(YT_UP_NEXT_COUNT);
    expect(out[0].id).toBe('youtube:v1');
    expect(out.map((s) => s.id)).not.toContain('youtube:v0');
  });

  it('excludes the played track wherever it sits and dedupes', () => {
    const played = yt('v2');
    const list = [yt('v1'), played, yt('v1'), yt('v3'), played];
    const out = buildUpNextQueue(played, list);
    expect(out.map((s) => s.id)).toEqual(['youtube:v1', 'youtube:v3']);
  });

  it('keeps only streamable YouTube tracks', () => {
    const played = yt('v0');
    const other = { ...yt('x1'), providerId: 'jamendo', id: 'jamendo:x1' };
    const discovery = yt('v1', { capabilities: { searchable: true, streamable: false, downloadable: false, offline: false, previewOnly: false } });
    const out = buildUpNextQueue(played, [other, discovery, yt('v2')]);
    expect(out.map((s) => s.id)).toEqual(['youtube:v2']);
  });

  it('returns [] for empty input without throwing', () => {
    const played = yt('v0');
    expect(buildUpNextQueue(played, [])).toEqual([]);
    expect(buildUpNextQueue(played, [played])).toEqual([]);
  });
});

describe('startYouTubeUpNext real-time Mix & clean queue replacement', () => {
  beforeEach(() => {
    usePlayer.setState({
      queue: [],
      index: -1,
      current: null,
      offlineMode: false,
    });
  });

  it('fetches real-time YouTube Mix playlist and removes old previously played songs from queue', async () => {
    const oldSong1 = yt('old1', { title: 'Old Song 1', artist: 'Old Singer A' });
    const oldSong2 = yt('old2', { title: 'Old Song 2', artist: 'Old Singer B' });
    const auraPhonk = yt('aura1', { title: 'AURA PHONK', artist: 'Ogryzek' });

    // Simulate player previously having old songs in queue when auraPhonk starts playing
    usePlayer.setState({
      queue: [oldSong1, oldSong2, auraPhonk],
      index: 2,
      current: auraPhonk,
      offlineMode: false,
    });

    const mixTracks = [
      yt('mix1', { title: 'GLORY', artist: 'Ogryzek' }),
      yt('mix2', { title: 'PASSO BEM SOLTO', artist: 'ATLXS' }),
      yt('mix3', { title: 'SLAY!', artist: 'Eternxlkz' }),
      yt('mix4', { title: 'Close Eyes', artist: 'DVRST' }),
      yt('mix5', { title: 'Murder In My Mind', artist: 'Kordhell' }),
    ];

    const pm = getProviderManager();
    const origYt = pm.get('youtube');
    let mixCalledWith = '';
    pm.register({
      id: 'youtube',
      name: 'YouTube',
      capabilities: {
        supportsSearch: true,
        supportsStreaming: true,
        supportsOffline: true,
        supportsLyrics: false,
        supportsArtwork: true,
        supportsArtists: false,
        supportsAlbums: false,
        supportsPlaybackCache: true,
      },
      searchSongs: async () => [],
      searchArtists: async () => [],
      searchAlbums: async () => [],
      searchPlaylists: async () => [],
      getSong: async () => null,
      getArtist: async () => null,
      getAlbum: async () => null,
      getPlaylist: async () => null,
      getAlbumTracks: async () => [],
      getStream: async () => ({ url: 'https://example.com/a.mp3', mimeType: 'audio/mpeg', quality: '128k', allowsOffline: true }),
      getArtwork: async () => null,
      getLyrics: async () => null,
      getMixPlaylist: async (videoId: string) => {
        mixCalledWith = videoId;
        return mixTracks;
      },
    } as never);

    try {
      const res = await startYouTubeUpNext(auraPhonk, [], 'aura phonk');
      expect(mixCalledWith).toBe('aura1');
      expect(res.queued).toBeGreaterThan(0);

      const state = usePlayer.getState();
      // Current song is at index 0
      expect(state.index).toBe(0);
      expect(state.queue[0].id).toBe('youtube:aura1');

      // Old songs MUST NOT be in the queue anymore
      const queueIds = state.queue.map((s) => s.id);
      expect(queueIds).not.toContain('youtube:old1');
      expect(queueIds).not.toContain('youtube:old2');

      // New real-time Mix songs are in the queue after auraPhonk
      expect(queueIds).toContain('youtube:mix2');
      expect(queueIds).toContain('youtube:mix3');
      expect(queueIds).toContain('youtube:mix4');
      expect(queueIds).toContain('youtube:mix5');
    } finally {
      if (origYt) pm.register(origYt);
    }
  });
});

