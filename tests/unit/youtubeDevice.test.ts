import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { nativeSearch, nativeDuration, canUseNativeYouTube } from '../../src/providers/youtube/device';

const invokeMock = tauriInvoke as unknown as ReturnType<typeof vi.fn>;

function setTauri(on: boolean) {
  const w = window as unknown as Record<string, unknown>;
  if (on) w.__TAURI_INTERNALS__ = {};
  else delete w.__TAURI_INTERNALS__;
}

describe('on-device YouTube bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setTauri(true);
  });
  afterEach(() => {
    setTauri(false);
  });

  it('detects the Tauri shell', () => {
    expect(canUseNativeYouTube()).toBe(true);
    setTauri(false);
    expect(canUseNativeYouTube()).toBe(false);
  });

  it('maps native results to the sidecar shape', async () => {
    invokeMock.mockResolvedValue([
      {
        id: 'H2f7MZaw3Yo',
        title: 'Samjhawan - Lyric video',
        channel: 'Sony Music India',
        duration: 266,
        url: 'https://www.youtube.com/watch?v=H2f7MZaw3Yo',
        live: false,
        thumbnails: [
          { url: 'https://i.ytimg.com/vi/H2f7MZaw3Yo/hq720.jpg', width: 720, height: 404 },
          { url: 'https://i.ytimg.com/vi/H2f7MZaw3Yo/default.jpg', width: 120, height: 90 },
        ],
      },
    ]);
    const out = await nativeSearch('samjhawan', 5);
    expect(invokeMock).toHaveBeenCalledWith('knox_yt_search', { query: 'samjhawan', limit: 5 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: 'H2f7MZaw3Yo',
      title: 'Samjhawan - Lyric video',
      channel: 'Sony Music India',
      duration: 266,
      live: false,
    });
    expect(out[0].thumbnails).toHaveLength(2);
  });

  it('drops malformed native ids', async () => {
    invokeMock.mockResolvedValue([{ id: '!!bad', title: 'x', channel: 'y', duration: null, url: '', live: false }]);
    await expect(nativeSearch('x', 5)).resolves.toEqual([]);
  });

  it('returns [] for blank queries without invoking', async () => {
    await expect(nativeSearch('   ', 5)).resolves.toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('resolves real durations without bytes', async () => {
    invokeMock.mockResolvedValue(266);
    await expect(nativeDuration('H2f7MZaw3Yo')).resolves.toBe(266);
    expect(invokeMock).toHaveBeenCalledWith('knox_yt_duration', { videoId: 'H2f7MZaw3Yo' });
  });

  it('keeps –:–– (null) when the length is unknown', async () => {
    invokeMock.mockRejectedValueOnce(new Error('No duration for this video.'));
    await expect(nativeDuration('dQw4w9WgXcQ')).resolves.toBeNull();
    await expect(nativeDuration('!!bad')).resolves.toBeNull();
    setTauri(false);
    await expect(nativeDuration('aaaaaaaaaaa')).resolves.toBeNull();
  });
});
