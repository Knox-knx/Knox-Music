import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { usePlayer } from '../../src/audio/playerStore';
import { getAudioEngine } from '../../src/audio/AudioEngine';
import { ProviderManager } from '../../src/providers/ProviderManager';
import { ProviderError } from '../../src/core/errors';
import type { MusicProvider } from '../../src/providers/types';
import {
  runSearchPipeline,
  cachedSongs,
  clearSearchCache,
} from '../../src/search/searchEngine';
import { shouldDeferToOverlayHotkeys } from '../../src/App';
import { FullPlayer } from '../../src/ui/FullPlayer';
import { SongRow } from '../../src/ui/SongRow';
import type { Song } from '../../src/core/types';

function mkSong(id: string, title: string, artist: string): Song {
  return {
    id, providerId: 'jamendo', providerTrackId: id, title, artist,
    album: 'Album', durationMs: 180000, addedAt: 0,
  } as Song;
}

const songA = mkSong('jamendo:a', 'Mi Gente', 'J Balvin');
const songB = mkSong('freetouse:b', 'Faded Light', 'Alegend');
const songC = mkSong('airbeats:c', 'Kesariya', 'Arijit Singh');

function seedPlaying() {
  usePlayer.setState({
    queue: [songA, songB, songC],
    index: 0,
    current: songA,
    state: 'PLAYING',
    positionMs: 20000,
    durationMs: 180000,
    volume: 0.7,
    muted: false,
    shuffle: true,
    repeat: 'ALL',
    error: null,
    playSong: vi.fn(async () => undefined),
    addToQueue: vi.fn(),
  } as never);
}

function playerSnapshot() {
  const s = usePlayer.getState();
  return {
    currentId: s.current?.id,
    queueIds: s.queue.map((q) => q.id),
    index: s.index,
    state: s.state,
    positionMs: s.positionMs,
    volume: s.volume,
    muted: s.muted,
    shuffle: s.shuffle,
    repeat: s.repeat,
  };
}

function stubProvider(id: string, mode: 'ok' | 'throw' | 'hang'): MusicProvider {
  return {
    id,
    name: id,
    capabilities: {
      supportsSearch: true, supportsStreaming: true, supportsOffline: true,
      supportsLyrics: false, supportsArtwork: false, supportsArtists: true, supportsAlbums: true,
    },
    searchSongs: async (q: string) => {
      if (mode === 'throw') throw new ProviderError('NETWORK', `${id} down`);
      if (mode === 'hang') await new Promise(() => undefined);
      return [mkSong(`${id}:1`, `${q} result`, 'Someone')];
    },
    searchArtists: async () => [],
    searchAlbums: async () => [],
    searchPlaylists: async () => [],
    getSong: async () => null,
    getArtist: async () => null,
    getAlbum: async () => null,
    getPlaylist: async () => null,
    getAlbumTracks: async () => [],
    getStream: async () => { throw new ProviderError('UNSUPPORTED', 'no'); },
    getArtwork: async () => null,
    getLyrics: async () => null,
  };
}

function engineAudioEl(): HTMLAudioElement {
  return (getAudioEngine() as unknown as { audio: HTMLAudioElement }).audio;
}

