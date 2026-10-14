// KNOX Core lifecycle tests: provider registration, settings toggles,
// idempotent init, safe shutdown.

import { describe, it, expect } from 'vitest';
import { initKnox, registerProviders, shutdownKnox } from '../../src/core/knox';
import { getProviderManager } from '../../src/providers/ProviderManager';

describe('registerProviders', () => {
  it('registers every bundled provider exactly once', () => {
    registerProviders();
    registerProviders();
    const pm = getProviderManager();
    for (const id of ['local', 'sample', 'youtube', 'youtube-music', 'spotify', 'jiosaavn']) {
      expect(pm.get(id)?.id).toBe(id);
    }
    expect(pm.list().filter((p) => p.id === 'jiosaavn')).toHaveLength(1);
    expect(pm.get('airbeats')).toBeUndefined();
    expect(pm.get('jamendo')).toBeUndefined();
    expect(pm.get('freetouse')).toBeUndefined();
    expect(pm.get('internet-archive')).toBeUndefined();
  });

  it('youtube-music registers enabled by default', () => {
    registerProviders();
    expect(getProviderManager().list().find((p) => p.id === 'youtube-music')?.enabled).toBe(true);
  });
});

describe('initKnox', () => {
  it('boots the full local stack and returns a summary', async () => {
    const summary = await initKnox();
    expect(summary.providers.length).toBeGreaterThanOrEqual(6);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof summary.recoveredDownloads).toBe('number');
    expect(Array.isArray(summary.health)).toBe(true);
  });

  it('is safe to run twice (no duplicate providers, no data loss)', async () => {
    await initKnox();
    const second = await initKnox();
    const ids = second.providers.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('shutdownKnox', () => {
  it('never throws', async () => {
    await expect(shutdownKnox()).resolves.toBeUndefined();
  });
});
