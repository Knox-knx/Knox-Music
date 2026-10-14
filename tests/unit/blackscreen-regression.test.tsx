// Black-screen regression tests (KNOX Search → Play → FullPlayer incident).
//
// ROOT CAUSE (fixed): two Rules-of-Hooks violations crashed React's renderer
// the moment playback started, unmounting the whole tree (blank dark WebView)
// while the singleton AudioEngine kept playing audio outside React:
//   1. SongRow called `usePlayer((s) => s.state)` conditionally behind
//      `isCurrent && ...` — the row that started playing rendered MORE hooks
//      than before → React threw during the current=null → song transition.
//   2. FullPlayer called `usePlayer(playerMode/currentStation)` AFTER
//      `if (!current) return null` — a current→null render had FEWER hooks →
//      "Rendered fewer hooks than expected".
// These tests lock the corrected lifecycle: transitions never throw, the
// player mounts/unmounts repeatedly, failures preserve UI state, and an
// ErrorBoundary guarantees no future render exception can blank the app.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { usePlayer } from '../../src/audio/playerStore';
import { getAudioEngine } from '../../src/audio/AudioEngine';
import { getProviderManager } from '../../src/providers/ProviderManager';
import type { MusicProvider } from '../../src/providers/types';
import { SongRow, artworkPlaceholderFor } from '../../src/ui/SongRow';
import { FullPlayer } from '../../src/ui/FullPlayer';
import { ErrorBoundary } from '../../src/ui/ErrorBoundary';
import type { Song } from '../../src/core/types';

function mkSong(id: string, over: Partial<Song> = {}): Song {
  return {
    id, providerId: 'jamendo', providerTrackId: id, title: 'Soch Na Sake',
    artist: 'Arijit Singh', album: 'Airlift', durationMs: 180000, addedAt: 0,
    ...over,
  } as Song;
}

const songA = mkSong('jamendo:a', { title: 'Soch Na Sake' });
const songB = mkSong('airbeats:b', { providerId: 'airbeats', title: 'Kesariya' });

