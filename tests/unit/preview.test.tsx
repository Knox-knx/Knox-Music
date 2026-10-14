// Preview-only regression tests (KNOX 30-second preview honesty).
//
// Preview-flagged tracks supply short preview URLs, never the full recording.
// These tests lock in: explicit previewOnly/streamType modeling, preview end
// behavior (no loop, no queue consumption, replay from 0:00), honest UI
// (Preview 30s — never the full duration), disabled offline/download
// actions, full-over-preview ranking, and unaffected full-stream providers.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Song } from '../../src/core/types';
import {
  PREVIEW_DURATION_MS,
  displayDurationFor,
  isPreviewSong,
  previewDurationFor,
  trackCapabilities,
  withCapabilities,
} from '../../src/providers/capabilities';
import { normalizeProviderCapabilities } from '../../src/providers/types';
import type { MusicProvider } from '../../src/providers/types';
import { getProviderManager } from '../../src/providers/ProviderManager';
import { rankSongs } from '../../src/search/ranking';
import { mergeAndRank } from '../../src/providers/merge';
import { clearSearchCache, runSearchPipeline } from '../../src/search/searchEngine';
import { sortSongs } from '../../src/providers/merge';
import { getAudioEngine } from '../../src/audio/AudioEngine';
import { usePlayer } from '../../src/audio/playerStore';
import { SongRow } from '../../src/ui/SongRow';
import { FullPlayer } from '../../src/ui/FullPlayer';
import { MiniPlayer, PlayerBar } from '../../src/ui/player';
import { useDownloads } from '../../src/downloads/DownloadManager';

// ---------- fixtures ----------

// Generic preview-flagged track (explicit previewOnly/streamType — never
// inferred from duration or provider id).
const previewTrack: Song = {
  id: 'preview-demo:1440833098',
  providerId: 'preview-demo',
  providerTrackId: '1440833098',
  title: 'Mi Gente',
  artist: 'J Balvin & Willy William',
  artists: ['J Balvin & Willy William'],
  album: 'Vibras',
  albumId: undefined,
  durationMs: 186000, // full commercial duration (metadata only)
  streamUrl: 'https://example.com/mi-gente-preview.m4a',
  downloadUrl: undefined,
  downloadAllowed: false,
  streamType: 'preview',
  previewOnly: true,
  previewDurationMs: 30000,
  artworkUrl: 'https://example.com/art-600.jpg',
  genre: undefined,
  year: undefined,
  license: 'Preview catalog metadata — previews streamable, no download/offline license',
  sourceUrl: 'https://example.com/track/mi-gente',
  capabilities: { searchable: true, streamable: true, downloadable: false, offline: false, previewOnly: true },
  addedAt: Date.now(),
};

const jamendoFull: Song = withCapabilities({
  id: 'jamendo:1278736',
  providerId: 'jamendo',
  providerTrackId: '1278736',
  title: 'Mi Gente',
  artist: 'J Balvin',
  artists: ['J Balvin'],
  album: 'Vibras',
  durationMs: 186000,
  streamUrl: 'https://example.com/mi-gente.mp3',
  downloadUrl: 'https://example.com/mi-gente-download.mp3',
  downloadAllowed: true,
  streamType: 'full',
  previewOnly: false,
  sourceUrl: 'https://www.jamendo.com/track/1278736',
  addedAt: Date.now(),
});

const queueB: Song = { ...jamendoFull, id: 'jamendo:b', providerTrackId: 'b', title: 'Song B' };
const queueC: Song = { ...jamendoFull, id: 'jamendo:c', providerTrackId: 'c', title: 'Song C' };

