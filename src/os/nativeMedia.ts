// Native OS media bridge — renderer side of the platform media contract.
//
// Contract (implemented natively on Android builds, stubbed on desktop):
//   - `plugin:knox-media|sync` — push now-playing state. Android renders it
//     through a framework MediaSession + a MediaStyle foreground-service
//     notification (type `mediaPlayback`); transport taps and the body tap
//     return as `knox-media-key` / `knox-open-player` events. Desktop has no
//     native surface: the legacy `knox_media_sync` Rust command acknowledges
//     and does nothing, and the Chromium Media Session API owns the OS
//     surface there.
//   - `plugin:knox-media|notification_state` — real POST_NOTIFICATIONS state.
//   - `plugin:knox-media|request_notification_permission` — fire the OS
//     runtime dialog (Android 13+).
//   - `knox_permissions_status` — live OS permission states. Anything the
//     host cannot answer reports "unknown" (never a fake grant).
//   - `knox_request_battery_exemption` — Android-only background-playback
//     exemption request. Rejects on builds without the native hook.
//   - `knox_open_app_settings` — deep link to the OS app-settings page for
//     this app. Rejects with human guidance the UI can show instead.
//
// Every function degrades gracefully: outside Tauri (browser/PWA) or on a
// host without these commands, calls resolve `false` / reject with a caught
// error — the web Media Session API remains the source of truth on desktop
// and playback NEVER depends on the bridge. All functions are safe to call
// during module init and in tests.

import { isTauri } from '../desktop/detector';

/** Now-playing snapshot pushed to the native media layer. No URLs with
 *  secrets — artwork travels as an app-local / https / data URL only. */
export interface NativeMediaSnapshot {
  trackId: string;
  title: string;
  artist: string;
  album: string;
  /** Artwork src for the notification/lock-screen slot (or undefined). */
  artwork?: string;
  /** Seconds. Omit (live) for radio — disables scrubbing natively. */
  durationSec?: number;
  positionSec?: number;
  rate?: number;
  playing: boolean;
  live: boolean;
  canNext: boolean;
  canPrev: boolean;
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const mod = await import('@tauri-apps/api/core');
  return mod.invoke<T>(cmd, args);
}

/**
 * True inside the Tauri Android build — the ONLY target with a native
 * media-notification surface. Desktop Tauri (Linux/Windows) and browsers
 * use the web Media Session path instead. `'Notification' in window` is
 * deliberately NOT the switch: WebView lacks the Web Notifications API
 * even though the native surface exists, and desktop Chromium has the API
 * even though no native surface exists.
 */
export function isTauriAndroid(): boolean {
  try {
    if (!isTauri()) return false;
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
    return /Android/.test(ua);
  } catch {
    return false;
  }
}

/** Last failed native-bridge attempt (ms epoch). A short cooldown keeps a
 *  dead bridge from being hammered on every position tick, WITHOUT
 *  permanently disabling future syncs — the next attempt after the cooldown
 *  retries normally. Distinguishes "one invocation failed" (retry later)
 *  from "capability unavailable" (not Tauri / not Android, checked fresh
 *  on every call below). */
let lastBridgeFailureAt = 0;
const BRIDGE_RETRY_COOLDOWN_MS = 10_000;

function bridgeInCooldown(): boolean {
  try {
    return Date.now() - lastBridgeFailureAt < BRIDGE_RETRY_COOLDOWN_MS;
  } catch {
    return false;
  }
}

function noteBridgeFailure(): void {
  try {
    lastBridgeFailureAt = Date.now();
  } catch {
    /* clock never breaks playback */
  }
}

/**
 * Push now-playing state to the native layer. Fire-and-forget: resolves
 * true when a native hook consumed it, false when the web Media Session API
 * remains the OS surface. A failed attempt fails THAT sync only — after a
 * short cooldown the next attempt retries. Never throws.
 */
export async function syncNativeMediaSession(snap: NativeMediaSnapshot): Promise<boolean> {
  if (!isTauri()) return false;
  if (bridgeInCooldown()) return false;
  // Android: the knox-media plugin renders a real notification.
  if (isTauriAndroid()) {
    try {
      await invoke('plugin:knox-media|sync', { snapshot: snap, ...snap });
      return true;
    } catch (e) {
      // Transient (stale build, slow bridge, background-start refusal):
      // back off briefly, then retry on a later tick. Never latch off.
      console.warn('Native media sync failed:', e);
      noteBridgeFailure();
      return false;
    }
  }
  // Desktop: legacy Rust ack (no native surface; web Media Session owns it).
  try {
    await invoke('knox_media_sync', { snapshot: snap });
    return true;
  } catch {
    noteBridgeFailure();
    return false;
  }
}

/** Clear any native now-playing state (boot + error paths). Never throws. */
export async function clearNativeMediaSession(): Promise<void> {
  if (!isTauri()) return;
  try {
    if (isTauriAndroid()) {
      await invoke('plugin:knox-media|clear');
    } else {
      await invoke('knox_media_sync', {
        snapshot: {
          trackId: '', title: '', artist: '', album: '',
          playing: false, live: false, canNext: false, canPrev: false,
        } satisfies NativeMediaSnapshot,
      });
    }
  } catch {
    noteBridgeFailure();
  }
}

export type NativeNotificationState = 'granted' | 'denied' | 'unknown';

/** Native media health for the App-permissions diagnostic row. Null outside
 *  Tauri Android; `{bridge:'unreachable'}` when the plugin cannot be
 *  reached (never a fake healthy). */
