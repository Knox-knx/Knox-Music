// Radio Browser provider + radio player-mode tests.
// Radio shares the single AudioEngine; failures never destroy track state.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Song } from '../../src/core/types';
import {
  RadioBrowserProvider, mapStation, stationToSong, getRadioProvider,
} from '../../src/providers/radio/radioBrowser';
import type { RadioStation } from '../../src/providers/radio/types';
import { getAudioEngine } from '../../src/audio/AudioEngine';
import { usePlayer } from '../../src/audio/playerStore';
import { getProviderManager } from '../../src/providers/ProviderManager';
import { RadioScreen } from '../../src/screens/RadioScreen';
import { PlayerBar, MiniPlayer } from '../../src/ui/player';
import { FullPlayer } from '../../src/ui/FullPlayer';
import { runSearchPipeline, clearSearchCache } from '../../src/search/searchEngine';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

const API_STATION = {
  stationuuid: 'uuid-1', name: 'Test FM', url: 'http://example.com/stream', url_resolved: 'https://example.com/stream.mp3',
  homepage: 'https://example.com', favicon: 'https://example.com/logo.png',
  tags: 'pop,hits', country: 'India', countrycode: 'IN', language: 'hindi',
  codec: 'MP3', bitrate: 128, votes: 100, lastcheckok: 1,
};
const BROKEN_STATION = { ...API_STATION, stationuuid: 'uuid-broken', lastcheckok: 0 };
const URLLESS_STATION = { ...API_STATION, stationuuid: 'uuid-nourl', url: '', url_resolved: '' };

const station: RadioStation = {
  id: 'radio-browser:uuid-1', providerId: 'radio-browser', stationUuid: 'uuid-1',
  name: 'Test FM', streamUrl: 'https://example.com/stream.mp3', country: 'India',
  countryCode: 'IN', language: 'hindi', tags: ['pop', 'hits'],
  codec: 'MP3', bitrate: 128, votes: 100, lastCheckOk: true,
};

const trackSong: Song = {
  id: 'jamendo:1', providerId: 'jamendo', providerTrackId: '1',
  title: 'Normal Song', artist: 'Someone', album: 'Album', durationMs: 180000, addedAt: 0,
};

function engineAudioEl(): HTMLAudioElement {
  return (getAudioEngine() as unknown as { audio: HTMLAudioElement }).audio;
}

