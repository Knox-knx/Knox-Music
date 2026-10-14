// Playback notification permission — just-in-time, never on launch.
//
// Platform truth:
//   - Tauri Android: the lock-screen/shade card IS a native notification
//     (knox-media plugin), so POST_NOTIFICATIONS gates the card. The Web
//     Notifications API does not exist in the WebView — never gate on it.
//   - Desktop web: transport controls come from the Media Session API and
//     need NO permission; the Web Notification permission only gates
//     *alert-style* notifications (e.g. "Download complete").
//   - First track play → show a one-line in-app explainer FIRST, and only if
//     the user taps [Allow] fire the OS dialog. Never a bare OS dialog.
//   - Denied → playback works normally; a persistent, dismissible in-app
//     banner links to settings. The prompt is never retried automatically.
//   - iOS → now-playing/lock-screen controls do NOT need notification
//     permission, so nothing is asked for media controls. The request only
//     happens when alert-style notifications are actually enabled in
//     Settings (download complete/failed).
//
// All state persists in localStorage (never IndexedDB — it must be readable
// before the DB boots and in tests). Never throws, never blocks playback.

import { create } from 'zustand';
import { useSettings } from '../settings/settingsStore';
import { logger } from '../core/logger';
import { isTauriAndroid, queryNativeNotificationState } from './nativeMedia';

const ASKED_KEY = 'knox.notifPromptAsked';
const DISMISSED_KEY = 'knox.notifBannerDismissed';

function readFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false;
  }
}

function writeFlag(key: string): void {
  try {
    localStorage.setItem(key, '1');
  } catch {
    /* private mode — prompt again next launch, harmless */
  }
}

export function isIOS(): boolean {
  try {
    if (typeof navigator === 'undefined') return false;
    const ua = navigator.userAgent || '';
    // iPadOS 13+ reports Macintosh — detect via touch points.
    return (
      /iPad|iPhone|iPod/.test(ua) ||
      (ua.includes('Mac') && (navigator as Navigator & { maxTouchPoints?: number }).maxTouchPoints > 1)
    );
  } catch {
    return false;
  }
}

export function notificationsSupported(): boolean {
  // Platform branch (spec: never gate on the Web Notifications API for the
  // native surface): the Tauri Android build posts through the knox-media
  // plugin, which exists whether or not the WebView implements
  // `window.Notification` (it doesn't). Everywhere else, the Web API is
  // genuinely the only alert surface.
  try {
    if (isTauriAndroid()) return true;
    return typeof window !== 'undefined' && 'Notification' in window;
  } catch {
    return false;
  }
}

/**
 * Last observed native POST_NOTIFICATIONS state (Android only). Sync cache
 * for sync call sites; refresh via [refreshNativeNotificationState].
 * Starts as 'default' (not yet observed — promptable).
 */
let nativeState: NotificationPermission = 'default';

export async function refreshNativeNotificationState(): Promise<NotificationPermission> {
  if (!isTauriAndroid()) {
    const p = notificationPermission();
    return p === 'unsupported' ? 'default' : p;
  }
  try {
    const s = await queryNativeNotificationState();
    nativeState = s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : 'default';
  } catch {
    /* keep last */
  }
  return nativeState;
}

export function notificationPermission(): NotificationPermission | 'unsupported' {
  try {
    if (isTauriAndroid()) return nativeState;
  } catch {
    /* fall through to web */
  }
  if (!notificationsSupported()) return 'unsupported';
  try {
    return Notification.permission;
  } catch {
    return 'unsupported';
  }
}

interface PlaybackNoticeState {
  /** In-app explainer card (fires BEFORE any OS dialog). */
  explainerOpen: boolean;
  openExplainer: () => void;
  closeExplainer: () => void;
  /** Persistent denied banner (dismissible, never auto-retried). */
  bannerDismissed: boolean;
  dismissBanner: () => void;
  resetForTests: () => void;
}

export const usePlaybackNotice = create<PlaybackNoticeState>((set) => ({
  explainerOpen: false,
  openExplainer: () => set({ explainerOpen: true }),
  closeExplainer: () => set({ explainerOpen: false }),
  bannerDismissed: readFlag(DISMISSED_KEY),
  dismissBanner: () => {
    writeFlag(DISMISSED_KEY);
    set({ bannerDismissed: true });
  },
  resetForTests: () => set({ explainerOpen: false, bannerDismissed: false }),
}));