function stubProvider(id: string, opts: { supportsOffline: boolean; previewStream: boolean; previewOnlyCap?: boolean }): MusicProvider {
  return {
    id,
    name: id,
    capabilities: {
      supportsSearch: true, supportsStreaming: true, supportsOffline: opts.supportsOffline,
      supportsLyrics: false, supportsArtwork: true, supportsArtists: true, supportsAlbums: true,
      ...(opts.previewOnlyCap ? { previewOnly: true } : {}),
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
    getStream: async () => opts.previewStream
      ? {
        url: 'https://example.com/mi-gente-preview.m4a', mimeType: 'audio/mp4',
        quality: 'Preview (30s)', allowsOffline: false,
        previewOnly: true, streamType: 'preview' as const, previewDurationMs: 30000,
      }
      : {
        url: 'https://example.com/mi-gente.mp3', mimeType: 'audio/mpeg',
        quality: 'MP3 (Jamendo)', allowsOffline: true,
      },
    getArtwork: async () => null,
    getLyrics: async () => null,
  };
}

function engineAudioEl(): HTMLAudioElement {
  return (getAudioEngine() as unknown as { audio: HTMLAudioElement }).audio;
}

/** Pin the (jsdom-stubbed) media position so reset behavior is observable. */
function setAudioPosition(seconds: number): void {
  Object.defineProperty(engineAudioEl(), 'currentTime', {
    value: seconds, writable: true, configurable: true,
  });
}

function seedPlayer(over: Record<string, unknown> = {}): void {
  usePlayer.setState({
    queue: [previewTrack],
    index: 0,
    current: previewTrack,
    state: 'PLAYING',
    positionMs: 12000,
    durationMs: PREVIEW_DURATION_MS,
    volume: 0.8,
    muted: false,
    shuffle: false,
    repeat: 'OFF',
    error: null,
    previewEnded: false,
    ...over,
  } as never);
}

beforeEach(() => {
  clearSearchCache();
  const pm = getProviderManager();
  // preview-demo stub deliberately claims supportsOffline:true (mis-reporting) so
  // the explicit preview guard — not just provider flags — is exercised.
  if (!pm.get('preview-demo')) pm.register(stubProvider('preview-demo', { supportsOffline: true, previewStream: true }));
  if (!pm.get('jamendo')) pm.register(stubProvider('jamendo', { supportsOffline: true, previewStream: false }));
  pm.setEnabled('preview-demo', true);
  pm.setEnabled('jamendo', true);
  usePlayer.getState().hydrateFromEngine();
  vi.spyOn(getAudioEngine(), 'playUrl').mockResolvedValue(undefined);
  seedPlayer();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------- 1–3. capability model ----------

describe('preview-only capability model', () => {
  it('1. preview tracks are marked previewOnly with streamType preview', () => {
    expect(previewTrack.previewOnly).toBe(true);
    expect(previewTrack.streamType).toBe('preview');
    expect(previewTrack.capabilities).toMatchObject({
      searchable: true, streamable: true, downloadable: false, offline: false, previewOnly: true,
    });
    expect(previewTrack.durationMs).toBe(186000); // catalog metadata retained, not rewritten
  });

  it('2/3. preview tracks are not downloadable and not offline-capable', async () => {
    expect(previewTrack.downloadAllowed).toBe(false);
    expect(previewTrack.downloadUrl).toBeUndefined();
    const p = stubProvider('preview-demo', { supportsOffline: false, previewStream: true, previewOnlyCap: true });
    const caps = trackCapabilities(previewTrack, p);
    expect(caps.downloadable).toBe(false);
    expect(caps.offline).toBe(false);
    expect(caps.previewOnly).toBe(true);
    const normalized = normalizeProviderCapabilities(p.capabilities);
    expect(normalized).toMatchObject({
      search: true, metadata: true, streaming: true,
      downloads: false, offlineStorage: false, previewOnly: true,
    });
  });

  it('full-stream providers keep their actual capabilities (not forced to preview)', () => {
    expect(isPreviewSong(jamendoFull)).toBe(false);
    const caps = trackCapabilities(jamendoFull, getProviderManager().get('jamendo'));
    expect(caps).toMatchObject({ streamable: true, previewOnly: false });
    expect(withCapabilities(jamendoFull).capabilities?.previewOnly).toBe(false);
    // A short full-length track (5s) is still full — never inferred from duration.
    expect(isPreviewSong({ ...jamendoFull, durationMs: 5000 })).toBe(false);
    // Explicit flags are honored for any provider.
    expect(isPreviewSong({ ...jamendoFull, previewOnly: true })).toBe(true);
    expect(isPreviewSong({ ...jamendoFull, streamType: 'preview' })).toBe(true);
    expect(trackCapabilities({ ...jamendoFull, previewOnly: true }).previewOnly).toBe(true);
  });

  it('preview provider getStream() returns an explicit preview result', async () => {
    const p = stubProvider('preview-demo', { supportsOffline: false, previewStream: true });
    const stream = await p.getStream(previewTrack);
    expect(stream.url).toBe('https://example.com/mi-gente-preview.m4a');
    expect(stream.previewOnly).toBe(true);
    expect(stream.streamType).toBe('preview');
    expect(stream.previewDurationMs).toBe(30000);
    expect(stream.allowsOffline).toBe(false);
    expect(stream.downloadUrl).toBeUndefined();
    expect(stream.quality).toMatch(/preview/i);
  });
});

// ---------- 4–7. engine + store playback ----------

describe('preview playback behavior', () => {
  it('4/12. starting a preview resets currentTime to 0:00 (no inherited position)', async () => {
    setAudioPosition(77);
    await usePlayer.getState().playSong(previewTrack);
    expect(engineAudioEl().currentTime).toBe(0);
    expect(usePlayer.getState().positionMs).toBe(0);
    expect(usePlayer.getState().previewEnded).toBe(false);
    expect(getAudioEngine().isPreviewMode()).toBe(true);
  });

  it('13. switching preview → full stream also resets currentTime', async () => {
    setAudioPosition(25);
    await usePlayer.getState().playSong(jamendoFull);
    expect(engineAudioEl().currentTime).toBe(0);
    expect(usePlayer.getState().positionMs).toBe(0);
    expect(getAudioEngine().isPreviewMode()).toBe(false);
    // …and back full → preview.
    setAudioPosition(150);
    await usePlayer.getState().playSong(previewTrack);
    expect(engineAudioEl().currentTime).toBe(0);
    expect(getAudioEngine().isPreviewMode()).toBe(true);
  });

  it('5/7/9. preview ends at ~30s: no loop, no restart, queue untouched', async () => {
    usePlayer.setState({
      queue: [previewTrack, queueB, queueC], index: 0, current: previewTrack,
      state: 'PLAYING', repeat: 'OFF', previewEnded: false,
    } as never);
    const nextSpy = vi.spyOn(usePlayer.getState(), 'next');
    try {
      expect(engineAudioEl().loop).toBe(false);
      engineAudioEl().dispatchEvent(new Event('ended'));
      await waitFor(() => expect(usePlayer.getState().previewEnded).toBe(true));
      expect(nextSpy).not.toHaveBeenCalled();
      const s = usePlayer.getState();
      expect(s.index).toBe(0);
      expect(s.current?.id).toBe(previewTrack.id);
      expect(s.queue.map((q) => q.id)).toEqual([previewTrack.id, queueB.id, queueC.id]);
    } finally {
      nextSpy.mockRestore();
    }
  });

  it('preview end with repeat ONE still does not auto-advance', async () => {
    usePlayer.setState({
      queue: [previewTrack], index: 0, current: previewTrack,
      state: 'PLAYING', repeat: 'ONE', previewEnded: false,
    } as never);
    const nextSpy = vi.spyOn(usePlayer.getState(), 'next');
    try {
      engineAudioEl().dispatchEvent(new Event('ended'));
      await waitFor(() => expect(usePlayer.getState().previewEnded).toBe(true));
      expect(nextSpy).not.toHaveBeenCalled();
    } finally {
      nextSpy.mockRestore();
    }
  });

  it('6. pressing Play after preview end replays from 0:00', async () => {
    usePlayer.setState({
      queue: [previewTrack], index: 0, current: previewTrack,
      state: 'COMPLETED', previewEnded: true, positionMs: PREVIEW_DURATION_MS,
    } as never);
    setAudioPosition(29.5);
    await usePlayer.getState().toggle();
    expect(engineAudioEl().currentTime).toBe(0);
    expect(usePlayer.getState().positionMs).toBe(0);
    expect(usePlayer.getState().previewEnded).toBe(false);
  });

  it('manual Next after a preview end still works (user choice, not auto-consume)', async () => {
    usePlayer.setState({
      queue: [previewTrack, queueB], index: 0, current: previewTrack,
      state: 'COMPLETED', previewEnded: true,
    } as never);
    await usePlayer.getState().next();
    const s = usePlayer.getState();
    expect(s.index).toBe(1);
    expect(s.current?.id).toBe(queueB.id);
    expect(s.previewEnded).toBe(false);
  });

  it('11. full-stream tracks auto-advance on end (existing behavior preserved)', async () => {
    usePlayer.setState({
      queue: [jamendoFull], index: 0, current: jamendoFull,
      state: 'PLAYING', repeat: 'OFF', previewEnded: false,
    } as never);
    const nextSpy = vi.spyOn(usePlayer.getState(), 'next');
    try {
      engineAudioEl().dispatchEvent(new Event('ended'));
      await waitFor(() => expect(nextSpy).toHaveBeenCalledTimes(1));
      expect(usePlayer.getState().previewEnded).toBe(false);
    } finally {
      nextSpy.mockRestore();
    }
  });

  it('AudioEngine distinguishes FULL TRACK ENDED from PREVIEW ENDED', () => {
    const engine = getAudioEngine();
    const kinds: string[] = [];
    const off = engine.onEnded((k) => kinds.push(k));
    try {
      engine.setPreviewMode(false);
      engineAudioEl().dispatchEvent(new Event('ended'));
      engine.setPreviewMode(true);
      engineAudioEl().dispatchEvent(new Event('ended'));
      expect(kinds).toEqual(['full', 'preview']);
    } finally {
      off();
    }
  });

  it('AudioEngine.prepareForTrack pauses and resets to 0 without a new source', () => {
    setAudioPosition(42);
    getAudioEngine().prepareForTrack();
    expect(engineAudioEl().currentTime).toBe(0);
  });
});

// ---------- 8/10. honest durations + search stability ----------

describe('honest preview durations and playback stability', () => {
  it('8. preview playback never uses the full commercial duration', async () => {
    await usePlayer.getState().playSong(previewTrack);
    const s = usePlayer.getState();
    expect(s.durationMs).toBe(PREVIEW_DURATION_MS);
    expect(s.durationMs).not.toBe(previewTrack.durationMs);
    expect(displayDurationFor(previewTrack)).toBe(30000);
    expect(displayDurationFor(jamendoFull)).toBe(jamendoFull.durationMs);
    expect(previewDurationFor(previewTrack)).toBe(30000);
  });

  it('10. search / sort / cache changes never interrupt preview playback', () => {
    seedPlayer({ state: 'PLAYING', positionMs: 12000, previewEnded: false });
    const before = {
      currentId: usePlayer.getState().current?.id,
      state: usePlayer.getState().state,
      positionMs: usePlayer.getState().positionMs,
      previewEnded: usePlayer.getState().previewEnded,
    };
    const engine = getAudioEngine();
    const pause = vi.spyOn(engine, 'pause');
    const load = vi.spyOn(engine, 'load');
    const playUrl = vi.mocked(engine.playUrl);
    runSearchPipeline([queueB, previewTrack], 'Mi Gente');
    sortSongs([queueB, previewTrack], 'provider');
    sortSongs([queueB, previewTrack], 'title');
    clearSearchCache();
    const after = {
      currentId: usePlayer.getState().current?.id,
      state: usePlayer.getState().state,
      positionMs: usePlayer.getState().positionMs,
      previewEnded: usePlayer.getState().previewEnded,
    };
    expect(after).toEqual(before);
    expect(pause).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(playUrl).not.toHaveBeenCalled();
  });
});

// ---------- 9/14/15/16. ranking + UI ----------

describe('preview ranking and UI honesty', () => {
  it('exact full playable match outranks exact preview; preview stays visible', () => {
    const fullExact: Song = {
      ...jamendoFull, title: 'Mi Gente', artist: 'J Balvin',
      streamUrl: 'https://example.com/a.mp3', artworkUrl: 'https://example.com/a.jpg',
    };
    const previewExact: Song = {
      ...previewTrack,
      title: 'Mi Gente', artist: 'J Balvin',
      artworkUrl: 'https://example.com/b.jpg',
    };
    const ranked = rankSongs([previewExact, fullExact], 'Mi Gente J Balvin');
    expect(ranked).toHaveLength(2);
    expect(ranked[0].providerId).toBe('jamendo');
    expect(ranked[0].matchType).toBe('exact');
    expect(ranked[1].providerId).toBe('preview-demo');
    // Never hidden.
    expect(ranked.map((r) => r.providerId)).toContain('preview-demo');
  });

  it('mergeAndRank prefers full streams at equal relevance without hiding previews', () => {
    const full: Song = { ...jamendoFull, title: 'Faded', artist: 'Walker', artworkUrl: 'https://x/y.jpg' };
    const preview: Song = {
      ...previewTrack, title: 'Faded', artist: 'Walker',
      artworkUrl: 'https://x/y.jpg',
    };
    const merged = mergeAndRank([preview, full], 'faded');
    expect(merged).toHaveLength(2);
    expect(merged[0].providerId).toBe('jamendo');
    expect(merged[1].providerId).toBe('preview-demo');
  });

  it('14. SongRow shows "Preview 30s" and 0:30 (not the full 3:06) for previews', () => {
    render(<SongRow song={previewTrack} />);
    expect(screen.getByText('Preview 30s')).toBeInTheDocument();
    expect(screen.getByText('0:30')).toBeInTheDocument();
    expect(screen.queryByText('3:06')).not.toBeInTheDocument();
    expect(screen.getByTestId('song-row-play')).toHaveAttribute(
      'aria-label', expect.stringMatching(/preview/i),
    );
  });

  it('15. preview context menu offers Play Preview, no offline/download actions', async () => {
    render(<SongRow song={previewTrack} />);
    await userEvent.click(screen.getByTestId('song-row-menu-button'));
    const menu = await screen.findByTestId('song-context-menu');
    expect(menu).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /play preview/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /offline/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /download/i })).not.toBeInTheDocument();
    // …while honest favorites/playlist/details/source actions remain.
    expect(screen.getByRole('menuitem', { name: /favorite/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /add to playlist/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /song information/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /open source/i })).toBeInTheDocument();
  });

  it('full-stream rows keep "Available Offline" and the offline menu action', async () => {
    // Strict offline truth (§17): ONLY a live offlineRepo record counts —
    // the isOfflineAvailable flag alone must not produce the badge.
    const { offlineRepo } = await import('../../src/data/repositories');
    await offlineRepo.put(jamendoFull, new Blob(['x'.repeat(2000)], { type: 'audio/mpeg' }), 'High');
    try {
      const { unmount } = render(<SongRow song={jamendoFull} />);
      expect(await screen.findByText('Available Offline')).toBeInTheDocument();
      await userEvent.click(screen.getByTestId('song-row-menu-button'));
      await screen.findByTestId('song-context-menu');
      expect(screen.getByRole('menuitem', { name: /make available offline/i })).toBeInTheDocument();
      expect(screen.getByRole('menuitem', { name: /play$/i })).toBeInTheDocument();
      unmount();
      // Deleted file → badge disappears even though any stale flag may linger.
      await offlineRepo.remove(jamendoFull.id);
      const staleFlagged: Song = { ...jamendoFull, isOfflineAvailable: true };
      render(<SongRow song={staleFlagged} />);
      await waitFor(() => expect(screen.queryByText('Available Offline')).not.toBeInTheDocument());
    } finally {
      await offlineRepo.remove(jamendoFull.id).catch(() => undefined);
    }
  });

  it('search rows without a local file never show a fake "Available Offline"', async () => {
    render(<SongRow song={jamendoFull} />);
    expect(screen.queryByText('Available Offline')).not.toBeInTheDocument();
  });

  it('16. FullPlayer shows preview status + ended state, hides Offline for previews', async () => {
    usePlayer.setState({ current: previewTrack, previewEnded: true, positionMs: 30000, durationMs: 30000 } as never);
    const { unmount } = render(<FullPlayer onClose={() => undefined} />);
    expect(screen.getByLabelText('30-second preview')).toHaveTextContent(/preview 30s/i);
    expect(screen.getByRole('status')).toHaveTextContent(/preview ended/i);
    expect(screen.queryByRole('button', { name: /offline/i })).not.toBeInTheDocument();
    unmount();

    usePlayer.setState({ current: jamendoFull, previewEnded: false } as never);
    render(<FullPlayer onClose={() => undefined} />);
    expect(screen.queryByLabelText('30-second preview')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /offline/i })).toBeInTheDocument();
  });

  it('FullPlayer info tab shows preview length, not just the full duration', async () => {
    usePlayer.setState({ current: previewTrack, previewEnded: false, durationMs: 30000 } as never);
    render(<FullPlayer onClose={() => undefined} />);
    await userEvent.click(screen.getByRole('button', { name: /^info$/i }));
    expect(screen.getByText(/30-second preview/i)).toBeInTheDocument();
    expect(screen.getByText(/preview 0:30/i)).toBeInTheDocument();
  });

  it('PlayerBar and MiniPlayer badge preview playback', () => {
    usePlayer.setState({ current: previewTrack, previewEnded: false } as never);
    const { unmount } = render(<PlayerBar onExpand={() => undefined} onOpenQueue={() => undefined} />);
    expect(screen.getByLabelText('30-second preview')).toHaveTextContent(/preview 30s/i);
    unmount();
    render(<MiniPlayer onExpand={() => undefined} />);
    expect(screen.getByLabelText('30-second preview')).toHaveTextContent(/preview 30s/i);
  });
});

// ---------- downloads ----------

describe('preview download/offline guards', () => {
  it('DownloadManager.enqueue explicitly rejects previews', async () => {
    await expect(useDownloads.getState().enqueue(previewTrack)).rejects.toThrow(/preview.*offline/i);
  });
});
