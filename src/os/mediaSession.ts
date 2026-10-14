// OS now-playing sync — the single source of truth (playerStore) feeding the
// OS-level media surface on every platform.
//
// Web / PWA / Tauri-WebView: the Media Session API IS the notification —
// Chromium surfaces it as the system media notification + lock-screen
// controls + quick-settings panel + Bluetooth/AVRCP metadata (car display,
// smartwatch), and Safari surfaces it on the lock screen / Control Center.
// No Web Notification is needed (or wanted) for transport controls.
// Tauri mobile: the same snapshot is additionally forwarded to the native
// layer (MediaSessionCompat + MediaStyle FGS on Android, MPNowPlayingInfo /
// RemoteCommandCenter on iOS) via nativeMedia.ts — best-effort, never load-
// bearing. In-app mini-player/full-player read the same store, so pausing
// from the lock screen updates the in-app icon immediately and vice versa.
//
// Radio: station name as title, "Live" as artist, NO position state (the OS
// then disables scrubbing instead of showing a fake seek bar).
// Errors: playbackState 'none' + native clear, so a failed track never
// leaves a stale "Now Playing" card behind.
// Boot/kill-reopen: cleared to 'none' — never a stale or duplicate card.

import type { Song } from '../core/types';
import { usePlayer } from '../audio/playerStore';
import { useSettings } from '../settings/settingsStore';
import { clearNativeMediaSession, syncNativeMediaSession, listenNativeMediaEvents, isTauriAndroid } from './nativeMedia';
import { resetContinuityCounters } from './audioInterruptions';

function mediaSession(): MediaSession | null {
  try {
    if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return null;
    return navigator.mediaSession;
  } catch {
    return null;
  }
}

// Gold-tile artwork fallback, rendered as a bitmap for the notification /
// lock-screen art slot — the same gold-bordered tile treatment as in-app,
// so untagged local files look intentional instead of an OS placeholder.
const tileCache = new Map<string, string>();
export function goldTileArtwork(glyph: '♪' | '◉'): string {
  const hit = tileCache.get(glyph);
  if (hit) return hit;
  try {
    if (typeof document === 'undefined') return '';
    const S = 512;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d');
    if (!ctx) return '';
    ctx.fillStyle = '#0B1220';
    ctx.fillRect(0, 0, S, S);
    ctx.strokeStyle = '#E8A657';
    ctx.lineWidth = 10;
    const r = 64;
    ctx.beginPath();
    ctx.roundRect(28, 28, S - 56, S - 56, r);
    ctx.stroke();
    ctx.fillStyle = '#E8A657';
    ctx.font = '300px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, S / 2, S / 2 + 20);
    const url = canvas.toDataURL('image/png');
    tileCache.set(glyph, url);
    return url;
  } catch {
    return '';
  }
}

function artworkEntries(song: Song, live: boolean): MediaImage[] {
  const out: MediaImage[] = [];
  const push = (src: string | undefined) => {
    if (!src) return;
    try {
      const abs = typeof window !== 'undefined' && src.startsWith('/') ? new URL(src, window.location.href).href : src;
      out.push({ src: abs, sizes: '512x512', type: 'image/png' });
    } catch {
      out.push({ src, sizes: '512x512', type: 'image/png' });
    }
  };
  push(song.artworkLocal);
  push(song.artworkUrl);
  const fallback = goldTileArtwork(live ? '◉' : '♪');
  if (fallback) out.push({ src: fallback, sizes: '512x512', type: 'image/png' });
  return out;
}

let handlersInstalled = false;

function installActionHandlers(): void {
  const ms = mediaSession();
  if (!ms || handlersInstalled) return;
  handlersInstalled = true;
  const st = () => usePlayer.getState();
  const safe = (action: MediaSessionAction, fn: ((d: MediaSessionActionDetails) => void | Promise<void>) | null) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* unsupported action — the OS simply hides that control */
    }
  };
  safe('play', () => {
    void st().play();
  });
  safe('pause', () => {
    st().pause();
  });
  safe('previoustrack', () => void st().prev());
  safe('nexttrack', () => void st().next());
  safe('seekbackward', (d) => {
    const s = st();
    if (s.playerMode === 'radio') return;
    s.seek(Math.max(0, s.positionMs - (d.seekOffset ?? 10) * 1000));
  });
  safe('seekforward', (d) => {
    const s = st();
    if (s.playerMode === 'radio') return;
    s.seek(s.positionMs + (d.seekOffset ?? 10) * 1000);
  });
  safe('seekto', (d) => {
    const s = st();
    if (s.playerMode === 'radio') return;
    if (typeof d.seekTime === 'number' && Number.isFinite(d.seekTime)) {
      s.seek(d.seekTime * 1000);
    }
  });
  // Stop: pause and release the OS card (swipe-dismiss equivalent). The next
  // play re-syncs everything — never a stuck notification.
  safe('stop', () => {
    st().pause();
    try {
      const m = mediaSession();
      if (m) m.playbackState = 'none';
    } catch {
      /* best-effort */
    }
    void clearNativeMediaSession();
  });
}