beforeEach(() => {
  clearSearchCache();
  seedPlaying();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------- engine lifecycle ----------

describe('player engine stability', () => {
  it('audio engine is a stable singleton (never recreated per screen)', () => {
    expect(getAudioEngine()).toBe(getAudioEngine());
  });

  it('hydrateFromEngine is idempotent: COMPLETED advances the queue exactly once', async () => {
    usePlayer.getState().hydrateFromEngine();
    usePlayer.getState().hydrateFromEngine();
    usePlayer.setState({ queue: [songA], index: 0, current: songA, repeat: 'OFF' });
    const nextSpy = vi.spyOn(usePlayer.getState(), 'next');
    try {
      engineAudioEl().dispatchEvent(new Event('ended'));
      await waitFor(() => expect(nextSpy).toHaveBeenCalled());
      expect(nextSpy).toHaveBeenCalledTimes(1);
    } finally {
      nextSpy.mockRestore();
    }
  });
});

// ---------- search / provider ops never touch playback ----------

describe('search and provider failures never interrupt playback', () => {
  it('search pipeline + cache updates leave player state untouched', () => {
    const before = playerSnapshot();
    const engine = getAudioEngine();
    const pause = vi.spyOn(engine, 'pause');
    const load = vi.spyOn(engine, 'load');
    const playUrl = vi.spyOn(engine, 'playUrl');
    runSearchPipeline([songB, songC], 'Arijit Singh');
    runSearchPipeline([songA], 'Mi Gente');
    expect(cachedSongs('mi gente')).not.toBeNull();
    clearSearchCache();
    expect(playerSnapshot()).toEqual(before);
    expect(pause).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(playUrl).not.toHaveBeenCalled();
  });

  it('Jamendo / Archive / FreeToUse / AirBeats failures keep the music playing', async () => {
    const before = playerSnapshot();
    const engine = getAudioEngine();
    const pause = vi.spyOn(engine, 'pause');
    const pm = new ProviderManager(50);
    pm.register(stubProvider('jamendo', 'throw'));
    pm.register(stubProvider('internet-archive', 'hang'));
    pm.register(stubProvider('freetouse', 'throw'));
    pm.register(stubProvider('airbeats', 'throw'));
    const r = await pm.searchAll('Mi Gente', 'songs');
    expect(r.failures).toHaveLength(4);
    expect(r.items).toHaveLength(0);
    // Partial results still never replace the queue or current track.
    const pm2 = new ProviderManager(2000);
    pm2.register(stubProvider('jamendo', 'throw'));
    pm2.register(stubProvider('airbeats', 'ok'));
    const r2 = await pm2.searchAll('Tum Hi Ho', 'songs');
    expect(r2.failures).toEqual(['jamendo']);
    expect(r2.items).toHaveLength(1);
    expect(playerSnapshot()).toEqual(before);
    expect(pause).not.toHaveBeenCalled();
  });

  it('search abort and provider switching leave playback untouched', async () => {
    const before = playerSnapshot();
    const pm = new ProviderManager(2000);
    pm.register(stubProvider('jamendo', 'ok'));
    pm.register(stubProvider('airbeats', 'ok'));
    const controller = new AbortController();
    controller.abort();
    await pm.searchAll('Arijit Singh', 'songs', controller.signal).catch(() => undefined);
    pm.setEnabled('jamendo', false);
    await pm.searchAll('Tum Hi Ho', 'songs');
    await pm.searchAll('Tum Hi Ho', 'artists');
    pm.setEnabled('jamendo', true);
    await pm.searchAll('Chaleya', 'albums');
    expect(playerSnapshot()).toEqual(before);
  });

  it('window resize/scroll and menu open/close never pause or reset playback', async () => {
    const before = playerSnapshot();
    const engine = getAudioEngine();
    const pause = vi.spyOn(engine, 'pause');
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('scroll'));
    render(<SongRow song={songB} />);
    await userEvent.click(screen.getByTestId('song-row-menu-button'));
    await screen.findByTestId('song-context-menu');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('song-context-menu')).not.toBeInTheDocument();
    });
    expect(playerSnapshot()).toEqual(before);
    expect(pause).not.toHaveBeenCalled();
  });
});

// ---------- fullscreen overlay lifecycle ----------

describe('fullscreen overlay lifecycle', () => {
  it('no fullscreen overlay exists while FullPlayer is closed', () => {
    render(<SongRow song={songA} />);
    expect(document.querySelector('.now-playing')).toBeNull();
    expect(screen.queryByTestId('song-context-menu')).toBeNull();
  });

  it('closing FullPlayer completely removes its backdrop', async () => {
    const onClose = vi.fn();
    const { unmount } = render(<FullPlayer onClose={onClose} />);
    expect(document.querySelector('.now-playing')).not.toBeNull();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /close full player/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.querySelector('.now-playing')).toBeNull();
  });
});

// ---------- overlay-aware global hotkeys ----------

describe('shouldDeferToOverlayHotkeys', () => {
  it('defers inside menus and dialogs, not on plain content', () => {
    const { container } = render(
      <div>
        <div role="menu"><button data-testid="mi">item</button></div>
        <div role="dialog"><button data-testid="di">ok</button></div>
        <input data-testid="in" aria-label="x" />
      </div>,
    );
    expect(shouldDeferToOverlayHotkeys(container.querySelector('[data-testid="mi"]'))).toBe(true);
    expect(shouldDeferToOverlayHotkeys(container.querySelector('[data-testid="di"]'))).toBe(true);
    expect(shouldDeferToOverlayHotkeys(container.querySelector('[data-testid="in"]'))).toBe(true);
    expect(shouldDeferToOverlayHotkeys(document.body)).toBe(false);
    expect(shouldDeferToOverlayHotkeys(null)).toBe(false);
  });

  it('Space inside an open context menu does not reach the global play/pause toggle', async () => {
    const toggle = vi.fn(async () => undefined);
    usePlayer.setState({ toggle } as never);
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      const typing = t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
      if (typing) return;
      if (shouldDeferToOverlayHotkeys(e.target)) return;
      if (e.code === 'Space') void usePlayer.getState().toggle();
    };
    window.addEventListener('keydown', onKey);
    try {
      render(<SongRow song={songA} />);
      await userEvent.click(screen.getByTestId('song-row-menu-button'));
      const item = await screen.findByRole('menuitem', { name: /add to queue/i });
      item.focus();
      fireEvent.keyDown(item, { key: ' ', code: 'Space' });
      expect(toggle).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  });
});
