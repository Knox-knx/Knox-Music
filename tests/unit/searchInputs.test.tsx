// Search-input regression tests (§§14–20).
//
// Every search/filter text field must accept keyboard input and update its
// React state — provider loading/failure must never disable the field, the
// input DOM node must stay mounted while typing (no key-remount), and the
// global hotkey system must defer to text entry (input/textarea/select/
// contenteditable) and to open menus/dialogs.

import React, { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TopBar } from '../../src/ui/navigation';
import { YouTubeScreen } from '../../src/screens/YouTubeScreen';
import { RadioScreen } from '../../src/screens/RadioScreen';
import { LibraryScreen } from '../../src/screens/LibraryScreen';
import { PlaylistsScreen } from '../../src/screens/PlaylistsScreen';
import {
  isTypingTarget,
  shouldDeferToOverlayHotkeys,
  createGlobalHotkeyHandler,
  GLOBAL_SEARCH_INPUT_ID,
} from '../../src/App';
import { getProviderManager } from '../../src/providers/ProviderManager';
import type { MusicProvider } from '../../src/providers/types';
import type { Song } from '../../src/core/types';
import { usePlayer } from '../../src/audio/playerStore';

function mkSong(id: string, title: string, artist: string): Song {
  return {
    id, providerId: 'youtube', providerTrackId: id, title, artist,
    album: 'Album', durationMs: 180000, addedAt: 0,
  } as Song;
}

function stubProvider(id: string, searchSongs: MusicProvider['searchSongs']): void {
  const pm = getProviderManager();
  if (!pm.get(id)) {
    pm.register({
      id,
      name: id,
      capabilities: {
        supportsSearch: true, supportsStreaming: true, supportsOffline: false,
        supportsLyrics: false, supportsArtwork: true, supportsArtists: false, supportsAlbums: false,
      },
      searchSongs,
      searchArtists: async () => [],
      searchAlbums: async () => [],
      searchPlaylists: async () => [],
      getSong: async () => null,
      getArtist: async () => null,
      getAlbum: async () => null,
      getPlaylist: async () => null,
      getAlbumTracks: async () => [],
      getStream: async () => ({ url: 'https://example.com/a.mp3', mimeType: 'audio/mpeg', quality: 'MP3', allowsOffline: false }),
      getArtwork: async () => null,
      getLyrics: async () => null,
    });
  }
  pm.setEnabled(id, true);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  });
}

const API_STATION = {
  stationuuid: 'uuid-1', name: 'BBC Test', url: 'https://example.com/stream', url_resolved: 'https://example.com/stream.mp3',
  homepage: 'https://example.com', favicon: '', tags: 'news,talk', country: 'United Kingdom',
  countrycode: 'GB', language: 'english', codec: 'MP3', bitrate: 128, votes: 10, lastcheckok: 1,
};

function TopBarHarness() {
  const [q, setQ] = useState('');
  return <TopBar query={q} setQuery={setQ} onOpenSettings={() => undefined} offlineMode={false} />;
}