export interface NativeMediaStatus {
  bridge: string;
  serviceRunning?: boolean;
  syncCount?: number;
  /** ms since the last snapshot arrived; -1 when none ever arrived. */
  lastSyncAgoMs?: number;
  lastError?: string | null;
}

export async function queryNativeMediaStatus(): Promise<NativeMediaStatus | null> {
  if (!isTauriAndroid()) return null;
  try {
    const out = await invoke<NativeMediaStatus>('plugin:knox-media|status');
    if (out && typeof out.bridge === 'string') return out;
    return { bridge: 'unreachable' };
  } catch {
    return { bridge: 'unreachable' };
  }
}

/** Real POST_NOTIFICATIONS state on Android; 'unknown' elsewhere/failing. */
export async function queryNativeNotificationState(): Promise<NativeNotificationState> {
  if (!isTauriAndroid()) return 'unknown';
  try {
    const out = await invoke<{ state?: string }>('plugin:knox-media|notification_state');
    return out?.state === 'granted' ? 'granted' : out?.state === 'denied' ? 'denied' : 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Fire the OS POST_NOTIFICATIONS runtime dialog (Android 13+; no-op below).
 * Resolves the state observed right after the request. Never throws.
 */
export async function requestNativeNotificationPermission(): Promise<NativeNotificationState> {
  if (!isTauriAndroid()) return 'unknown';
  try {
    const out = await invoke<{ state?: string }>('plugin:knox-media|request_notification_permission');
    return out?.state === 'granted' ? 'granted' : out?.state === 'denied' ? 'denied' : 'unknown';
  } catch {
    return 'unknown';
  }
}

export type NativeMediaEvent =
  | { kind: 'key'; action: string }
  | { kind: 'open-player' };

/**
 * Subscribe to native media events (notification transport taps, headset
 * keys via the session, notification body tap). Android only; resolves an
 * unlisten function. Never throws — resolves a no-op outside Tauri.
 */
export async function listenNativeMediaEvents(cb: (e: NativeMediaEvent) => void): Promise<() => void> {
  if (!isTauriAndroid()) return () => undefined;

  const handleKey = (action: string) => {
    try {
      cb({ kind: 'key', action });
    } catch {
      /* listener never breaks the bridge */
    }
  };

  const handleOpen = () => {
    try {
      cb({ kind: 'open-player' });
    } catch {
      /* listener never breaks the bridge */
    }
  };

  let domCleanup = () => {};
  if (typeof window !== 'undefined') {
    (window as unknown as { __knoxMediaKey?: (action: string) => void }).__knoxMediaKey = handleKey;
    (window as unknown as { __knoxOpenPlayer?: () => void }).__knoxOpenPlayer = handleOpen;
    const keyListener = (ev: Event) => {
      const custom = ev as CustomEvent<{ action?: string }>;
      const action = custom.detail?.action;
      if (action) handleKey(action);
    };
    const openListener = () => handleOpen();
    window.addEventListener('knox-media-key', keyListener);
    window.addEventListener('knox-open-player', openListener);
    domCleanup = () => {
      delete (window as unknown as { __knoxMediaKey?: unknown }).__knoxMediaKey;
      delete (window as unknown as { __knoxOpenPlayer?: unknown }).__knoxOpenPlayer;
      window.removeEventListener('knox-media-key', keyListener);
      window.removeEventListener('knox-open-player', openListener);
    };
  }

  let offKey: (() => void) | undefined;
  let offOpen: (() => void) | undefined;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    offKey = await listen<{ action?: string }>('knox-media-key', (ev) => {
      handleKey(String(ev.payload?.action ?? 'toggle'));
    });
    offOpen = await listen('knox-open-player', () => {
      handleOpen();
    });
  } catch {
    /* listener never breaks the bridge */
  }

  return () => {
    domCleanup();
    try { offKey?.(); } catch { /* ignore */ }
    try { offOpen?.(); } catch { /* ignore */ }
  };
}

export type NativePermissionState = 'granted' | 'denied' | 'partial' | 'unknown';

/** Live OS states as reported by the host. Missing keys = "unknown". */
export async function queryNativePermissionStates(): Promise<Record<string, NativePermissionState>> {
  if (!isTauri()) return {};
  try {
    const out = await invoke<Record<string, NativePermissionState>>('knox_permissions_status');
    return out && typeof out === 'object' ? out : {};
  } catch {
    return {};
  }
}

/**
 * Ask the host to start the battery-exemption request flow (Android-only).
 * Prefers the native plugin (real OS dialog); falls back to the Rust
 * command, which rejects with human guidance — callers MUST catch.
 */
export async function requestNativeBatteryExemption(): Promise<boolean> {
  if (isTauriAndroid()) {
    try {
      const out = await invoke<{ value?: boolean }>('plugin:knox-media|request_battery_exemption');
      if (typeof out?.value === 'boolean') return out.value;
    } catch {
      /* fall through to the Rust command */
    }
  }
  const out = await invoke<boolean>('knox_request_battery_exemption');
  return out === true;
}

/**
 * Open this app's OS settings page. Prefers the native plugin (real OS
 * page); falls back to the Rust command, which rejects with human guidance
 * (e.g. "Open Settings → Apps → KNOX Music") for the UI to display —
 * callers MUST catch and fall back to that text.
 */
export async function openNativeAppSettings(): Promise<void> {
  if (isTauriAndroid()) {
    try {
      await invoke('plugin:knox-media|open_app_settings');
      return;
    } catch {
      /* fall through to the Rust command */
    }
  }
  await invoke('knox_open_app_settings');
}

/** For tests: reset the bridge-failure cooldown. */
export function __resetNativeMediaCache(): void {
  lastBridgeFailureAt = 0;
}