beforeEach(() => {
  clearSearchCache();
  usePlayer.getState().hydrateFromEngine();
  vi.spyOn(getAudioEngine(), 'playUrl').mockResolvedValue(undefined);
  // Stub playable provider so playSong(trackSong) resolves a fresh stream
  // (resolve-first flow preserves radio mode only on failure — success must
  // leave radio mode, which this stub guarantees deterministically).
  const pm = getProviderManager();
  if (!pm.get('jamendo')) {
    pm.register({
      id: 'jamendo', name: 'Jamendo',
      capabilities: {
        supportsSearch: true, supportsStreaming: true, supportsOffline: true,
        supportsLyrics: false, supportsArtwork: true, supportsArtists: true, supportsAlbums: true,
      },
      searchSongs: async () => [], searchArtists: async () => [], searchAlbums: async () => [],
      searchPlaylists: async () => [], getSong: async () => null,
      getArtist: async () => null, getAlbum: async () => null, getPlaylist: async () => null,
      getAlbumTracks: async () => [],
      getStream: async () => ({ url: 'https://example.com/normal.mp3', mimeType: 'audio/mpeg', quality: 'MP3', allowsOffline: false }),
      getArtwork: async () => null, getLyrics: async () => null,
    });
  }
  pm.setEnabled('jamendo', true);
  usePlayer.setState({
    queue: [trackSong], index: 0, current: trackSong, state: 'PLAYING',
    positionMs: 20000, durationMs: 180000, playerMode: 'track',
    currentStation: null, previewEnded: false, error: null, repeat: 'OFF',
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('RadioBrowserProvider', () => {
  it('maps records and filters broken / unplayable stations by default', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([API_STATION, BROKEN_STATION, URLLESS_STATION])));
    const list = await new RadioBrowserProvider().searchStations('test');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Test FM', country: 'India', bitrate: 128, lastCheckOk: true });
    expect(list[0].tags).toEqual(['pop', 'hits']);
  });

  it('maps null for records that can never play', () => {
    expect(mapStation({})).toBeNull();
    expect(mapStation({ stationuuid: 'x' })).toBeNull();
    expect(mapStation(API_STATION)?.id).toBe('radio-browser:uuid-1');
  });

  it('queries popular / country / language / tag endpoints', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (u: unknown) => { urls.push(String(u)); return jsonResponse([]); }));
    const p = new RadioBrowserProvider();
    await p.getPopularStations();
    await p.getStationsByCountry('India');
    await p.getStationsByLanguage('hindi');
    await p.getStationsByTag('jazz');
    expect(urls[0]).toContain('/json/stations/topvote/20');
    expect(urls[1]).toContain('/json/stations/bycountry/India');
    expect(urls[2]).toContain('/json/stations/bylanguage/hindi');
    expect(urls[3]).toContain('/json/stations/bytag/jazz');
    expect(await p.searchStations('  ')).toEqual([]);
  });

  it('checkStation reflects lastcheckok and never throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([API_STATION])));
    expect(await new RadioBrowserProvider().checkStation(station)).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await new RadioBrowserProvider().checkStation(station)).toBe(false);
  });

  it('getPlayableUrl prefers the resolve endpoint, falls back honestly', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ url: 'https://cdn.example.com/live.aac' })));
    expect(await new RadioBrowserProvider().getPlayableUrl(station)).toBe('https://cdn.example.com/live.aac');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    expect(await new RadioBrowserProvider().getPlayableUrl(station)).toBe(station.streamUrl);
    await expect(new RadioBrowserProvider().getPlayableUrl({ ...station, streamUrl: '' }))
      .rejects.toThrow(/unavailable/i);
  });

  it('stationToSong carries no duration and no offline rights', () => {
    const view = stationToSong(station);
    expect(view.durationMs).toBe(0);
    expect(view.downloadAllowed).toBe(false);
    expect(view.capabilities).toMatchObject({ streamable: true, downloadable: false, offline: false });
  });

  it('provider failures reject (isolation handled by callers)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    await expect(new RadioBrowserProvider().getPopularStations()).rejects.toThrow();
  });
});

