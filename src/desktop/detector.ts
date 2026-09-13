// Desktop host detection — Tauri vs plain browser/PWA.
//
// The renderer runs in both contexts:
//   - Tauri desktop: `window.__TAURI_INTERNALS__` exists, IPC + local API work.
//   - Browser/PWA:   no host; KNOX Core talks to providers directly.
//
// Never throws; safe to call during module init and in tests.

export function isTauri(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ !== undefined
    );
  } catch {
    return false;
  }
}

/** True when the local desktop host (IPC + loopback API) is available. */
export function isDesktop(): boolean {
  return isTauri();
}

/** Runtime mode label for diagnostics (never includes secrets). */
export function runtimeMode(): 'desktop' | 'browser' {
  return isDesktop() ? 'desktop' : 'browser';
}