function stubStreamProvider(
  id: string,
  opts: { streaming: boolean; failStream?: boolean },
): MusicProvider {
  return {
    id,
    name: id,
    capabilities: {
      supportsSearch: true,
      supportsStreaming: opts.streaming,
      supportsOffline: true,
      supportsLyrics: false,
      supportsArtwork: true,
      supportsArtists: true,
      supportsAlbums: true,
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
    getStream: async () => {
      if (opts.failStream) throw new Error('no stream');
      return { url: 'https://example.com/audio.mp3', mimeType: 'audio/mpeg', quality: 'MP3', allowsOffline: true };
    },
    getArtwork: async () => null,
    getLyrics: async () => null,
  };
}

function engineInternals(): { listeners: Set<unknown>; posListeners: Set<unknown> } {
  return getAudioEngine() as unknown as { listeners: Set<unknown>; posListeners: Set<unknown> };
}

beforeEach(() => {
  const pm = getProviderManager();
  if (!pm.get('jamendo')) pm.register(stubStreamProvider('jamendo', { streaming: true }));
  if (!pm.get('airbeats')) pm.register(stubStreamProvider('airbeats', { streaming: true }));
  if (!pm.get('youtube-music')) pm.register(stubStreamProvider('youtube-music', { streaming: false }));
  pm.setEnabled('jamendo', true);
  pm.setEnabled('airbeats', true);
  pm.setEnabled('youtube-music', true);
  usePlayer.getState().hydrateFromEngine();
  vi.spyOn(getAudioEngine(), 'playUrl').mockResolvedValue(undefined);
  vi.spyOn(getAudioEngine(), 'loadTempSource').mockResolvedValue(undefined);
  vi.spyOn(getAudioEngine(), 'play').mockResolvedValue(undefined);
  vi.spyOn(getAudioEngine(), 'awaitClockAdvance').mockResolvedValue(true);
  URL.createObjectURL = vi.fn(() => `blob:mock-${Math.random().toString(36).slice(2)}`) as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn() as unknown as typeof URL.revokeObjectURL;
  // Offline/network-dependent lyrics must fail fast and deterministically —
  // but the Temporary Playback Buffer's download of the stub provider URL
  // (example.com/audio*) must succeed with valid audio bytes.
  const audioBytes = new Uint8Array(8192).fill(0x61);
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    if (typeof url === 'string' && url.includes('example.com/audio')) {
      return new Response(audioBytes, { status: 200, headers: { 'content-type': 'audio/mpeg' } });
    }
    throw new Error('offline');
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------- 1. the exact crash transition ----------

describe('hook-order crash transitions (root cause)', () => {
  it('1. SongRow survives current null → song (Search → Play)', () => {
    usePlayer.setState({ queue: [], index: -1, current: null, state: 'IDLE' } as never);
    const { unmount } = render(<SongRow song={songA} />);
    expect(screen.getByTestId('song-row-play')).toBeInTheDocument();
    act(() => {
      usePlayer.setState({ queue: [songA], index: 0, current: songA, state: 'PLAYING' } as never);
    });
    // Before the fix this threw inside React hook machinery and unmounted everything.
    expect(screen.getByTestId('song-row-play')).toBeInTheDocument();
    expect(screen.getByTestId('song-row-play')).toHaveAttribute('aria-label', expect.stringMatching(/play/i));
    unmount();
  });

  it('2. SongRow survives song → other song → null (next/track change/clear)', () => {
    usePlayer.setState({ queue: [songA], index: 0, current: songA, state: 'PLAYING' } as never);
    const { unmount } = render(
      <div>
        <SongRow song={songA} />
        <SongRow song={songB} />
      </div>,
    );
    act(() => {
      usePlayer.setState({ queue: [songA, songB], index: 1, current: songB, state: 'PLAYING' } as never);
    });
    expect(screen.getAllByTestId('song-row-play')).toHaveLength(2);
    act(() => {
      usePlayer.setState({ current: null, state: 'IDLE' } as never);
    });
    expect(screen.getAllByTestId('song-row-play')).toHaveLength(2);
    unmount();
  });

  it('3. FullPlayer current set → null → set renders null gracefully (no hook-count throw)', () => {
    usePlayer.setState({
      queue: [songA], index: 0, current: songA, state: 'PLAYING',
      positionMs: 1000, durationMs: 180000,
    } as never);
    const { unmount } = render(<FullPlayer onClose={() => undefined} />);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    act(() => {
      usePlayer.setState({ current: null } as never);
    });
    // Fixed component returns null — it never throws "Rendered fewer hooks".
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    act(() => {
      usePlayer.setState({ current: songA, state: 'PLAYING' } as never);
    });
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    unmount();
  });
});

// ---------- 2. mount/unmount idempotence ----------

describe('FullPlayer mount lifecycle', () => {
  it('4. FullPlayer mounts/unmounts repeatedly with no leftover backdrop', async () => {
    for (let i = 0; i < 5; i++) {
      usePlayer.setState({
        queue: [songA], index: 0, current: songA, state: 'PLAYING',
        positionMs: i * 1000, durationMs: 180000,
      } as never);
      const { unmount } = render(<FullPlayer onClose={() => undefined} />);
      expect(screen.getByRole('dialog', { name: /now playing/i })).toBeInTheDocument();
      expect(document.querySelector('.now-playing')).not.toBeNull();
      unmount();
      expect(document.querySelector('.now-playing')).toBeNull();
    }
  });

  it('5. closing FullPlayer via ✕ removes its backdrop (no invisible overlay)', async () => {
    usePlayer.setState({ queue: [songA], index: 0, current: songA, state: 'PLAYING' } as never);
    const onClose = vi.fn();
    const { unmount } = render(<FullPlayer onClose={onClose} />);
    await userEvent.click(screen.getByRole('button', { name: /close full player/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();
    expect(document.querySelector('.now-playing')).toBeNull();
  });
});

// ---------- 3. singleton + subscription stability ----------

describe('engine singleton and subscription stability', () => {
  it('6. AudioEngine remains a singleton', () => {
    expect(getAudioEngine()).toBe(getAudioEngine());
  });

  it('7. repeated hydrateFromEngine + state updates create no duplicate subscriptions', async () => {
    usePlayer.getState().hydrateFromEngine();
    usePlayer.getState().hydrateFromEngine();
    usePlayer.getState().hydrateFromEngine();
    // White-box: exactly one state + one position listener, no matter how
    // often hydration or renders ran (duplicates used to double-fire ended).
    expect(engineInternals().listeners.size).toBe(1);
    expect(engineInternals().posListeners.size).toBe(1);
    usePlayer.setState({ queue: [songA], index: 0, current: songA, repeat: 'OFF' } as never);
    const nextSpy = vi.spyOn(usePlayer.getState(), 'next');
    try {
      (getAudioEngine() as unknown as { audio: HTMLAudioElement }).audio.dispatchEvent(new Event('ended'));
      await waitFor(() => expect(nextSpy).toHaveBeenCalled());
      expect(nextSpy).toHaveBeenCalledTimes(1);
    } finally {
      nextSpy.mockRestore();
    }
  });

  it('8. resize while playing does not destroy player rendering or state', () => {
    const before = {
      id: usePlayer.getState().current?.id,
      state: usePlayer.getState().state,
    };
    usePlayer.setState({ queue: [songA], index: 0, current: songA, state: 'PLAYING' } as never);
    render(<FullPlayer onClose={() => undefined} />);
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText('Soch Na Sake')).toBeInTheDocument();
    expect(usePlayer.getState().current?.id).toBe(before.id ?? songA.id);
  });
});

// ---------- 4. playSong success/failure UI state ----------

describe('playSong UI-state preservation', () => {
  it('9. playSong success commits current without corrupting UI state', async () => {
    usePlayer.setState({ queue: [], index: -1, current: null, state: 'IDLE', error: null } as never);
    const { unmount } = render(<SongRow song={songA} />);
    const ok = await usePlayer.getState().playSong(songA);
    expect(ok).toBe(true);
    expect(usePlayer.getState().current?.id).toBe(songA.id);
    // Search rows stay mounted and functional after successful playback.
    expect(screen.getByTestId('song-row-play')).toBeInTheDocument();
    unmount();
    // FullPlayer opens onto the committed track with all controls.
    const { unmount: un2 } = render(<FullPlayer onClose={() => undefined} />);
    expect(screen.getByText('Soch Na Sake')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^play$|^pause$/i })).toBeInTheDocument();
    un2();
  });

  it('10. playSong failure preserves previous track/UI state', async () => {
    const failing = mkSong('jamendo:missing', { providerId: 'jamendo' });
    const pm = getProviderManager();
    pm.register(stubStreamProvider('jamendo-fail', { streaming: true, failStream: true }), false);
    const bad = { ...failing, providerId: 'jamendo-fail' };
    usePlayer.setState({
      queue: [songA], index: 0, current: songA, state: 'PLAYING',
      positionMs: 5000, durationMs: 180000, error: null,
    } as never);
    const ok = await usePlayer.getState().playSong(bad);
    expect(ok).toBe(false);
    // Previous track untouched — the UI never navigates to a blank player.
    expect(usePlayer.getState().current?.id).toBe(songA.id);
    expect(usePlayer.getState().positionMs).toBe(5000);
    expect(usePlayer.getState().error).toMatch(/unable to play/i);
  });

  it('11. YouTube Music discovery-only playback stays blocked, current untouched', async () => {
    const disco = mkSong('youtube-music:vid123', { providerId: 'youtube-music' });
    usePlayer.setState({
      queue: [songA], index: 0, current: songA, state: 'PLAYING', error: null,
    } as never);
    const ok = await usePlayer.getState().playSong(disco);
    expect(ok).toBe(false);
    expect(usePlayer.getState().current?.id).toBe(songA.id);
    expect(usePlayer.getState().error).toMatch(/discovery/i);
  });

  it('12. playable providers (airbeats) still play', async () => {
    const ok = await usePlayer.getState().playSong(songB);
    expect(ok).toBe(true);
    expect(usePlayer.getState().current?.id).toBe(songB.id);
  });
});

// ---------- 5. artwork / lyrics failure tolerance ----------

describe('artwork and lyrics failure tolerance', () => {
  it('13. broken artwork URL falls back without destroying FullPlayer', () => {
    const broken = mkSong('jamendo:broken', { artworkUrl: 'https://invalid.example/broken.jpg' });
    usePlayer.setState({
      queue: [broken], index: 0, current: broken, state: 'PLAYING',
      positionMs: 0, durationMs: 180000,
    } as never);
    render(<FullPlayer onClose={() => undefined} />);
    const img = screen.getByAltText(/artwork/i) as HTMLImageElement;
    fireEvent.error(img);
    // Single-shot fallback to the generated placeholder (no retry loop).
    expect(img.src.startsWith('data:image/svg+xml')).toBe(true);
    expect(img.dataset.fbk).toBe('1');
    fireEvent.error(img);
    expect(img.src.startsWith('data:image/svg+xml')).toBe(true);
    // Title/artist/controls all remain visible.
    expect(screen.getByText('Soch Na Sake')).toBeInTheDocument();
    expect(screen.getByText('Arijit Singh')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^play$|^pause$/i })).toBeInTheDocument();
  });

  it('14. placeholder generator is deterministic and self-contained', () => {
    const p1 = artworkPlaceholderFor({ title: 'Soch Na Sake' });
    const p2 = artworkPlaceholderFor({ title: 'Soch Na Sake' });
    expect(p1).toBe(p2);
    expect(p1.startsWith('data:image/svg+xml')).toBe(true);
  });

  it('15. lyrics API failure still renders title/artist/controls', async () => {
    usePlayer.setState({
      queue: [songA], index: 0, current: songA, state: 'PLAYING',
      positionMs: 0, durationMs: 180000,
    } as never);
    render(<FullPlayer onClose={() => undefined} />);
    // Two "Lyrics" buttons exist (tab chip + toolbar shortcut) — either
    // opens the lyrics tab.
    const lyricsBtns = screen.getAllByRole('button', { name: /^lyrics$/i });
    expect(lyricsBtns.length).toBeGreaterThan(0);
    await userEvent.click(lyricsBtns[0]);
    // fetch was stubbed to reject — the player must show the honest empty
    // state, never disappear.
    await waitFor(() => {
      expect(screen.queryByText(/lyrics aren.t available/i)).toBeInTheDocument();
    });
    expect(screen.getByText('Soch Na Sake')).toBeInTheDocument();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    // Switching back to Controls restores transport.
    const controlsBtns = screen.getAllByRole('button', { name: /^controls$/i });
    await userEvent.click(controlsBtns[0]);
    expect(screen.getByRole('button', { name: /^play$|^pause$/i })).toBeInTheDocument();
  });
});

// ---------- 6. error boundary ----------

describe('ErrorBoundary contains render failures', () => {
  it('16. a throwing view shows the KNOX error card, never a blank screen', async () => {
    const Boom = (): React.ReactNode => {
      throw new Error('boom');
    };
    const { container } = render(
      <ErrorBoundary area="test-view">
        <div>shell</div>
        <Boom />
      </ErrorBoundary>,
    );
    expect(
      await screen.findByText('KNOX Music encountered a rendering error'),
    ).toBeInTheDocument();
    // The boundary renders a visible card — the root is never blank.
    expect(container.textContent).not.toBe('');
    expect(screen.getByRole('button', { name: /retry this view/i })).toBeInTheDocument();
  });
});
