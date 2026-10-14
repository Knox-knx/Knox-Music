import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/settings/settingsStore';
import { qualityBytesPerSong } from '../../src/settings/settingsStore';

describe('settings defaults (privacy-safe)', () => {
  it('ships dark-first with auto-save OFF and wifi-only ON', () => {
    expect(DEFAULT_SETTINGS.theme).toBe('dark');
    expect(DEFAULT_SETTINGS.autoSavePlayed).toBe(false);
    expect(DEFAULT_SETTINGS.wifiOnly).toBe(true);
    expect(DEFAULT_SETTINGS.resumeAutoplay).toBe(false);
    expect(DEFAULT_SETTINGS.onboarded).toBe(false);
  });

  it('estimates honest per-song storage', () => {
    expect(qualityBytesPerSong('Low')).toBeLessThan(qualityBytesPerSong('High'));
    expect(qualityBytesPerSong('Best Available')).toBeGreaterThan(qualityBytesPerSong('High'));
  });
});

describe('player queue logic', () => {
  beforeEach(() => {
    // jsdom lacks real audio; exercise pure queue mutations only
  });
  it('add / reorder / remove / clear queue without audio', async () => {
    const { usePlayer } = await import('../../src/audio/playerStore');
    const mk = (id: string) => ({
      id, providerId: 'x', providerTrackId: id, title: id, artist: 'A', album: 'B',
      durationMs: 1000, addedAt: 0,
    });
    usePlayer.setState({ queue: [], index: -1 });
    usePlayer.getState().addToQueue(mk('a'));
    usePlayer.getState().addToQueue(mk('b'));
    usePlayer.getState().addToQueue(mk('c'), true); // play next -> position 0
    expect(usePlayer.getState().queue.map((s) => s.id)).toEqual(['c', 'a', 'b']);
    usePlayer.getState().reorderQueue(0, 2);
    expect(usePlayer.getState().queue.map((s) => s.id)).toEqual(['a', 'b', 'c']);
    usePlayer.getState().removeFromQueue('b');
    expect(usePlayer.getState().queue.map((s) => s.id)).toEqual(['a', 'c']);
    usePlayer.getState().clearQueue();
    expect(usePlayer.getState().queue).toEqual([]);
  });

  it('cycles repeat modes and toggles shuffle', async () => {
    const { usePlayer } = await import('../../src/audio/playerStore');
    usePlayer.getState().setRepeat('ALL');
    expect(usePlayer.getState().repeat).toBe('ALL');
    usePlayer.getState().setShuffle(true);
    expect(usePlayer.getState().shuffle).toBe(true);
    usePlayer.getState().setSleepTimer(10);
    expect(usePlayer.getState().sleepTimerEndsAt).toBeGreaterThan(Date.now());
    usePlayer.getState().setSleepTimer(null);
    expect(usePlayer.getState().sleepTimerEndsAt).toBeNull();
  });
});