/** Enable/disable prev/next/seek controls for the current queue state.
 *  A nulled handler hides the control instead of leaving a dead button. */
function syncCommandAvailability(canPrev: boolean, canNext: boolean, seekable: boolean): void {
  const ms = mediaSession();
  if (!ms) return;
  const st = () => usePlayer.getState();
  const safe = (action: MediaSessionAction, fn: ((d: MediaSessionActionDetails) => void) | null) => {
    try {
      ms.setActionHandler(action, fn);
    } catch {
      /* ignore */
    }
  };
  safe('previoustrack', canPrev ? () => void st().prev() : null);
  safe('nexttrack', canNext ? () => void st().next() : null);
  if (!seekable) {
    safe('seekto', null);
    safe('seekbackward', null);
    safe('seekforward', null);
  }
}

interface SyncMemory {
  trackId: string | null;
  playing: boolean;
  lastSec: number;
  lastCanNext: boolean;
  lastCanPrev: boolean;
  lastSeekable: boolean;
}
const mem: SyncMemory = {
  trackId: null, playing: false, lastSec: -1,
  lastCanNext: false, lastCanPrev: false, lastSeekable: false,
};

function syncFromStore(): void {
  const ms = mediaSession();
  const s = usePlayer.getState();
  const { current, state, playerMode, queue, index } = s;
  const errored = state === 'ERROR' && !!s.error;

  if (!current || errored) {
    if (mem.trackId !== null || mem.playing) {
      try {
        if (ms) ms.playbackState = 'none';
      } catch {
        /* ignore */
      }
      mem.trackId = null;
      mem.playing = false;
      mem.lastSec = -1;
    }
    if (errored || !current) void clearNativeMediaSession();
    return;
  }

  const live = playerMode === 'radio';
  const playing = state === 'PLAYING' || state === 'BUFFERING';
  const trackId = live ? `radio:${s.currentStation?.id ?? current.id}` : current.id;
  const trackChanged = mem.trackId !== trackId;

  // canNext: more queue ahead, repeat-all loop, or autoplay continuation.
  let autoplay = false;
  try {
    autoplay = useSettings.getState().autoplay;
  } catch {
    /* settings not ready — queue truth only */
  }
  const canNext =
    playerMode !== 'radio' &&
    (index + 1 < queue.length || s.repeat === 'ALL' || autoplay);
  const canPrev = playerMode !== 'radio' && queue.length > 0;
  const seekable = !live && s.durationMs > 0;

  if (trackChanged && ms) {
    const title = live ? (s.currentStation?.name ?? current.title) : current.title;
    const artist = live
      ? `Live${s.currentStation?.country ? ` · ${s.currentStation.country}` : ''}`
      : current.artist;
    const album = live ? (s.currentStation?.language ?? '') : current.album;
    try {
      ms.metadata = new MediaMetadata({
        title,
        artist,
        album,
        artwork: artworkEntries(
          live && s.currentStation?.favicon
            ? { ...current, artworkUrl: s.currentStation.favicon }
            : current,
          live,
        ),
      });
    } catch {
      /* unsupported — controls still work without metadata */
    }
    mem.lastSec = -1;
  }

  if (ms) {
    const want: MediaSessionPlaybackState =
      state === 'PLAYING' || state === 'BUFFERING' ? 'playing'
      : state === 'PAUSED' ? 'paused'
      : 'none';
    try {
      if (ms.playbackState !== want) ms.playbackState = want;
    } catch {
      /* ignore */
    }
    // Position drives the OS progress bar from the real clock — updated on
    // play/pause/seek and throttled to 1s ticks, never a manual timer.
    const sec = Math.floor(s.positionMs / 1000);
    if (!live && seekable && (trackChanged || mem.playing !== playing || Math.abs(sec - mem.lastSec) >= 1)) {
      try {
        ms.setPositionState({
          duration: Math.max(1, s.durationMs / 1000),
          position: Math.max(0, Math.min(sec, s.durationMs / 1000)),
          playbackRate: s.rate || 1,
        });
      } catch {
        /* Safari throws without metadata — harmless */
      }
      mem.lastSec = sec;
    }
  }

  if (
    trackChanged ||
    mem.lastCanNext !== canNext ||
    mem.lastCanPrev !== canPrev ||
    mem.lastSeekable !== seekable
  ) {
    syncCommandAvailability(canPrev, canNext, seekable);
    mem.lastCanNext = canNext;
    mem.lastCanPrev = canPrev;
    mem.lastSeekable = seekable;
  }

  // Native forward (fire-and-forget). Radio omits durations (live).
  const durSec = !live && s.durationMs > 0 ? Math.round(s.durationMs / 1000) : undefined;
  void syncNativeMediaSession({
    trackId,
    title: live ? (s.currentStation?.name ?? current.title) : current.title,
    artist: live ? 'Live' : current.artist,
    album: current.album,
    artwork: current.artworkLocal ?? current.artworkUrl,
    durationSec: durSec,
    positionSec: durSec !== undefined ? Math.floor(s.positionMs / 1000) : undefined,
    rate: s.rate || 1,
    playing,
    live,
    canNext,
    canPrev,
  }).catch(() => undefined);

  mem.trackId = trackId;
  mem.playing = playing;

  // Web / PWA notification: if user granted notification permission, surface an active notification
  try {
    if (typeof window !== 'undefined' && 'Notification' in window && Notification.permission === 'granted') {
      const notifTitle = live ? (s.currentStation?.name ?? current.title) : current.title;
      const notifBody = `${live ? 'Live Radio' : current.artist} • ${playing ? 'Playing' : 'Paused'}`;
      if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then((reg) => {
          reg.showNotification(notifTitle, {
            body: notifBody,
            icon: '/icons/icon-192.png',
            badge: '/icons/icon-192.png',
            tag: 'knox-now-playing',
            silent: true,
          } as NotificationOptions).catch(() => undefined);
        }).catch(() => undefined);
      }
    }
  } catch {
    /* best-effort */
  }
}

