// Desktop lifecycle: deterministic boot + idempotent shutdown.
//
// The renderer boot never throws — worst case it resolves `degraded` and
// the UI still renders over the local library. Sidecar/provider failures
// are isolated; KNOX keeps running.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  bootDesktop,
  shutdownDesktop,
  onBootPhase,
  bootPhase,
  __resetLifecycle,
} from '../../src/desktop/lifecycle';
import { __resetHostCache } from '../../src/desktop/host';

beforeEach(() => {
  __resetLifecycle();
  __resetHostCache();
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe('bootDesktop', () => {
  it('boots in browser mode without a host (local-first, still usable)', async () => {
    const result = await bootDesktop({ skipHealthProbe: true });
    expect(['ready', 'degraded']).toContain(result.phase);
    expect(result.apiOk).toBe(false); // no host in jsdom
    expect(result.sidecar).toBeNull();
    expect(typeof result.durationMs).toBe('number');
    expect(Array.isArray(result.notes)).toBe(true);
  });

  it('emits boot phases for the splash screen', async () => {
    const seen: string[] = [];
    const off = onBootPhase((p) => seen.push(p));
    await bootDesktop({ skipHealthProbe: true });
    off();
    expect(seen).toContain('core');
    expect(seen[seen.length - 1]).toMatch(/ready|degraded/);
    expect(['ready', 'degraded']).toContain(bootPhase());
  });

  it('never throws, even with youtube-music requested but no host', async () => {
    const result = await bootDesktop({ skipHealthProbe: true, youtubemusicEnabled: true });
    expect(['ready', 'degraded']).toContain(result.phase);
  });
});

describe('shutdownDesktop', () => {
  it('is idempotent — calling twice never crashes', async () => {
    await shutdownDesktop();
    await shutdownDesktop();
    await expect(shutdownDesktop()).resolves.toBeUndefined();
  });
});