describe('radio player mode (single AudioEngine)', () => {
  it('playStation switches to radio with LIVE state on the same engine', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ url: 'https://cdn.example.com/live.aac' })));
    const engine = getAudioEngine();
    await usePlayer.getState().playStation(station);
    const s = usePlayer.getState();
    expect(s.playerMode).toBe('radio');
    expect(s.currentStation?.id).toBe(station.id);
    expect(s.current?.title).toBe('Test FM');
    expect(s.durationMs).toBe(0);
    expect(s.positionMs).toBe(0);
    expect(s.previewEnded).toBe(false);
    expect(s.qualityLabel).toMatch(/live/i);
    expect(engine).toBe(getAudioEngine());
  });

  it('station failure preserves the previous track state untouched', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    await usePlayer.getState().playStation({ ...station, streamUrl: '' });
    const s = usePlayer.getState();
    expect(s.error).toMatch(/unavailable/i);
    expect(s.playerMode).toBe('track');
    expect(s.current?.id).toBe(trackSong.id);
    expect(s.positionMs).toBe(20000);
  });

  it('playSong leaves radio mode; stopRadio pauses without destroying state', async () => {
    usePlayer.setState({ playerMode: 'radio', currentStation: station } as never);
    await usePlayer.getState().playSong(trackSong);
    expect(usePlayer.getState().playerMode).toBe('track');
    expect(usePlayer.getState().currentStation).toBeNull();

    usePlayer.setState({ playerMode: 'radio', currentStation: station } as never);
    usePlayer.getState().stopRadio();
    expect(usePlayer.getState().playerMode).toBe('track');
    expect(usePlayer.getState().currentStation).toBeNull();
  });

  it('radio COMPLETED never consumes the queue', async () => {
    usePlayer.setState({
      queue: [trackSong], index: 0, current: stationToSong(station),
      playerMode: 'radio', currentStation: station, state: 'PLAYING',
    } as never);
    const nextSpy = vi.spyOn(usePlayer.getState(), 'next');
    try {
      engineAudioEl().dispatchEvent(new Event('ended'));
      await new Promise((r) => setTimeout(r, 25));
      expect(nextSpy).not.toHaveBeenCalled();
      expect(usePlayer.getState().playerMode).toBe('radio');
      expect(usePlayer.getState().queue).toHaveLength(1);
    } finally {
      nextSpy.mockRestore();
    }
  });

  it('seek is a no-op for live radio (never fakes progress)', () => {
    usePlayer.setState({ playerMode: 'radio', currentStation: station, positionMs: 0 } as never);
    usePlayer.getState().seek(60000);
    expect(usePlayer.getState().positionMs).toBe(0);
  });

  it('search and provider ops never disturb radio playback', () => {
    usePlayer.setState({
      playerMode: 'radio', currentStation: station, current: stationToSong(station),
      state: 'PLAYING', positionMs: 45000,
    } as never);
    const engine = getAudioEngine();
    const pause = vi.spyOn(engine, 'pause');
    const load = vi.spyOn(engine, 'load');
    runSearchPipeline([trackSong], 'Someone');
    clearSearchCache();
    const s = usePlayer.getState();
    expect(s.playerMode).toBe('radio');
    expect(s.currentStation?.id).toBe(station.id);
    expect(s.positionMs).toBe(45000);
    expect(pause).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
  });
});

describe('radio UI', () => {
  it('RadioScreen lists stations and plays one (LIVE card)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
      const url = String(u);
      if (url.includes('/json/url/')) return jsonResponse({ url: 'https://cdn.example.com/live.aac' });
      return jsonResponse([API_STATION]);
    }));
    render(<RadioScreen />);
    const card = await screen.findByTestId('station-card');
    expect(card).toBeInTheDocument();
    expect(screen.getByText('Test FM')).toBeInTheDocument();
    expect(screen.getByLabelText('Live')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('station-play'));
    await waitFor(() => expect(usePlayer.getState().playerMode).toBe('radio'));
  });

  it('PlayerBar and MiniPlayer show LIVE instead of durations', () => {
    usePlayer.setState({
      playerMode: 'radio', currentStation: station, current: stationToSong(station),
    } as never);
    const { unmount } = render(<PlayerBar onExpand={() => undefined} onOpenQueue={() => undefined} />);
    expect(screen.getByLabelText('Live radio')).toBeInTheDocument();
    expect(screen.queryByLabelText('Seek')).not.toBeInTheDocument();
    unmount();
    render(<MiniPlayer onExpand={() => undefined} />);
    expect(screen.getAllByLabelText('Live')[0]).toBeInTheDocument();
  });

  it('FullPlayer replaces progress with LIVE and reports live playback', () => {
    usePlayer.setState({
      playerMode: 'radio', currentStation: station, current: stationToSong(station),
      durationMs: 0, positionMs: 0,
    } as never);
    render(<FullPlayer onClose={() => undefined} />);
    expect(screen.getByLabelText('Live radio')).toBeInTheDocument();
    expect(screen.queryByLabelText('Seek')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /offline/i })).not.toBeInTheDocument();
  });

  it('getRadioProvider is a singleton', () => {
    expect(getRadioProvider()).toBe(getRadioProvider());
  });
});