let unsubscribe: (() => void) | null = null;

/**
 * Explicit one-shot OS sync for the CURRENT playback state.
 *
 * Reuses syncFromStore so the web MediaSession and the native snapshot are
 * always built from the same single source of truth — no second snapshot
 * builder, no second audio path. Used after the notification permission is
 * granted (Allow) so the first card does not depend on position ticks.
 * Safe with no track (clears) and never throws.
 */
export function syncOsMediaNow(): void {
  try {
    syncFromStore();
  } catch {
    /* explicit sync never breaks callers */
  }
}

/**
 * Install OS media integration once (idempotent). Subscribes to the single
 * playerStore — in-app UI and OS surface can never drift apart.
 * Safe to call during boot and in tests (no-ops without MediaSession).
 */
export function initOsMediaSession(): void {
  installActionHandlers();
  if (unsubscribe) return;
  try {
    unsubscribe = usePlayer.subscribe(syncFromStore);
  } catch {
    unsubscribe = null;
  }
  // Android native surface: transport taps (notification buttons, headset
  // keys via the session) and the notification body tap arrive as Tauri
  // events. The web Media Session handlers above stay installed too —
  // they own the surface on desktop and are harmless on Android.
  if (isTauriAndroid()) {
    void listenNativeMediaEvents((e) => {
      try {
        if (e.kind === 'open-player') {
          window.dispatchEvent(new CustomEvent('knox:open-player'));
          return;
        }
        const st = usePlayer.getState();
        if (e.action === 'prev') void st.prev();
        else if (e.action === 'next') void st.next();
        else if (e.action === 'play') {
          resetContinuityCounters();
          void st.play();
        }
        else if (e.action === 'pause') st.pause();
        else if (e.action === 'stop') st.pause();
        else if (e.action === 'toggle') {
          resetContinuityCounters();
          void st.toggle();
        }
        else if (e.action.startsWith('seek:')) {
          const sec = parseFloat(e.action.slice(5));
          if (!isNaN(sec) && isFinite(sec) && st.playerMode !== 'radio') {
            st.seek(sec * 1000);
          }
        }
      } catch { /* native events never break playback */ }
    }).catch(() => undefined);
  }
  // Push current state immediately (covers restore-then-play ordering).
  try {
    syncFromStore();
  } catch {
    /* best-effort */
  }
}

/**
 * Clear the OS surface (boot + kill-reopen restore). Nothing is playing at
 * boot, so any card the OS kept would be stale — playbackState 'none'
 * releases it. Never throws.
 */
export function clearOsMediaSession(): void {
  mem.trackId = null;
  mem.playing = false;
  mem.lastSec = -1;
  try {
    const ms = mediaSession();
    if (ms) {
      ms.playbackState = 'none';
      ms.metadata = null;
    }
  } catch {
    /* ignore */
  }
  try {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then((reg) => {
        reg.getNotifications({ tag: 'knox-now-playing' }).then((notifs) => {
          notifs.forEach((n) => n.close());
        }).catch(() => undefined);
      }).catch(() => undefined);
    }
  } catch {
    /* best-effort */
  }
  void clearNativeMediaSession();
}

/** For tests: reset module memory. */
export function __resetMediaSessionMemory(): void {
  mem.trackId = null;
  mem.playing = false;
  mem.lastSec = -1;
  mem.lastCanNext = false;
  mem.lastCanPrev = false;
  mem.lastSeekable = false;
  handlersInstalled = false;
  unsubscribe = null;
}