beforeEach(() => {
  stubProvider('youtube', async (q: string) => [mkSong('youtube:1', `${q} result`, 'Someone')]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('main search (TopBar) accepts typing', () => {
  it('type("radhe radhe") → value === "radhe radhe"', async () => {
    const user = userEvent.setup();
    render(<TopBarHarness />);
    const input = screen.getByLabelText('Search songs, artists, albums') as HTMLInputElement;
    await user.click(input);
    await user.type(input, 'radhe radhe');
    expect(input.value).toBe('radhe radhe');
  });

  it('backspace, select-all replace, paste, and Enter keep the field usable', async () => {
    const user = userEvent.setup();
    render(<TopBarHarness />);
    const input = screen.getByLabelText('Search songs, artists, albums') as HTMLInputElement;
    await user.click(input);
    await user.type(input, 'radhe radhe');
    // Backspace removes the last character.
    await user.type(input, '{Backspace}');
    expect(input.value).toBe('radhe radh');
    // Select-all + type replaces the whole query (keyboard() types into the
    // focused field without clicking, so the selection survives).
    input.focus();
    input.setSelectionRange(0, input.value.length);
    await user.keyboard('alan walker');
    expect(input.value).toBe('alan walker');
    // Clearing + paste works.
    await user.clear(input);
    expect(input.value).toBe('');
    await user.click(input);
    await user.paste('shape of you');
    expect(input.value).toBe('shape of you');
    // Enter commits (blurs) without losing the query.
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('shape of you');
  });

  it('input DOM node is stable while typing (never recreated)', async () => {
    const user = userEvent.setup();
    render(<TopBarHarness />);
    const first = screen.getByLabelText('Search songs, artists, albums');
    await user.type(first, 'radhe radhe');
    expect(screen.getByLabelText('Search songs, artists, albums')).toBe(first);
    expect(document.activeElement).toBe(first);
  });

  it('field is never disabled or read-only', () => {
    render(<TopBarHarness />);
    const input = screen.getByLabelText('Search songs, artists, albums') as HTMLInputElement;
    expect(input).not.toBeDisabled();
    expect(input.readOnly).toBe(false);
  });
});

describe('YouTube search accepts typing', () => {
  it('type("shape of you") → value === "shape of you"', async () => {
    const user = userEvent.setup();
    render(<YouTubeScreen onOpenAlbum={() => undefined} onOpenArtist={() => undefined} />);
    const input = screen.getByLabelText('Search YouTube') as HTMLInputElement;
    await user.click(input);
    await user.type(input, 'shape of you');
    expect(input.value).toBe('shape of you');
  });

  it('input stays mounted, focused, and enabled while a search is loading', async () => {
    let release!: (v: Song[]) => void;
    const gate = new Promise<Song[]>((res) => { release = res; });
    const pm = getProviderManager();
    const provider = pm.get('youtube')!;
    const spy = vi.spyOn(provider, 'searchSongs').mockReturnValue(gate);
    try {
      const user = userEvent.setup();
      render(<YouTubeScreen onOpenAlbum={() => undefined} onOpenArtist={() => undefined} />);
      const input = screen.getByLabelText('Search YouTube') as HTMLInputElement;
      const node = input;
      await user.type(input, 'shape of you');
      // Debounced search starts → skeleton shows, but the field must NOT
      // become disabled and must NOT lose focus or be recreated.
      await waitFor(() => expect(screen.getByLabelText('Loading results')).toBeInTheDocument());
      expect(input).not.toBeDisabled();
      expect(input.value).toBe('shape of you');
      expect(screen.getByLabelText('Search YouTube')).toBe(node);
      // Typing more while loading still updates state.
      await user.type(input, '!');
      expect(input.value).toBe('shape of you!');
      release([mkSong('youtube:1', 'Shape of You', 'Ed Sheeran')]);
      await waitFor(() => expect(screen.getByText('Shape of You')).toBeInTheDocument());
      expect((screen.getByLabelText('Search YouTube') as HTMLInputElement).value).toBe('shape of you!');
    } finally {
      spy.mockRestore();
    }
  });

  it('provider failure shows an error but leaves the input usable', async () => {
    const pm = getProviderManager();
    const provider = pm.get('youtube')!;
    const spy = vi.spyOn(provider, 'searchSongs').mockRejectedValue(new Error('down'));
    try {
      const user = userEvent.setup();
      render(<YouTubeScreen onOpenAlbum={() => undefined} onOpenArtist={() => undefined} />);
      const input = screen.getByLabelText('Search YouTube') as HTMLInputElement;
      await user.type(input, 'radhe radhe');
      await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
      expect(input).not.toBeDisabled();
      expect(input.value).toBe('radhe radhe');
      // Typing immediately after the failure still works.
      await user.type(input, '!');
      expect(input.value).toBe('radhe radhe!');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('radio search accepts typing', () => {
  it('type("BBC") → value === "BBC"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse([API_STATION])));
    const user = userEvent.setup();
    render(<RadioScreen />);
    const input = screen.getByLabelText('Search live stations') as HTMLInputElement;
    await user.click(input);
    await user.type(input, 'BBC');
    expect(input.value).toBe('BBC');
  });

  it('station failure never disables the search field', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down'); }));
    const user = userEvent.setup();
    render(<RadioScreen />);
    const input = screen.getByLabelText('Search live stations') as HTMLInputElement;
    // The radio provider retries before surfacing the failure; the field
    // must stay usable the entire time.
    expect(input).not.toBeDisabled();
    await user.type(input, 'B');
    expect(input.value).toBe('B');
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument(), { timeout: 15000 });
    expect(input).not.toBeDisabled();
    await user.type(input, 'BC');
    expect(input.value).toBe('BBC');
  });
});

describe('library filter accepts typing', () => {
  it('type("alan walker") → value === "alan walker"', async () => {
    const user = userEvent.setup();
    render(<LibraryScreen onOpenAlbum={() => undefined} onOpenArtist={() => undefined} />);
    const input = screen.getByLabelText('Search library') as HTMLInputElement;
    await user.click(input);
    await user.type(input, 'alan walker');
    expect(input.value).toBe('alan walker');
    expect(input).not.toBeDisabled();
    await user.type(input, '{Backspace}');
    expect(input.value).toBe('alan walke');
  });
});

describe('playlist name field accepts typing', () => {
  it('create flow types and submits with Enter', async () => {
    const user = userEvent.setup();
    const opened: string[] = [];
    render(<PlaylistsScreen refreshKey={0} onOpen={(id) => opened.push(id)} />);
    // Empty library → EmptyState with a Create Playlist action.
    await user.click(screen.getByRole('button', { name: /create playlist/i }));
    const input = screen.getByLabelText('Playlist name') as HTMLInputElement;
    await user.type(input, 'radhe radhe');
    expect(input.value).toBe('radhe radhe');
    await user.type(input, '{Enter}');
    await waitFor(() => expect(opened).toHaveLength(1));
  });
});

describe('global hotkeys defer to text entry', () => {
  it('isTypingTarget covers input/textarea/select/contenteditable, nothing else', () => {
    const { container } = render(
      <div>
        <input data-testid="in" aria-label="x" />
        <textarea data-testid="ta" aria-label="y" />
        <select data-testid="sel" aria-label="z"><option value="a">a</option></select>
        <div data-testid="ce" contentEditable>edit me</div>
        <div data-testid="plain">plain</div>
        <button data-testid="btn">ok</button>
      </div>,
    );
    const q = (id: string) => container.querySelector(`[data-testid="${id}"]`)!;
    expect(isTypingTarget(q('in'))).toBe(true);
    expect(isTypingTarget(q('ta'))).toBe(true);
    expect(isTypingTarget(q('sel'))).toBe(true);
    expect(isTypingTarget(q('ce'))).toBe(true);
    // A child node inside a contenteditable host is also a typing target.
    const child = document.createElement('span');
    child.textContent = 'inner';
    q('ce').appendChild(child);
    expect(isTypingTarget(child)).toBe(true);
    expect(isTypingTarget(q('plain'))).toBe(false);
    expect(isTypingTarget(q('btn'))).toBe(false);
    expect(isTypingTarget(document.body)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('shouldDeferToOverlayHotkeys covers contenteditable + menus + dialogs', () => {
    const { container } = render(
      <div>
        <div role="menu"><button data-testid="mi">item</button></div>
        <div role="dialog"><button data-testid="di">ok</button></div>
        <div data-testid="ce" contentEditable>edit me</div>
      </div>,
    );
    const q = (id: string) => container.querySelector(`[data-testid="${id}"]`)!;
    expect(shouldDeferToOverlayHotkeys(q('mi'))).toBe(true);
    expect(shouldDeferToOverlayHotkeys(q('di'))).toBe(true);
    expect(shouldDeferToOverlayHotkeys(q('ce'))).toBe(true);
  });

  it('typing "radhe radhe" inside a field never toggles playback, mutes, or changes volume', () => {
    const toggle = vi.fn(async () => undefined);
    const setMuted = vi.fn();
    const setVolume = vi.fn();
    const next = vi.fn(async () => undefined);
    usePlayer.setState({ toggle, setMuted, setVolume, next, volume: 0.5, muted: false } as never);
    const go = vi.fn();
    const createPlaylist = vi.fn();
    const onKey = createGlobalHotkeyHandler({ go, createPlaylist });
    window.addEventListener('keydown', onKey);
    try {
      const { container } = render(
        <div>
          <input data-testid="field" aria-label="field" />
          <div data-testid="ce" contentEditable aria-label="rich" />
        </div>,
      );
      const field = container.querySelector('[data-testid="field"]')!;
      const ce = container.querySelector('[data-testid="ce"]')!;
      for (const target of [field, ce]) {
        for (const key of ['r', 'a', 'd', 'h', 'e', ' ', 'm', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace', 'Delete']) {
          const e = new KeyboardEvent('keydown', { key, code: key === ' ' ? 'Space' : key, bubbles: true, cancelable: true });
          Object.defineProperty(e, 'target', { value: target });
          window.dispatchEvent(e);
          expect(e.defaultPrevented).toBe(false);
        }
      }
      expect(toggle).not.toHaveBeenCalled();
      expect(setMuted).not.toHaveBeenCalled();
      expect(setVolume).not.toHaveBeenCalled();
      expect(next).not.toHaveBeenCalled();
      expect(createPlaylist).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  });

  it('playback hotkeys still work outside text fields', () => {
    const toggle = vi.fn(async () => undefined);
    const setMuted = vi.fn();
    usePlayer.setState({ toggle, setMuted, muted: false } as never);
    const onKey = createGlobalHotkeyHandler({ go: vi.fn(), createPlaylist: vi.fn() });
    window.addEventListener('keydown', onKey);
    try {
      const space = new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true });
      Object.defineProperty(space, 'target', { value: document.body });
      window.dispatchEvent(space);
      expect(toggle).toHaveBeenCalledTimes(1);
      expect(space.defaultPrevented).toBe(true);

      const m = new KeyboardEvent('keydown', { key: 'm', bubbles: true, cancelable: true });
      Object.defineProperty(m, 'target', { value: document.body });
      window.dispatchEvent(m);
      expect(setMuted).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  });

  it('Ctrl+N never fires while typing, but works outside fields', () => {
    const createPlaylist = vi.fn();
    const onKey = createGlobalHotkeyHandler({ go: vi.fn(), createPlaylist });
    window.addEventListener('keydown', onKey);
    try {
      render(<input data-testid="field" aria-label="field" />);
      const field = screen.getByTestId('field');
      const inField = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(inField, 'target', { value: field });
      window.dispatchEvent(inField);
      expect(createPlaylist).not.toHaveBeenCalled();

      const onBody = new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(onBody, 'target', { value: document.body });
      window.dispatchEvent(onBody);
      expect(createPlaylist).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  });

  it('Ctrl+K navigates to search and focuses the persistent search field', () => {
    const go = vi.fn();
    const onKey = createGlobalHotkeyHandler({ go, createPlaylist: vi.fn() });
    window.addEventListener('keydown', onKey);
    try {
      render(<TopBarHarness />);
      const input = screen.getByLabelText('Search songs, artists, albums') as HTMLInputElement;
      expect(input.id).toBe(GLOBAL_SEARCH_INPUT_ID);
      const e = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
      Object.defineProperty(e, 'target', { value: document.body });
      window.dispatchEvent(e);
      expect(go).toHaveBeenCalledWith('search');
      expect(document.activeElement).toBe(input);
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  });
});