/** Do alert-style notifications have any job on this device? (iOS gate) */
function alertsInUse(): boolean {
  try {
    const s = useSettings.getState();
    return s.notifDownloadComplete || s.notifDownloadFailed;
  } catch {
    return false;
  }
}

/**
 * First-playback entry point. Call fire-and-forget from playSongs/playSong/
 * playStation — it returns before any async work and NEVER delays audio.
 * Opens the explainer exactly once per install, only when a request could
 * still be granted (permission 'default') and (on iOS) alerts are in use.
 */
export function notePlaybackStarted(): void {
  try {
    if (isTauriAndroid()) {
      void refreshNativeNotificationState().then((state) => {
        if (state !== 'granted') {
          void requestPlaybackNotificationPermission();
        }
      }).catch(() => undefined);
      return;
    }
    if (readFlag(ASKED_KEY)) return;
    writeFlag(ASKED_KEY);
  } catch {
    /* permission UX never breaks playback */
  }
}

/**
 * Best-effort explicit OS sync after a grant — posts the CURRENT track's
 * card immediately instead of waiting for the next position tick. Reuses
 * mediaSession's single snapshot builder (dynamic import: mediaSession →
 * playerStore → here is a static cycle). Never throws, never blocks.
 */
function syncOsMediaAfterGrant(): void {
  try {
    void import('./mediaSession').then(
      (m) => {
        try {
          m.syncOsMediaNow();
        } catch {
          /* explicit sync never breaks permission UX */
        }
      },
      () => undefined,
    );
  } catch {
    /* dynamic import never breaks permission UX */
  }
}

/**
 * [Allow] from the explainer — the ONLY place the OS dialog fires, inside
 * the user's tap gesture (required by some browsers). Marks asked first so
 * a dismissed OS dialog is never re-shown automatically. On grant, pushes
 * the current snapshot explicitly so the card posts immediately.
 */
export async function requestPlaybackNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  usePlaybackNotice.getState().closeExplainer();
  writeFlag(ASKED_KEY);
  // Native path: the plugin fires the POST_NOTIFICATIONS runtime dialog.
  if (isTauriAndroid()) {
    try {
      const { requestNativeNotificationPermission } = await import('./nativeMedia');
      const s = await requestNativeNotificationPermission();
      nativeState = s === 'granted' ? 'granted' : s === 'denied' ? 'denied' : 'default';
      logger.info('permissions', `native notification permission → ${nativeState}`);
      if (nativeState === 'granted') syncOsMediaAfterGrant();
      return nativeState;
    } catch {
      return nativeState;
    }
  }
  if (!notificationsSupported()) return 'unsupported';
  try {
    const out = await Notification.requestPermission();
    logger.info('permissions', `notification permission → ${out}`);
    if (out === 'granted') syncOsMediaAfterGrant();
    return out;
  } catch {
    return notificationPermission();
  }
}

/** [Not now] — close without asking the OS; ask never again automatically. */
export function deferPlaybackNotificationPermission(): void {
  writeFlag(ASKED_KEY);
  usePlaybackNotice.getState().closeExplainer();
}

/**
 * Open OS notification settings for this app/site. Web browsers expose no
 * deep link to per-site settings, so: Tauri → native settings page; web →
 * re-request only when still promptable, otherwise surface guidance text.
 * Returns guidance text when no settings page could be opened (UI toasts
 * it) — never throws.
 */
export async function openNotificationSettings(): Promise<string | null> {
  try {
    const { isTauri } = await import('../desktop/detector');
    if (isTauri()) {
      try {
        const { openNativeAppSettings } = await import('./nativeMedia');
        await openNativeAppSettings();
        return null;
      } catch (e) {
        return e instanceof Error ? e.message : 'Open the OS Settings app to change notification access.';
      }
    }
  } catch {
    /* fall through to web handling */
  }
  if (notificationPermission() === 'default') {
    await requestPlaybackNotificationPermission();
    return null;
  }
  return 'Notifications are blocked — allow them in your browser’s site settings for this site, then reload.';
}

/** For tests: clear persisted prompt flags. */
export function __resetPlaybackNoticeFlags(): void {
  try {
    localStorage.removeItem(ASKED_KEY);
    localStorage.removeItem(DISMISSED_KEY);
  } catch {
    /* ignore */
  }
  usePlaybackNotice.getState().resetForTests();
}
