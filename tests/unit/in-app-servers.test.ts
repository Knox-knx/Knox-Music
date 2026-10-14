import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerProviders } from '../../src/core/knox';
import { getProviderManager } from '../../src/providers/ProviderManager';
import { DEFAULT_SETTINGS } from '../../src/settings/settingsStore';
import { PROXY_PROVIDERS } from '../../src/desktop/localApi';
import { filterSongsByProvider, scopeSearchView } from '../../src/search/filtering';
import { JioSaavnProvider, mapJioSaavnSong, upgradeSaavnAudioUrl } from '../../src/providers/jiosaavn';
import { SpotifyProvider, mapSpotifyTrack, parseSpotifyTrackQuery } from '../../src/providers/spotify';
import { YouTubeMusicProvider, mapYouTubeMusicTrack } from '../../src/providers/youtubeMusic/provider';
import { YouTubeProvider, isInAppServerSong, IN_APP_SERVER_PROVIDERS } from '../../src/providers/youtube';
import { JioSaavnProvider as LogicJioSaavnProvider } from '../../logic/jiosaavn/provider';
import { SpotifyProvider as LogicSpotifyProvider } from '../../logic/spotify/provider';
import { scrapeYouTubeSearch } from '../../logic/youtube/scraper';
import type { Song } from '../../src/core/types';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('In-app server architecture (YouTube, YouTube Music, Spotify, JioSaavn)', () => {
  it('registers all 4 in-app servers and removes airbeats + non-working APIs', () => {
    registerProviders();
    const pm = getProviderManager();

    for (const id of ['youtube', 'youtube-music', 'spotify', 'jiosaavn', 'local', 'sample']) {
      expect(pm.get(id)?.id).toBe(id);
    }

    for (const removed of ['airbeats', 'freetouse', 'jamendo', 'internet-archive']) {
      expect(pm.get(removed)).toBeUndefined();
      expect(DEFAULT_SETTINGS.providersEnabled[removed]).toBeUndefined();
      expect(PROXY_PROVIDERS.has(removed)).toBe(false);
    }
  });

  it('exposes logic/ modules backed by the in-app server providers', () => {
    expect(LogicJioSaavnProvider).toBe(JioSaavnProvider);
    expect(LogicSpotifyProvider).toBe(SpotifyProvider);
    expect(typeof scrapeYouTubeSearch).toBe('function');
  });

  it('marks all 4 in-app servers as playable & downloadable in-app', () => {
    const providers = [
      new YouTubeProvider(),
      new YouTubeMusicProvider(),
      new SpotifyProvider(),
      new JioSaavnProvider(),
    ];
    for (const p of providers) {
      expect(IN_APP_SERVER_PROVIDERS.includes(p.id as never)).toBe(true);
      expect(p.capabilities.supportsSearch).toBe(true);
      expect(p.capabilities.supportsStreaming).toBe(true);
      expect(p.capabilities.supportsOffline).toBe(true);
      expect(p.capabilities.supportsDownloads).toBe(true);
      expect(isInAppServerSong({ providerId: p.id, id: `${p.id}:123` })).toBe(true);
    }
  });

  it('filters Search tab results across youtube, youtube-music, spotify, jiosaavn, and local', () => {
    const mk = (providerId: string, id: string): Song => ({
      id: `${providerId}:${id}`,
      providerId,
      providerTrackId: id,
      title: `Track ${id}`,
      artist: 'Artist',
      album: 'Album',
      durationMs: 180000,
      addedAt: 0,
    });
    const songs = [
      mk('youtube', 'yt1'),
      mk('youtube-music', 'ytm1'),
      mk('spotify', 'sp1'),
      mk('jiosaavn', 'js1'),
      mk('local', 'loc1'),
    ];

    expect(filterSongsByProvider(songs, 'all')).toHaveLength(5);
    expect(filterSongsByProvider(songs, 'youtube').map((s) => s.id)).toEqual(['youtube:yt1']);
    expect(filterSongsByProvider(songs, 'youtube-music').map((s) => s.id)).toEqual(['youtube-music:ytm1']);
    expect(filterSongsByProvider(songs, 'spotify').map((s) => s.id)).toEqual(['spotify:sp1']);
    expect(filterSongsByProvider(songs, 'jiosaavn').map((s) => s.id)).toEqual(['jiosaavn:js1']);
    expect(filterSongsByProvider(songs, 'local').map((s) => s.id)).toEqual(['local:loc1']);

    const scoped = scopeSearchView({
      songs,
      artists: [],
      albums: [],
      playlists: [],
      failures: [],
      providerFilter: 'spotify',
      enabledIds: ['youtube', 'youtube-music', 'spotify', 'jiosaavn', 'local'],
      loading: false,
      error: null,
      query: 'Track',
    });
    expect(scoped.visibleSongs).toHaveLength(1);
    expect(scoped.visibleSongs[0].providerId).toBe('spotify');
  });

  it('parses Spotify track URLs/URIs and maps JioSaavn + YouTube Music tracks accurately', () => {
    expect(parseSpotifyTrackQuery('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=123')).toBe('4cOdK2wGLETKBW3PvgPWqT');
    expect(parseSpotifyTrackQuery('spotify:track:4cOdK2wGLETKBW3PvgPWqT')).toBe('4cOdK2wGLETKBW3PvgPWqT');
    expect(parseSpotifyTrackQuery('just a search query')).toBeNull();

    const spSong = mapSpotifyTrack({
      id: '4cOdK2wGLETKBW3PvgPWqT',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      durationSec: 213,
    })!;
    expect(spSong.id).toBe('spotify:4cOdK2wGLETKBW3PvgPWqT');
    expect(spSong.downloadAllowed).toBe(true);

    const jsSong = mapJioSaavnSong({
      id: 'saavn1',
      title: 'Kesariya',
      artist: 'Arijit Singh',
      durationSec: 268,
      streamUrl: 'https://aac.saavncdn.com/111/kesariya_96.mp4',
    })!;
    expect(jsSong.id).toBe('jiosaavn:saavn1');
    expect(jsSong.streamUrl).toBe(upgradeSaavnAudioUrl('https://aac.saavncdn.com/111/kesariya_96.mp4'));
    expect(jsSong.downloadAllowed).toBe(true);

    const ytmSong = mapYouTubeMusicTrack({
      id: 'youtube-music:dQw4w9WgXcQ',
      title: 'Never Gonna Give You Up',
      artist: 'Rick Astley',
      duration: 213,
      videoId: 'dQw4w9WgXcQ',
    })!;
    expect(ytmSong.id).toBe('youtube-music:dQw4w9WgXcQ');
    expect(ytmSong.downloadAllowed).toBe(true);
  });

  it('auto-deletes old duplicate song from Library/Offline when playing same song from another provider (e.g. Glory from YT -> JioSaavn)', async () => {
    const { songRepo, offlineRepo, favoriteRepo, playlistRepo } = await import('../../src/data/repositories');
    const { dedupeLibraryForPlayedSong } = await import('../../src/providers/youtube/youtubeOffline');

    const ytGlory: Song = {
      id: 'youtube:gloryYt1234',
      providerId: 'youtube',
      providerTrackId: 'gloryYt1234',
      title: 'GLORY (Official Video) - Yo Yo Honey Singh',
      artist: 'T-Series',
      album: 'Glory',
      durationMs: 210_000,
      addedAt: Date.now() - 10_000,
      isOfflineAvailable: true,
    };

    await songRepo.upsert(ytGlory);
    await offlineRepo.put(ytGlory, new Blob([new Uint8Array([0xff, 0xfb, 0x90, 0x64])], { type: 'audio/mpeg' }), 'MP3');
    await favoriteRepo.add(ytGlory.id);
    const pl = await playlistRepo.create('My Hits', '', [ytGlory.id]);

    expect(await songRepo.get(ytGlory.id)).toBeDefined();
    expect(await offlineRepo.get(ytGlory.id)).toBeDefined();

    // User searches "Glory" and starts playing it from JioSaavn
    const saavnGlory: Song = {
      id: 'jiosaavn:saavnGlory99',
      providerId: 'jiosaavn',
      providerTrackId: 'saavnGlory99',
      title: 'Glory',
      artist: 'Yo Yo Honey Singh',
      album: 'Glory',
      durationMs: 208_000,
      addedAt: Date.now(),
    };

    const removedCount = await dedupeLibraryForPlayedSong(saavnGlory);
    expect(removedCount).toBeGreaterThanOrEqual(1);

    // Old YouTube duplicate is gone from both songRepo and offlineRepo
    expect(await songRepo.get(ytGlory.id)).toBeUndefined();
    expect(await offlineRepo.get(ytGlory.id)).toBeUndefined();

    // New JioSaavn version is in songRepo, and favorite + playlist migrated to it
    expect(await songRepo.get(saavnGlory.id)).toBeDefined();
    expect(await favoriteRepo.isFavorite(saavnGlory.id)).toBe(true);
    const updatedPl = await playlistRepo.get(pl.id);
    expect(updatedPl?.trackIds).toContain(saavnGlory.id);
    expect(updatedPl?.trackIds).not.toContain(ytGlory.id);
  });

  it('supports ~44-minute long tracks (e.g. Barsana Bali Radhey) and detects Funk vibe for feed suggestions', async () => {
    const { detectMusicVibe, processSmartYouTubeResults } = await import('../../src/audio/vibeClassifier');

    const longBhajan: Song = {
      id: 'youtube:barsana44min',
      providerId: 'youtube',
      providerTrackId: 'barsana44min',
      title: 'Barsana Bali Radhey',
      artist: 'Braj Ras',
      album: 'Radhey',
      durationMs: 44 * 60 * 1000, // 44 minutes (2,640,000 ms)
      addedAt: Date.now(),
    };

    const processed = await processSmartYouTubeResults([longBhajan], 'barsana bali radhey');
    expect(processed.map((s) => s.id)).toContain('youtube:barsana44min');

    const funkSong: Song = {
      id: 'spotify:funk1',
      providerId: 'spotify',
      providerTrackId: 'funk1',
      title: 'Montagem Funk Automotivo',
      artist: 'DJ Funk',
      album: 'Funk Mix',
      durationMs: 145_000,
      addedAt: Date.now(),
    };
    const vibe = detectMusicVibe(funkSong);
    expect(vibe.vibe).toBe('phonk');
    expect(vibe.genreLabel).toContain('Funk');
  });
});

