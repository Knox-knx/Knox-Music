// Providers settings panel: health status, radio/lyrics toggles, sidecar check.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProvidersPanel } from '../../src/screens/SettingsScreen';
import { getProviderManager } from '../../src/providers/ProviderManager';
import { useSettings, DEFAULT_SETTINGS } from '../../src/settings/settingsStore';
import type { MusicProvider } from '../../src/providers/types';

function stub(id: string, name: string): MusicProvider {
  return {
    id, name,
    capabilities: {
      supportsSearch: true, supportsStreaming: true, supportsOffline: true,
      supportsLyrics: false, supportsArtwork: false, supportsArtists: true, supportsAlbums: true,
    },
    searchSongs: async () => [], searchArtists: async () => [], searchAlbums: async () => [],
    searchPlaylists: async () => [], getSong: async () => null, getArtist: async () => null,
    getAlbum: async () => null, getPlaylist: async () => null, getAlbumTracks: async () => [],
    getStream: async () => { throw new Error('no'); }, getArtwork: async () => null, getLyrics: async () => null,
  };
}

beforeEach(() => {
  const pm = getProviderManager();
  if (!pm.get('jamendo')) pm.register(stub('jamendo', 'Jamendo'), true);
  if (!pm.get('youtube-music')) pm.register(stub('youtube-music', 'YouTube Music'), true);
  useSettings.setState({ ...DEFAULT_SETTINGS, providersEnabled: { ...DEFAULT_SETTINGS.providersEnabled } });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ProvidersPanel', () => {
  it('shows health status for music providers', () => {
    render(<ProvidersPanel />);
    expect(screen.getByRole('switch', { name: 'Enable Jamendo' })).toBeInTheDocument();
    expect(screen.getAllByText('healthy').length).toBeGreaterThanOrEqual(2);
  });

  it('marks failing providers unavailable with the last error', async () => {
    const pm = getProviderManager();
    pm.healthManager().recordFailure('jamendo', 'boom');
    pm.healthManager().recordFailure('jamendo', 'boom');
    pm.healthManager().recordFailure('jamendo', 'boom');
    render(<ProvidersPanel />);
    expect(await screen.findByText(/unavailable — boom/)).toBeInTheDocument();
  });

  it('toggles Radio Browser and LRCLIB services', async () => {
    render(<ProvidersPanel />);
    const radioSwitch = screen.getByRole('switch', { name: 'Enable Radio Browser' });
    expect(radioSwitch).toHaveAttribute('aria-checked', 'true');
    await userEvent.click(radioSwitch);
    await waitFor(() => {
      expect(useSettings.getState().providersEnabled['radio-browser']).toBe(false);
    });
    const lyricsSwitch = screen.getByRole('switch', { name: 'Enable LRCLIB Lyrics' });
    await userEvent.click(lyricsSwitch);
    await waitFor(() => {
      expect(useSettings.getState().providersEnabled['lrclib']).toBe(false);
    });
  });

  it('checks the YouTube Music service on demand', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    })));
    render(<ProvidersPanel />);
    await userEvent.click(screen.getByRole('button', { name: /check service/i }));
    expect(await screen.findByText('YouTube Music available')).toBeInTheDocument();
  });
});
