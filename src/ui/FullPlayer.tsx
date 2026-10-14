import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePlayer } from '../audio/playerStore';
import { useSettings } from '../settings/settingsStore';
import { getAudioEngine } from '../audio/AudioEngine';
import { artworkFor, handleArtworkError, useOfflineStatus } from './SongRow';
import { formatMs, clamp } from '../core/utils';
import { favoriteRepo, playlistRepo, songRepo } from '../data/repositories';
import { toast } from './toast';
import { getProviderManager } from '../providers/ProviderManager';
import { isPreviewSong, previewDurationFor } from '../providers/capabilities';
import { providerLabel } from '../providers/merge';
import { parseLrc, activeLyricIndex } from '../library/lyrics';
import { fetchLyricsForSong } from '../providers/lyrics/lrclib';
import { getDb } from '../data/db';
import { isIOS } from '../os/playbackNotifications';
import type { Song } from '../core/types';
import { Icon, Glyph } from './icons';
import { startYouTubeUpNext, isRealtimeUpNextProvider } from '../providers/youtube/upNext';

const SLEEP_OPTIONS: (number | 'song' | null)[] = [null, 5, 10, 15, 30, 45, 60, 'song'];

function sleepLabel(o: number | 'song' | null): string {
  return o === null ? 'Off' : o === 'song' ? 'End of song' : `${o} min`;
}

/**
 * Scrub-reactive waveform strip. Bars are deterministic per track (stable
 * across renders); the played portion renders in accent/gold, the rest in
 * secondary. Pointer drag seeks. Simplified 36-bar layout prevents overflow
 * or crossing on lower Android WebViews.
 */
function WaveStrip({ seed, pct, onSeek, playing = false }: { seed: string; pct: number; onSeek: (ratio: number) => void; playing?: boolean }) {
  const bars = useMemo(() => {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    const out: number[] = [];
    const count = 36;
    for (let i = 0; i < count; i++) {
      h = (h * 1103515245 + 12345) >>> 0;
      const env = Math.sin(((i + 1) / (count + 1)) * Math.PI);
      const minH = 6;
      const dyn = (h % 18) * env;
      out.push(Math.round(minH + dyn));
    }
    return out;
  }, [seed]);
  const safePct = Number.isFinite(pct) ? clamp(pct, 0, 1) : 0;
  const played = Math.round(safePct * bars.length);
  const dragging = useRef(false);

  const ratioFromClientX = (clientX: number, el: HTMLDivElement) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    onSeek(clamp((clientX - r.left) / r.width, 0, 1));
  };

  return (
    <div
      className={`knox-wave-strip${playing ? ' is-playing' : ''}`}
      role="slider" aria-label="Seek" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={Math.round(safePct * 100)} aria-valuetext={`${Math.round(safePct * 100)} percent played`}
      tabIndex={0}
      onClick={(e) => ratioFromClientX(e.clientX, e.currentTarget)}
      onPointerDown={(e) => {
        (e.currentTarget as HTMLDivElement).setPointerCapture?.(e.pointerId);
        dragging.current = true;
        ratioFromClientX(e.clientX, e.currentTarget as HTMLDivElement);
      }}
      onPointerMove={(e) => { if (dragging.current) ratioFromClientX(e.clientX, e.currentTarget as HTMLDivElement); }}
      onPointerUp={(e) => { dragging.current = false; ratioFromClientX(e.clientX, e.currentTarget as HTMLDivElement); }}
      onPointerCancel={() => { dragging.current = false; }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); onSeek(clamp(safePct + 0.02, 0, 1)); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); onSeek(clamp(safePct - 0.02, 0, 1)); }
      }}
    >
      {bars.map((hh, i) => (
        <span
          key={i}
          style={{ height: hh }}
          data-played={i < played ? 'true' : 'false'}
        />
      ))}
    </div>
  );
}

/**
 * Expanded player — a rounded card sheet over the app (never a full-bleed
 * takeover). Same playerStore as the mini-player and the OS notification:
 * every control here is indistinguishable in effect from lock-screen or
 * notification controls. Handles all three source types: local files (full
 * transport + volume + scrub), radio (no scrub/duration, Live badge,
 * shuffle/repeat disabled), and previews.
 */
export function FullPlayer({ onClose, onOpenAlbum }: { onClose: () => void; onOpenQueue?: () => void; onOpenAlbum?: (s: Song) => void }) {
  const current = usePlayer((s) => s.current);
  const queue = usePlayer((s) => s.queue);
  const queueIndex = usePlayer((s) => s.index);
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);
  const playSong = usePlayer((s) => s.playSong);
  const removeFromQueue = usePlayer((s) => s.removeFromQueue);
  const clearQueue = usePlayer((s) => s.clearQueue);
  const state = usePlayer((s) => s.state);
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const seek = usePlayer((s) => s.seek);
  const shuffle = usePlayer((s) => s.shuffle);
  const setShuffle = usePlayer((s) => s.setShuffle);
  const repeat = usePlayer((s) => s.repeat);
  const setRepeat = usePlayer((s) => s.setRepeat);
  const volume = usePlayer((s) => s.volume);
  const setVolume = usePlayer((s) => s.setVolume);
  const muted = usePlayer((s) => s.muted);
  const setMuted = usePlayer((s) => s.setMuted);
  const setSleepTimer = usePlayer((s) => s.setSleepTimer);
  const sleepTimerEndsAt = usePlayer((s) => s.sleepTimerEndsAt);
  const qualityLabel = usePlayer((s) => s.qualityLabel);
  const previewEnded = usePlayer((s) => s.previewEnded);
  const playerError = usePlayer((s) => s.error);
  const clearPlayerError = usePlayer((s) => s.clearError);
  const retryCurrent = usePlayer((s) => s.retryCurrent);
  // Rules-of-Hooks: ALL subscriptions must run unconditionally before any
  // early return (see original comment — fewer hooks on current→null
  // unmounted the whole tree / black WebView while audio kept playing).
  const playerMode = usePlayer((s) => s.playerMode);
  const currentStation = usePlayer((s) => s.currentStation);
  const autoplayNotice = usePlayer((s) => s.autoplayNotice);
  const dismissAutoplayNotice = usePlayer((s) => s.dismissAutoplayNotice);
  const outputDeviceId = useSettings((s) => s.outputDeviceId);
  const patchSettings = useSettings((s) => s.patch);
  const autoplayOn = useSettings((s) => s.autoplay);
  const uiStyle = useSettings((s) => s.uiStyle);
  const nextSong = queueIndex + 1 < queue.length ? queue[queueIndex + 1] : null;
  const upcomingSongs = useMemo(
    () => (queueIndex >= 0 && queueIndex + 1 < queue.length ? queue.slice(queueIndex + 1, queueIndex + 12) : []),
    [queue, queueIndex],
  );

  const [view, setView] = useState<'controls' | 'lyrics' | 'queue' | 'info'>('controls');
  const [lyrics, setLyrics] = useState<{ timeMs: number; text: string }[] | null>(null);
  const [lyricsSynced, setLyricsSynced] = useState(true);
  const [lyricsSource, setLyricsSource] = useState<string | null>(null);
  const [lyricsState, setLyricsState] = useState<'loading' | 'ready' | 'empty'>('loading');
  const [isFav, setIsFav] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [sleepIdx, setSleepIdx] = useState(0);
  const [sleepOpen, setSleepOpen] = useState(false);
  const [deviceOpen, setDeviceOpen] = useState(false);
  const [scrubDrag, setScrubDrag] = useState(false);
  const [outputSupported, setOutputSupported] = useState(false);
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [isClosing, setIsClosing] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const [upNextRefreshing, setUpNextRefreshing] = useState(false);
  const [cardSwipeAnim, setCardSwipeAnim] = useState<'left' | 'right' | null>(null);
  const [cardSwipePhase, setCardSwipePhase] = useState<0 | 1>(0);
  const touchY = useRef<number | null>(null);
  const stageTouchX = useRef<number | null>(null);
  const stageTouchY = useRef<number | null>(null);
  const stageAxisRef = useRef<'x' | 'y' | null>(null);
  const closingRef = useRef(false);
  const autoMixSeedRef = useRef<string | null>(null);

  const triggerCardSwipe = React.useCallback((dir: 'left' | 'right') => {
    setCardSwipeAnim(dir);
    setCardSwipePhase((p) => (p === 0 ? 1 : 0));
  }, []);

  const handleStagePointerMove = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'touch') return;
    const el = e.currentTarget;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    const ny = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    const tx = clamp(-ny * 6, -8, 8).toFixed(2);
    const ty = clamp(nx * 8, -10, 10).toFixed(2);
    el.style.setProperty('--stage-tilt-x', `${tx}deg`);
    el.style.setProperty('--stage-tilt-y', `${ty}deg`);
  }, []);

  const handleStagePointerReset = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    el.style.setProperty('--stage-tilt-x', '0deg');
    el.style.setProperty('--stage-tilt-y', '0deg');
  }, []);

  const resetStageSwipeStyle = React.useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    el.style.removeProperty('--card-swipe-x');
    el.style.removeProperty('--card-swipe-rot');
    el.classList.remove('is-card-swiping');
  }, []);

  const handleStageTouchStart = React.useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length !== 1) return;
    stageTouchX.current = e.touches[0].clientX;
    stageTouchY.current = e.touches[0].clientY;
    stageAxisRef.current = null;
  }, []);

  const handleStageTouchMove = React.useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    if (stageTouchX.current === null || stageTouchY.current === null) return;
    const dx = e.touches[0].clientX - stageTouchX.current;
    const dy = e.touches[0].clientY - stageTouchY.current;
    const el = e.currentTarget;

    if (stageAxisRef.current === null) {
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        stageAxisRef.current = 'x';
      } else if (Math.abs(dy) > 12) {
        stageAxisRef.current = 'y';
        resetStageSwipeStyle(el);
        return;
      }
    }

    if (stageAxisRef.current === 'x') {
      e.stopPropagation();
      const clampedX = clamp(dx * 0.55, -120, 120);
      const rot = clamp(dx * 0.045, -7, 7);
      el.classList.add('is-card-swiping');
      el.style.setProperty('--card-swipe-x', `${clampedX.toFixed(1)}px`);
      el.style.setProperty('--card-swipe-rot', `${rot.toFixed(2)}deg`);
    }
  }, [resetStageSwipeStyle]);

  const handleStageTouchEnd = React.useCallback((e: React.TouchEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    if (stageTouchX.current === null || stageTouchY.current === null) {
      resetStageSwipeStyle(el);
      return;
    }
    const dx = e.changedTouches[0].clientX - stageTouchX.current;
    const dy = e.changedTouches[0].clientY - stageTouchY.current;
    const axis = stageAxisRef.current;
    stageTouchX.current = null;
    stageTouchY.current = null;
    stageAxisRef.current = null;
    resetStageSwipeStyle(el);

    if (axis === 'x' || (Math.abs(dx) > 52 && Math.abs(dx) > Math.abs(dy) * 1.3)) {
      e.stopPropagation();
      if (dx < -52) {
        triggerCardSwipe('left');
        void next();
      } else if (dx > 52) {
        triggerCardSwipe('right');
        void prev();
      }
    }
  }, [next, prev, resetStageSwipeStyle, triggerCardSwipe]);

  // Automatically populate real-time Up Next station if a single track from
  // YouTube, YouTube Music, Spotify, or JioSaavn is playing without a queue.
  useEffect(() => {
    if (!current || playerMode === 'radio') return;
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') return;
    if (
      autoplayOn &&
      isRealtimeUpNextProvider(current.providerId) &&
      queue.length <= 1 &&
      autoMixSeedRef.current !== current.id
    ) {
      autoMixSeedRef.current = current.id;
      void startYouTubeUpNext(current);
    }
  }, [current?.id, current?.providerId, queue.length, autoplayOn, playerMode]);

  const handleRefreshUpNext = React.useCallback(async () => {
    if (!current || upNextRefreshing) return;
    setUpNextRefreshing(true);
    try {
      await startYouTubeUpNext(current);
      toast(`↻ Updated ${providerLabel(current.providerId)} real-time playlist`);
    } finally {
      setUpNextRefreshing(false);
    }
  }, [current, upNextRefreshing]);

  const handleClose = React.useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    setIsClosing(true);
    if (typeof process !== 'undefined' && process.env?.NODE_ENV === 'test') {
      onClose();
      return;
    }
    setTimeout(() => {
      onClose();
    }, 280);
  }, [onClose]);

  useEffect(() => {
    if (!current) return;
    let live = true;
    setLyricsState('loading');
    setLyricsSource(null);
    favoriteRepo.isFavorite(current.id).then((f) => { if (live) setIsFav(f); }).catch(() => undefined);
    (async () => {
      try {
        // 1. local .lrc sidecar stored in lyrics table
        const local = await getDb().lyrics.get(current.id).catch(() => undefined);
        if (local && local.lines.length > 0 && live) {
          setLyrics(local.lines); setLyricsSynced(local.synced);
          setLyricsSource(local.source); setLyricsState('ready'); return;
        }
        // 2. LRCLIB (local cache → exact → search fallback). Async and
        // isolated — lyrics loading never touches the audio engine.
        const lrc = await fetchLyricsForSong(current).catch(() => null);
        if (lrc && lrc.lines.length > 0 && live) {
          setLyrics(lrc.lines); setLyricsSynced(lrc.synced);
          setLyricsSource(lrc.source); setLyricsState('ready'); return;
        }
        // 3. provider lyrics where legally available
        const pm = getProviderManager();
        const p = pm.get(current.providerId);
        if (p?.capabilities.supportsLyrics) {
          const l = await p.getLyrics(current);
          if (live) {
            if (l && l.lines.length > 0) {
              setLyrics(l.lines); setLyricsSynced(l.synced);
              setLyricsSource(p.name); setLyricsState('ready');
            }
            else setLyricsState('empty');
            return;
          }
        }
        // 4. local file embedded lyrics are not faked — show honest empty state
        if (live) setLyricsState('empty');
      } catch { if (live) setLyricsState('empty'); }
    })();
    return () => { live = false; };
  }, [current?.id]);

  const activeIdx = useMemo(
    () => (lyrics && lyricsSynced ? activeLyricIndex(lyrics, positionMs) : -1),
    [lyrics, lyricsSynced, positionMs],
  );

  useEffect(() => {
    const el = document.getElementById(`lyric-${activeIdx}`);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [activeIdx]);

  // Output-device routing: probe once per track (labels can appear late on
  // first enumerate). No probe, no icon — never a dead button.
  useEffect(() => {
    let live = true;
    try {
      const engine = getAudioEngine();
      const ok = engine.supportsOutputSelection();
      if (live) setOutputSupported(ok);
      if (ok) engine.listOutputDevices().then((d) => { if (live) setDevices(d); }).catch(() => undefined);
    } catch { if (live) setOutputSupported(false); }
    return () => { live = false; };
  }, [current?.id]);

  // Escape dismisses the sheet (overflow menu consumes its own keys first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); handleClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleClose]);

  // Strict offline truth (§17): ONLY the live offlineRepo check counts —
  // the isOfflineAvailable flag can go stale and is never consulted here.
  // Hook MUST run unconditionally before the early return (Rules-of-Hooks):
  // pass an empty id when nothing is playing; the hook returns false then.
  const offlineAvailable = useOfflineStatus(current?.id ?? '');

  // Always a valid UI: artwork/title/artist render from currentTrack even
  // when stream resolution failed (error banner below, never a black screen).
  // Single HTMLAudioElement lives in the singleton AudioEngine — no <audio>
  // in JSX, ever. All controls read live playerStore state (synced).
  if (!current) return null;
  const art = artworkFor(current);
  const playing = state === 'PLAYING';
  const busy = state === 'LOADING' || state === 'BUFFERING';
  const pct = durationMs > 0 ? clamp(positionMs / durationMs, 0, 1) : 0;
  const provider = getProviderManager().get(current.providerId);
  const isPreview = isPreviewSong(current);
  const isRadio = playerMode === 'radio';
  const sleepRemaining = sleepTimerEndsAt ? Math.max(0, sleepTimerEndsAt - Date.now()) : null;
  // Disabled-but-present controls keep the layout from shifting.
  const shuffleDisabled = isRadio;
  const repeatDisabled = isRadio;
  const canNext = isRadio ? false : (queueIndex + 1 < queue.length || repeat === 'ALL' || autoplayOn);
  const showVolume = !isRadio && !isIOS();

  // Format caption from real metadata only — missing parts are dropped,
  // never hardcoded. e.g. "2016 · 320kbps · Local file" / "Live · MP3 128k · Radio".
  const captionParts: string[] = [];
  if (isRadio) {
    captionParts.push('Live');
    const tech = [currentStation?.codec?.toUpperCase(), currentStation?.bitrate ? `${currentStation.bitrate}k` : ''].filter(Boolean).join(' ');
    if (tech) captionParts.push(tech);
    captionParts.push('Radio');
  } else {
    if (current.year) captionParts.push(String(current.year));
    if (qualityLabel) captionParts.push(qualityLabel);
    captionParts.push(current.isLocalFile ? 'Local file' : (provider?.name ?? current.providerId));
  }
  const outputLabel = devices.find((d) => d.deviceId === outputDeviceId)?.label ?? 'System default';

  const isWebId = current.providerId.startsWith('web-');
  const isDiscovery = !isRadio && (isWebId
    || provider?.capabilities.supportsStreaming === false
    || (current.capabilities?.streamable === false && !current.streamUrl && !current.isLocalFile && !offlineAvailable));
  const canOffline = !isRadio && !isPreview && !isDiscovery
    && (provider?.capabilities.supportsOffline ?? false) && current.downloadAllowed !== false;

  const doOffline = async () => {
    try {
      const { useDownloads } = await import('../downloads/DownloadManager');
      await useDownloads.getState().enqueue(current);
      toast('↓ Download queued');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Download failed', 'warn');
    }
  };

  const doFavorite = async () => {
    try {
      await songRepo.upsert({ ...current, addedAt: current.addedAt || Date.now() }).catch(() => undefined);
      if (isFav) {
        await favoriteRepo.remove(current.id);
        setIsFav(false);
        toast('Removed from Favorites');
      } else {
        await favoriteRepo.add(current.id);
        setIsFav(true);
        toast('Added to Favorites');
      }
      window.dispatchEvent(new CustomEvent('knox:favorites-updated'));
    } catch { toast('Could not update Favorites', 'warn'); }
  };

  const doShare = async () => {
    const text = `${current.title} — ${current.artist} (${current.album})`;
    try {
      const nav = navigator as Navigator & { share?: (d: { title: string; text: string; url?: string }) => Promise<void> };
      if (typeof nav.share === 'function') {
        await nav.share({ title: current.title, text, url: current.sourceUrl });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(current.sourceUrl ? `${text}\n${current.sourceUrl}` : text);
        toast('Song info copied');
      } else {
        toast(text);
      }
    } catch { /* user cancelled share — silent */ }
  };

  const doAddToPlaylist = async () => {
    await songRepo.upsert({ ...current, addedAt: current.addedAt || Date.now() }).catch(() => undefined);
    const pls = await playlistRepo.list();
    const name = window.prompt(`Add to playlist (existing: ${pls.map((p) => p.name).join(', ') || 'none'}). Type a new name to create:`);
    if (!name) return;
    const found = pls.find((p) => p.name.toLowerCase() === name.toLowerCase());
    if (found) { await playlistRepo.addTrack(found.id, current.id); toast(`Added to ${found.name}`); }
    else { const pl = await playlistRepo.create(name, '', [current.id]); toast(`Created playlist ${pl.name}`); }
    window.dispatchEvent(new CustomEvent('knox:playlists-updated'));
  };

  const chooseOutput = async (id: string) => {
    try {
      await getAudioEngine().setOutputDevice(id);
      await patchSettings({ outputDeviceId: id });
      setDevices(await getAudioEngine().listOutputDevices().catch(() => devices));
      toast(id === 'default' ? 'Output: System default' : 'Output device changed');
    } catch { toast('Could not switch output', 'warn'); }
    setDeviceOpen(false);
  };

  const cycleRepeat = () => setRepeat(repeat === 'OFF' ? 'ALL' : repeat === 'ALL' ? 'ONE' : 'OFF');

  const seekFromClientX = (clientX: number, el: HTMLDivElement) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    seek(clamp((clientX - r.left) / r.width, 0, 1) * durationMs);
  };

  const closeMenus = () => { setOverflowOpen(false); setSleepOpen(false); setDeviceOpen(false); };

  return (
    <div
      className="knox-sheet-backdrop now-playing"
      role="dialog"
      aria-label={`Now playing ${current.title}`}
      style={{
        opacity: isClosing ? 0 : dragOffset > 0 ? Math.max(0.15, 1 - dragOffset / 500) : 1,
        transition: dragOffset > 0 ? 'none' : 'opacity 0.28s ease',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div
        className="knox-sheet knox-floating-player"
        style={{
          transform: isClosing ? 'translateY(100%)' : dragOffset > 0 ? `translateY(${dragOffset}px)` : undefined,
          transition: dragOffset > 0 ? 'none' : 'transform 0.28s cubic-bezier(0.2, 0.9, 0.3, 1)',
        }}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => {
          const el = e.currentTarget as HTMLDivElement;
          touchY.current = el.scrollTop <= 0 ? e.touches[0].clientY : null;
        }}
        onTouchMove={(e) => {
          if (touchY.current === null) return;
          const el = e.currentTarget as HTMLDivElement;
          if (el.scrollTop > 0) {
            touchY.current = null;
            if (dragOffset !== 0) setDragOffset(0);
            return;
          }
          const dy = e.touches[0].clientY - touchY.current;
          if (dy > 14) setDragOffset(dy);
        }}
        onTouchEnd={(e) => {
          if (touchY.current === null) return;
          const dy = e.changedTouches[0].clientY - touchY.current;
          touchY.current = null;
          if (dy > 100) {
            handleClose();
          } else if (dragOffset !== 0) {
            setDragOffset(0);
          }
        }}
      >
        <div className="knox-drag-handle" aria-hidden />

        {/* Top row: collapse left, Now Playing title center, queue right (Image 1) */}
        <div className="knox-sheet-toprow">
          <button className="knox-icon-btn" onClick={handleClose} aria-label="Close full player" title="Collapse to mini player (playback continues)">⌄</button>
          <span className="knox-nowplaying-title">Now Playing</span>
          <button
            className="knox-icon-btn"
            onClick={() => setView(view === 'queue' ? 'controls' : 'queue')}
            aria-label="Queue"
            title="Open queue"
          ><Icon name="list" size={18} /></button>
        </div>
        {overflowOpen && (
          <div className="menu" role="menu" aria-label="More options" style={{ position: 'static', marginBottom: 8 }}>
            <button type="button" role="menuitem" onClick={() => { closeMenus(); void doAddToPlaylist(); }}><Icon name="pencil" size={14} /> Add to playlist</button>
            <button type="button" role="menuitem" onClick={() => { closeMenus(); void doShare(); }}>↗ Share</button>
            <button
              type="button" role="menuitem" aria-expanded={sleepOpen}
              onClick={() => setSleepOpen((v) => !v)}
            >⏾ Sleep timer{sleepRemaining !== null ? ` (${formatMs(sleepRemaining)} left)` : ''} ›</button>
            {sleepOpen && SLEEP_OPTIONS.map((o) => (
              <button
                key={String(o)} type="button" role="menuitemradio" aria-checked={SLEEP_OPTIONS[sleepIdx] === o}
                style={{ paddingLeft: 28 }}
                onClick={() => {
                  setSleepIdx(SLEEP_OPTIONS.indexOf(o));
                  setSleepTimer(o);
                  toast(o === null ? 'Sleep timer off' : `Sleep timer: ${sleepLabel(o)}`);
                  closeMenus();
                }}
              >{o === null ? 'Off' : sleepLabel(o)}</button>
            ))}
            <button
              type="button" role="menuitem" disabled={!onOpenAlbum}
              title={onOpenAlbum ? 'Open this album' : 'Album view unavailable here'}
              onClick={() => { if (!onOpenAlbum) return; const s = current; closeMenus(); onClose(); onOpenAlbum(s); }}
            >⊙ Go to album</button>
            {outputSupported && (
              <button
                type="button" role="menuitem"
                onClick={() => { setOverflowOpen(false); setDeviceOpen(true); }}
              ><Icon name="radio" size={14} /> Output: {outputLabel}</button>
            )}
          </div>
        )}

        {view === 'controls' && (
          <>
            {/* 6-Type 3D Interactive Artwork Stage: Clay Turntable, Neubrutal 3D Block Deck, Pixel CRT Voxel Deck, Spatial 3D Vision Stage, Neomorphic 3D Studio Deck, and 3D Glass Prism Stage */}
            <div
              className={`knox-3d-stage-interactive${
                cardSwipeAnim
                  ? ` knox-card-swipe-${cardSwipeAnim} knox-card-swipe-${cardSwipeAnim}-${cardSwipePhase}`
                  : ''
              }`}
              onPointerMove={handleStagePointerMove}
              onPointerLeave={handleStagePointerReset}
              onPointerCancel={handleStagePointerReset}
              onTouchStart={handleStageTouchStart}
              onTouchMove={handleStageTouchMove}
              onTouchEnd={handleStageTouchEnd}
              onTouchCancel={(e) => resetStageSwipeStyle(e.currentTarget)}
              onAnimationEnd={(e) => {
                if (e.target === e.currentTarget) setCardSwipeAnim(null);
              }}
            >
              {uiStyle === 'claymorphism' ? (
                <div className="knox-clay-vinyl-deck">
                  <div className={`knox-clay-vinyl-disc${playing ? ' is-spinning' : ''}`}>
                    <div className="knox-vinyl-grooves">
                      <div className="knox-vinyl-groove groove-1" />
                      <div className="knox-vinyl-groove groove-2" />
                      <div className="knox-vinyl-groove groove-3" />
                      <div className="knox-vinyl-center-label">
                        {(current.artworkLocal || current.artworkUrl) ? (
                          <img
                            key={current.id}
                            src={art}
                            alt={`${current.album} artwork`}
                            className="knox-vinyl-art-img"
                            onError={handleArtworkError(current)}
                          />
                        ) : (
                          <div
                            className="knox-vinyl-art-placeholder"
                            role="img"
                            aria-label={`${current.album} artwork placeholder`}
                          >
                            {isRadio ? <Glyph char="◉" size={36} /> : <Glyph char="♪" size={36} />}
                          </div>
                        )}
                        <div className="knox-vinyl-spindle" />
                      </div>
                    </div>
                  </div>
                  <div className={`knox-vinyl-tonearm${playing ? ' is-active' : ''}`} aria-hidden="true">
                    <div className="knox-vinyl-tonearm-pivot" />
                    <div className="knox-vinyl-tonearm-rod" />
                    <div className="knox-vinyl-tonearm-head" />
                  </div>
                </div>
              ) : uiStyle === 'neubrutalism' ? (
                <div className="knox-sheet-art-wrap knox-3d-stage-brutal">
                  <div className={`knox-brutal-3d-stack${playing ? ' is-bouncing' : ''}`}>
                    <div className="knox-brutal-3d-layer layer-back" aria-hidden="true" />
                    <div className="knox-brutal-3d-layer layer-mid" aria-hidden="true" />
                    <div className="knox-brutal-3d-frame">
                      <div className="knox-brutal-sticker-top" aria-hidden="true">
                        {playing ? '★ NOW PLAYING 3D ★' : '■ PAUSED DECK'}
                      </div>
                      {(current.artworkLocal || current.artworkUrl) ? (
                        <img
                          key={current.id}
                          src={art}
                          alt={`${current.album} artwork`}
                          className="knox-sheet-art knox-sheet-art-fade knox-img-gold"
                          onError={handleArtworkError(current)}
                        />
                      ) : (
                        <span
                          key={current.id}
                          className="knox-sheet-art knox-sheet-art-fade knox-player-art-fallback"
                          role="img"
                          aria-label={`${current.album} artwork placeholder`}
                          style={{ display: 'grid', placeItems: 'center', fontSize: 72 }}
                        >{isRadio ? <Glyph char="◉" size={72} /> : <Glyph char="♪" size={72} />}</span>
                      )}
                      <div className="knox-brutal-sticker-bottom" aria-hidden="true">STEREO POP</div>
                    </div>
                  </div>
                </div>
              ) : uiStyle === 'pixel_art' ? (
                <div className="knox-sheet-art-wrap knox-3d-stage-pixel">
                  <div className="knox-pixel-crt-bezel">
                    <div className="knox-pixel-crt-header" aria-hidden="true">
                      <span className="knox-pixel-led" data-playing={playing ? 'true' : 'false'} />
                      <span>1P SOUND TEST · 8-BIT</span>
                      <span>CH-01</span>
                    </div>
                    <div className="knox-pixel-crt-screen">
                      {(current.artworkLocal || current.artworkUrl) ? (
                        <img
                          key={current.id}
                          src={art}
                          alt={`${current.album} artwork`}
                          className="knox-sheet-art knox-sheet-art-fade knox-img-gold"
                          onError={handleArtworkError(current)}
                        />
                      ) : (
                        <span
                          key={current.id}
                          className="knox-sheet-art knox-sheet-art-fade knox-player-art-fallback"
                          role="img"
                          aria-label={`${current.album} artwork placeholder`}
                          style={{ display: 'grid', placeItems: 'center', fontSize: 72 }}
                        >{isRadio ? <Glyph char="◉" size={72} /> : <Glyph char="♪" size={72} />}</span>
                      )}
                      <div className="knox-pixel-crt-scanlines" aria-hidden="true" />
                    </div>
                  </div>
                </div>
              ) : uiStyle === 'spatial_ui' ? (
                <div className="knox-sheet-art-wrap knox-3d-stage-spatial">
                  <div className={`knox-spatial-3d-holo knox-spatial-big-card${playing ? ' is-orbiting' : ''}`}>
                    <div className="knox-spatial-aurora-field" aria-hidden="true" />
                    {(current.artworkLocal || current.artworkUrl) && (
                      <div
                        className="knox-spatial-art-ambient"
                        style={{ backgroundImage: `url(${art})` }}
                        aria-hidden="true"
                      />
                    )}
                    {/* Top VisionOS Spatial Telemetry Bar */}
                    <div className="knox-spatial-card-header" aria-hidden="true">
                      <span className="knox-spatial-telemetry-pill">
                        <span className={`knox-spatial-pulse-dot${playing ? ' active' : ''}`} />
                        <span>✦ SPATIAL AUDIO</span>
                      </span>
                      <span className="knox-spatial-mode-pill">
                        {isRadio ? 'LIVE FIELD' : (provider?.name ?? current.providerId).toUpperCase()} · 360°
                      </span>
                    </div>

                    {/* Non-intersecting Orbital Stage + Holographic Prism Artwork */}
                    <div className="knox-spatial-stage-core">
                      <div className="knox-spatial-gyro-ring ring-outer" aria-hidden="true" />
                      <div className="knox-spatial-gyro-ring ring-inner" aria-hidden="true" />
                      <div className="knox-spatial-gyro-ring ring-halo" aria-hidden="true" />
                      <div className="knox-spatial-art-prism">
                        <span className="knox-spatial-reticle tl" aria-hidden="true" />
                        <span className="knox-spatial-reticle tr" aria-hidden="true" />
                        <span className="knox-spatial-reticle bl" aria-hidden="true" />
                        <span className="knox-spatial-reticle br" aria-hidden="true" />
                        {(current.artworkLocal || current.artworkUrl) ? (
                          <img
                            key={current.id}
                            src={art}
                            alt={`${current.album} artwork`}
                            className="knox-sheet-art knox-img-gold"
                            onError={handleArtworkError(current)}
                          />
                        ) : (
                          <span
                            key={current.id}
                            className="knox-sheet-art knox-player-art-fallback"
                            role="img"
                            aria-label={`${current.album} artwork placeholder`}
                            style={{ display: 'grid', placeItems: 'center', fontSize: 72 }}
                          >{isRadio ? <Glyph char="◉" size={72} /> : <Glyph char="♪" size={72} />}</span>
                        )}
                        <div className="knox-spatial-prism-sheen" aria-hidden="true" />
                      </div>
                    </div>

                    {/* Bottom Spatial Acoustic Telemetry & Live Spectrum Footer */}
                    <div className="knox-spatial-card-footer" aria-hidden="true">
                      <div className="knox-spatial-footer-meta">
                        <span className="knox-spatial-footer-label">VISION DECK · DOLBY ATMOS FIELD</span>
                        <span className="knox-spatial-footer-sub">
                          {current.album ? current.album : (qualityLabel || '24-Bit Spatial Prism')}
                        </span>
                      </div>
                      <div className={`knox-spatial-eq-bars${playing ? ' active' : ''}`}>
                        <span /><span /><span /><span /><span /><span /><span />
                      </div>
                    </div>
                  </div>
                </div>
              ) : uiStyle === 'neomorphism' ? (
                <div className="knox-sheet-art-wrap knox-3d-stage-neomorph">
                  <div className={`knox-neomorph-studio-deck${playing ? ' is-resonating' : ''}`}>
                    <span className="knox-neomorph-screw tl" aria-hidden="true" />
                    <span className="knox-neomorph-screw tr" aria-hidden="true" />
                    <span className="knox-neomorph-screw bl" aria-hidden="true" />
                    <span className="knox-neomorph-screw br" aria-hidden="true" />
                    <div className="knox-neomorph-speaker-well">
                      <div className="knox-neomorph-acoustic-ring ring-1" aria-hidden="true" />
                      <div className="knox-neomorph-acoustic-ring ring-2" aria-hidden="true" />
                      <div className="knox-neomorph-platter">
                        {(current.artworkLocal || current.artworkUrl) ? (
                          <img
                            key={current.id}
                            src={art}
                            alt={`${current.album} artwork`}
                            className="knox-sheet-art knox-sheet-art-fade knox-img-gold"
                            onError={handleArtworkError(current)}
                          />
                        ) : (
                          <span
                            key={current.id}
                            className="knox-sheet-art knox-sheet-art-fade knox-player-art-fallback"
                            role="img"
                            aria-label={`${current.album} artwork placeholder`}
                            style={{ display: 'grid', placeItems: 'center', fontSize: 72 }}
                          >{isRadio ? <Glyph char="◉" size={72} /> : <Glyph char="♪" size={72} />}</span>
                        )}
                      </div>
                    </div>
                    <div className="knox-neomorph-vu-pill" aria-hidden="true">
                      <span className={`knox-neomorph-led${playing ? ' on' : ''}`} />
                      <span>STUDIO 3D DECK</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="knox-sheet-art-wrap knox-3d-stage-glass">
                  <div className={`knox-glass-prism-pedestal${playing ? ' is-levitating' : ''}`}>
                    <div className="knox-glass-prism-glow" aria-hidden="true" />
                    {(current.artworkLocal || current.artworkUrl) ? (
                      <img
                        key={current.id}
                        src={art}
                        alt={`${current.album} artwork`}
                        className="knox-sheet-art knox-sheet-art-fade knox-img-gold"
                        onError={handleArtworkError(current)}
                      />
                    ) : (
                      <span
                        key={current.id}
                        className="knox-sheet-art knox-sheet-art-fade knox-player-art-fallback"
                        role="img"
                        aria-label={`${current.album} artwork placeholder`}
                        style={{ display: 'grid', placeItems: 'center', fontSize: 72 }}
                      >{isRadio ? <Glyph char="◉" size={72} /> : <Glyph char="♪" size={72} />}</span>
                    )}
                    <div className="knox-glass-prism-reflection" aria-hidden="true">
                      <span>◈ 3D LIQUID AUDIO</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {deviceOpen && outputSupported && (
              <div className="menu" role="menu" aria-label="Output device" style={{ position: 'static', margin: '8px auto', maxWidth: 420 }}>
                <button type="button" role="menuitemradio" aria-checked={outputDeviceId === 'default'} onClick={() => void chooseOutput('default')}>
                  {outputDeviceId === 'default' ? '● ' : '○ '}System default
                </button>
                {devices.filter((d) => d.deviceId !== 'default').map((d) => (
                  <button key={d.deviceId} type="button" role="menuitemradio" aria-checked={d.deviceId === outputDeviceId} onClick={() => void chooseOutput(d.deviceId)}>
                    {d.deviceId === outputDeviceId ? '● ' : '○ '}{d.label || 'Audio output'}
                  </button>
                ))}
              </div>
            )}

            {/* Track Info Row: Heart left, Title & Artist center, More right */}
            <div className="knox-np-info-row">
              <button
                className="knox-icon-btn knox-np-fav"
                onClick={() => void doFavorite()}
                aria-pressed={isFav}
                aria-label={isFav ? 'Remove from Favorites' : 'Add to Favorites'}
                title={isFav ? 'Remove from Favorites' : 'Add to Favorites'}
                style={{ color: isFav ? 'var(--accent-gold)' : undefined }}
              >{isFav ? <Icon name="heart" size={22} /> : <Icon name="heartOutline" size={22} />}</button>

              <div className="knox-np-center-info">
                <div className="knox-sheet-title" title={current.title}>{current.title}</div>
                <div className="knox-sheet-artist" title={`${current.artist} — ${current.album}`}>
                  {isRadio && currentStation ? currentStation.name : current.artist}
                </div>
              </div>

              <button
                className="knox-icon-btn"
                onClick={() => { setSleepOpen(false); setDeviceOpen(false); setOverflowOpen((v) => !v); }}
                aria-label="More options"
                aria-expanded={overflowOpen}
                aria-haspopup="menu"
              ><span style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>⋮</span></button>
            </div>

            {playerError && (
              <div role="alert" className="np-error" style={{ maxWidth: 420, margin: '8px auto 0', width: '100%' }}>
                <strong>Unable to play this track</strong>
                <span>{playerError}</span>
                <span style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-primary" style={{ padding: '6px 14px', fontSize: 12.5 }} onClick={() => void retryCurrent()}>Tap to retry</button>
                  <button className="btn" style={{ padding: '6px 14px', fontSize: 12.5 }} onClick={() => clearPlayerError()}>Dismiss</button>
                </span>
              </div>
            )}
            {!isRadio && isPreview && (
              <p style={{ color: 'var(--accent-gold)', fontSize: 12.5, fontWeight: 700, margin: '6px auto 0', maxWidth: 420, width: '100%', padding: '0 4px', textAlign: 'center' }} aria-label="30-second preview">
                {providerLabel(current.providerId)} · Preview 30s
              </p>
            )}
            {isPreview && previewEnded && (
              <p role="status" style={{ color: 'var(--accent-gold)', fontSize: 12.5, margin: '4px auto 0', maxWidth: 420, width: '100%', padding: '0 4px', textAlign: 'center' }}>
                Preview ended — press Play to replay from 0:00
              </p>
            )}
            {autoplayNotice && (
              <p role="status" style={{ color: 'var(--text-2)', fontSize: 12, margin: '4px auto 0', maxWidth: 420, width: '100%', padding: '0 4px', textAlign: 'center' }}>
                {autoplayNotice} <button className="ghost-icon-btn" style={{ width: 24, height: 24, display: 'inline-grid' }} onClick={dismissAutoplayNotice} aria-label="Dismiss autoplay notice"><Icon name="close" size={12} /></button>
              </p>
            )}

            {/* Waveform Scrubber Row (Image 1): elapsed time left, WaveStrip center, total time right */}
            {isRadio ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 4px', maxWidth: 420, margin: '0 auto', width: '100%' }} aria-label="Live radio">
                <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{currentStation?.name ?? current.title}</span>
                <span className="cap-chip live" aria-label="Live">● LIVE</span>
              </div>
            ) : (
              <div className="knox-wave-scrub-container">
                <span className="knox-time">{formatMs(positionMs)}</span>
                <div className="knox-wave-strip-wrap">
                  <WaveStrip seed={`${current.id}-${current.title}`} pct={pct} onSeek={(r) => seek(r * durationMs)} playing={playing} />
                </div>
                <span className="knox-time right">{formatMs(durationMs)}</span>
              </div>
            )}

            {/* Transport: shuffle · previous · big circular play · next · repeat (Image 1) */}
            <div className="knox-transport-5" role="toolbar" aria-label="Playback controls">
              <button
                className="knox-t5-btn"
                onClick={() => setShuffle(!shuffle)}
                aria-label="Shuffle"
                aria-pressed={shuffle}
                title="Shuffle"
                disabled={shuffleDisabled}
                style={{ opacity: shuffle ? 1 : 0.6, color: shuffle ? 'var(--accent)' : undefined }}
              ><Icon name="shuffle" size={19} /></button>
              <button
                className="knox-t5-btn"
                onClick={() => { triggerCardSwipe('right'); void prev(); }}
                aria-label="Previous"
                title="Previous track"
              ><Icon name="prev" size={21} /></button>
              <button
                className="knox-play-btn-circle"
                onClick={() => void toggle()}
                aria-label={playing ? 'Pause' : 'Play'}
                title={playing ? 'Pause' : 'Play'}
              >
                {playing ? <Icon name="pause" size={24} /> : <Icon name="play" size={24} />}
              </button>
              <button
                className="knox-t5-btn"
                onClick={() => { triggerCardSwipe('left'); void next(); }}
                aria-label="Next"
                disabled={!canNext}
                title="Next track"
              ><Icon name="next" size={21} /></button>
              <button
                className="knox-t5-btn"
                onClick={cycleRepeat}
                aria-label={`Repeat ${repeat}`}
                aria-pressed={repeat !== 'OFF'}
                title={`Repeat: ${repeat}`}
                disabled={repeatDisabled}
                style={{ opacity: repeat !== 'OFF' ? 1 : 0.6, color: repeat !== 'OFF' ? 'var(--accent)' : undefined }}
              ><span style={{ position: 'relative', display: 'inline-flex' }}><Icon name="repeat" size={19} />{repeat === 'ONE' && <span style={{ position: 'absolute', right: -5, bottom: -4, fontSize: 9, fontWeight: 800 }}>1</span>}</span></button>
            </div>

            {/* Volume — hidden where the OS owns it (iOS) and for live radio. */}
            {showVolume && (
              <div className="knox-vol-row" style={{ maxWidth: 420, margin: '8px auto 2px', width: '100%', padding: '0 4px' }}>
                <button className="ghost-icon-btn" onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}><Icon name={muted ? 'volumeX' : 'volume'} size={17} /></button>
                <input
                  type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume}
                  onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume"
                />
                <button className="ghost-icon-btn" onClick={() => { setMuted(false); setVolume(1); }} aria-label="Full volume"><Icon name="volume" size={17} /></button>
              </div>
            )}

            {/* Up Next Preview Dock — lets user see what song is next at a glance */}
            {!isRadio && (
              <div
                className="knox-upnext-dock"
                onClick={() => setView('queue')}
                role="button"
                tabIndex={0}
                aria-label={
                  nextSong
                    ? `Up next: ${nextSong.title} by ${nextSong.artist}. Tap to view queue.`
                    : autoplayOn
                    ? 'Up next: Related songs via Autoplay. Tap to view queue.'
                    : 'End of queue. Tap to view queue.'
                }
              >
                <div className="knox-upnext-tag">
                  <Icon name="musicNote" size={11} />
                  <span>UP NEXT</span>
                </div>
                <div className="knox-upnext-details">
                  {nextSong ? (
                    <>
                      <span className="knox-upnext-title">{nextSong.title}</span>
                      <span className="knox-upnext-artist">· {nextSong.artist}</span>
                    </>
                  ) : autoplayOn ? (
                    <span className="knox-upnext-title" style={{ opacity: 0.85, fontStyle: 'italic' }}>
                      Related songs will play automatically
                    </span>
                  ) : (
                    <span className="knox-upnext-title" style={{ opacity: 0.65 }}>
                      End of queue
                    </span>
                  )}
                </div>
                <div className="knox-upnext-more">
                  <span>{queue.length > queueIndex + 1 ? `${queue.length - queueIndex - 1} more` : 'Queue'}</span>
                  <Icon name="next" size={12} />
                </div>
              </div>
            )}

            {/* Real-Time Next Songs List (YouTube / JioSaavn / Spotify / YT Music Live Queue Preview) */}
            {!isRadio && (upcomingSongs.length > 0 || isRealtimeUpNextProvider(current.providerId)) && (
              <div className="knox-upnext-live-panel" aria-label="Next songs in real-time playlist">
                <div className="knox-upnext-live-header">
                  <div className="knox-upnext-live-heading">
                    <span className="knox-upnext-live-dot" />
                    <span>NEXT SONGS · {providerLabel(current.providerId).toUpperCase()} MIX</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {isRealtimeUpNextProvider(current.providerId) && (
                      <button
                        type="button"
                        className="knox-upnext-refresh-btn"
                        disabled={upNextRefreshing}
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleRefreshUpNext();
                        }}
                        title="Refresh real-time related songs mix"
                      >
                        {upNextRefreshing ? 'Syncing…' : '↻ Live Mix'}
                      </button>
                    )}
                    <button
                      type="button"
                      className="knox-upnext-seeall-btn"
                      onClick={() => setView('queue')}
                    >
                      All ({upcomingSongs.length}) ›
                    </button>
                  </div>
                </div>
                {upcomingSongs.length > 0 ? (
                  <div className="knox-upnext-live-list">
                    {upcomingSongs.slice(0, 10).map((s, idx) => (
                      <button
                        key={`${s.id}-${idx}`}
                        type="button"
                        className="knox-upnext-live-item"
                        onClick={() => void playSong(s, queue)}
                        title={`Play ${s.title} by ${s.artist}`}
                      >
                        <span className="knox-upnext-live-idx">{idx + 1}</span>
                        <img
                          src={artworkFor(s)}
                          alt=""
                          className="knox-upnext-live-art"
                          loading="lazy"
                          onError={handleArtworkError(s)}
                        />
                        <span className="knox-upnext-live-meta">
                          <span className="knox-upnext-live-song">{s.title}</span>
                          <span className="knox-upnext-live-sub">
                            {s.artist}
                            <span className="knox-upnext-live-badge">{providerLabel(s.providerId)}</span>
                          </span>
                        </span>
                        <span className="knox-upnext-live-dur">
                          {s.durationMs > 0 ? formatMs(s.durationMs) : '▶'}
                        </span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="knox-upnext-live-empty">
                    <span>Building real-time {providerLabel(current.providerId)} station…</span>
                    {isRealtimeUpNextProvider(current.providerId) && (
                      <button
                        type="button"
                        className="knox-upnext-refresh-btn"
                        disabled={upNextRefreshing}
                        onClick={() => void handleRefreshUpNext()}
                      >
                        {upNextRefreshing ? 'Loading…' : 'Load Next Songs'}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Queue / Lyrics pills — the shared chip component. Glyphs are
                decorative (aria-hidden) so tab names stay exact. */}
            <div className="chips knox-card-pills" role="group" aria-label="Card panels">
              <button className="chip" aria-pressed={false} onClick={() => setView('queue')}><span aria-hidden><Icon name="list" size={13} /></span> Queue</button>
              <button className="chip" aria-pressed={false} onClick={() => setView('lyrics')}><span aria-hidden><Icon name="quote" size={13} /></span> Lyrics</button>
              <button className="chip" aria-pressed={false} onClick={() => setView('info')}>Info</button>
            </div>
            {sleepRemaining !== null && (
              <p style={{ fontSize: 12, color: 'var(--text-2)', textAlign: 'center', margin: '2px 0' }}>
                <Icon name="moon" size={13} /> {formatMs(sleepRemaining)} left <button className="btn" style={{ padding: '2px 10px' }} onClick={() => { setSleepTimer(null); setSleepIdx(0); }}>Clear</button>
              </p>
            )}

            {/* Output pill + format caption from real metadata. */}
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
              {outputSupported ? (
                <button
                  className="knox-out-pill" onClick={() => { setOverflowOpen(false); setSleepOpen(false); setDeviceOpen((v) => !v); }}
                  aria-label={`Output: ${outputLabel}. Choose output device.`} aria-expanded={deviceOpen}
                  title="Choose output device"
                ><Icon name="dot" size={13} /> {outputLabel}</button>
              ) : (
                <span className="knox-out-pill" aria-label={`Output: ${outputLabel}`}><Icon name="dot" size={13} /> {outputLabel}</span>
              )}
            </div>
            <p className="knox-format-cap">
              {offlineAvailable ? 'Offline · ' : ''}{captionParts.join(' · ')}
            </p>
            {canOffline && !offlineAvailable && (
              <div style={{ display: 'flex', justifyContent: 'center', marginTop: 8 }}>
                <button className="chip" onClick={() => void doOffline()}><Icon name="download" size={13} /> Make available offline</button>
              </div>
            )}
          </>
        )}

        {view === 'queue' && (
          <div style={{ maxWidth: 420, margin: '12px auto 0', width: '100%' }} aria-label="Queue">
            <div className="chips knox-card-pills" role="group" aria-label="Card panels" style={{ marginBottom: 8 }}>
              <button className="chip" aria-pressed={false} onClick={() => setView('controls')}>Controls</button>
              <button className="chip active" aria-pressed onClick={() => setView('queue')}><span aria-hidden><Icon name="list" size={13} /></span> Queue</button>
              <button className="chip" aria-pressed={false} onClick={() => setView('lyrics')}><span aria-hidden><Icon name="quote" size={13} /></span> Lyrics</button>
              <button className="chip" aria-pressed={false} onClick={() => setView('info')}>Info</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0 4px 6px', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--text-primary)' }}>
                {queue.length > queueIndex + 1 ? `Up Next (${queue.length - queueIndex - 1} tracks)` : 'Queue'}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                {isRealtimeUpNextProvider(current.providerId) && (
                  <button
                    type="button"
                    className="knox-upnext-refresh-btn"
                    disabled={upNextRefreshing}
                    onClick={() => void handleRefreshUpNext()}
                  >
                    {upNextRefreshing ? 'Syncing…' : '↻ Refresh Mix'}
                  </button>
                )}
                {queue.length > 0 && (
                  <button
                    type="button"
                    className="ghost-icon-btn"
                    style={{ fontSize: 11.5, color: 'var(--text-secondary)', padding: '2px 8px', width: 'auto', height: 'auto' }}
                    onClick={clearQueue}
                  >
                    Clear queue
                  </button>
                )}
              </div>
            </div>
            <div style={{ maxHeight: '58dvh', overflowY: 'auto', display: 'grid', gap: 6 }}>
              {queue.length === 0 && <p style={{ color: 'var(--text-2)', fontSize: 13 }}>Queue is empty.</p>}
              {queue.map((s, i) => {
                if (queueIndex >= 0 && i < queueIndex) return null;
                const isCurrent = i === queueIndex;
                const isNext = i === queueIndex + 1;
                const displayPos = queueIndex >= 0 ? i - queueIndex + 1 : i + 1;
                return (
                  <div key={`${s.id}-${i}`} className={`knox-queue-row${isCurrent ? ' current' : isNext ? ' next-up' : ''}`}>
                    <button
                      type="button" className="knox-queue-main"
                      onClick={() => void playSong(s, queue)}
                      aria-label={`Play ${s.title} by ${s.artist}`}
                    >
                      <span className="knox-queue-pos" aria-hidden>{isCurrent && playing ? '▶' : `${displayPos}`}</span>
                      <img
                        src={artworkFor(s)}
                        alt=""
                        className="knox-queue-thumb"
                        loading="lazy"
                        onError={handleArtworkError(s)}
                      />
                      <span style={{ flex: 1, minWidth: 0 }}>
                        <span className="knox-queue-title">
                          {s.title}
                          {isNext && <span className="knox-upnext-tag" style={{ marginLeft: 6, fontSize: 9, padding: '1px 5px' }}>UP NEXT</span>}
                        </span>
                        <span className="knox-queue-sub">
                          {s.artist}
                          <span className="knox-upnext-live-badge" style={{ marginLeft: 6 }}>{providerLabel(s.providerId)}</span>
                          {s.queueSource === 'autoplay' && <span style={{ marginLeft: 6, fontSize: 10.5, color: 'var(--text-3)' }}>· Related</span>}
                        </span>
                      </span>
                      <span className="knox-time">{s.durationMs > 0 ? formatMs(s.durationMs) : '·'}</span>
                    </button>
                    <button
                      type="button" className="ghost-icon-btn" style={{ width: 30, height: 30 }}
                      onClick={() => removeFromQueue(s.id)} aria-label={`Remove ${s.title} from queue`}
                    ><Icon name="close" size={14} /></button>
                  </div>
                );
              })}
              {queue.length > 0 && queueIndex >= queue.length - 1 && autoplayOn && (
                <p style={{ fontSize: 12, color: 'var(--text-3)', textAlign: 'center', margin: '8px 0' }}>
                  Autoplay is active — related tracks will continue seamlessly.
                </p>
              )}
            </div>
          </div>
        )}

        {view === 'lyrics' && (
          <div style={{ maxWidth: 420, margin: '12px auto 0', width: '100%' }}>
            <div className="chips knox-card-pills" role="group" aria-label="Card panels" style={{ marginBottom: 8 }}>
              <button className="chip" aria-pressed={false} onClick={() => setView('controls')}>Controls</button>
              <button className="chip" aria-pressed={false} onClick={() => setView('queue')}><span aria-hidden><Icon name="list" size={13} /></span> Queue</button>
              <button className="chip active" aria-pressed onClick={() => setView('lyrics')}><span aria-hidden><Icon name="quote" size={13} /></span> Lyrics</button>
              <button className="chip" aria-pressed={false} onClick={() => setView('info')}>Info</button>
            </div>
            <p style={{ textAlign: 'center', fontWeight: 700, fontSize: 14, margin: '0 0 4px' }}>{current.title}</p>
            <div style={{ maxHeight: '46dvh', overflowY: 'auto', textAlign: 'center', padding: '8px 4px' }} aria-label="Lyrics">
              {lyricsState === 'loading' && <p style={{ color: 'var(--text-2)' }}>Loading lyrics…</p>}
              {lyricsState === 'ready' && (
                <p style={{ fontSize: 11.5, color: 'var(--text-2)', margin: '0 0 8px' }}>
                  {lyricsSynced ? 'Synced lyrics' : 'Plain lyrics'}{lyricsSource ? ` · ${lyricsSource}` : ''}
                </p>
              )}
              {lyricsState === 'empty' && (
                <>
                  <p style={{ color: 'var(--text-2)' }}>Lyrics aren&apos;t available for this song.</p>
                  <p style={{ fontSize: 11.5, color: 'var(--text-2)' }}>Equalizer follows the OS / device mixer — no in-app EQ is shown.</p>
                  <label className="btn" style={{ cursor: 'pointer' }}>Import .lrc file
                    <input type="file" accept=".lrc" hidden onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (!f || !current) return;
                      void importLrcForSong(current.id, f).then((ok) => {
                        if (ok) {
                          toast('Lyrics imported');
                          void getDb().lyrics.get(current.id).then((l) => {
                            if (l) { setLyrics(l.lines); setLyricsState('ready'); }
                          });
                        } else toast('Could not parse that .lrc file', 'warn');
                      });
                    }} />
                  </label>
                </>
              )}
              {lyricsState === 'ready' && lyrics?.map((l, i) => (
                <div key={i} id={`lyric-${i}`} className={`lyrics-line${i === activeIdx ? ' active' : ''}`}>{l.text}</div>
              ))}
            </div>
          </div>
        )}

        {view === 'info' && (
          <div style={{ maxWidth: 420, margin: '12px auto 0', width: '100%' }}>
            <div className="chips knox-card-pills" role="group" aria-label="Card panels" style={{ marginBottom: 8 }}>
              <button className="chip" aria-pressed={false} onClick={() => setView('controls')}>Controls</button>
              <button className="chip" aria-pressed={false} onClick={() => setView('queue')}><span aria-hidden><Icon name="list" size={13} /></span> Queue</button>
              <button className="chip" aria-pressed={false} onClick={() => setView('lyrics')}><span aria-hidden><Icon name="quote" size={13} /></span> Lyrics</button>
              <button className="chip active" aria-pressed onClick={() => setView('info')}>Info</button>
            </div>
            <div style={{ display: 'grid', gap: 6, fontSize: 13.5 }} aria-label="Track information">
              <div><strong>{current.title}</strong></div>
              <div style={{ color: 'var(--text-2)' }}>{current.artist} · {current.album}</div>
              {isPreview && (
                <>
                  <div aria-label="30-second preview">30-second preview</div>
                  <div>Preview {formatMs(previewDurationFor(current))} of {formatMs(current.durationMs)}</div>
                </>
              )}
              {!isPreview && <div>Duration {formatMs(durationMs || current.durationMs)}</div>}
              <div>Source {provider?.name ?? current.providerId}</div>
              {offlineAvailable && <div>↓ Available offline on this device</div>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Static bars for the radio strip (same deterministic shape, no seek). */
function WaveBars({ seed, played }: { seed: string; played: number }) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  const out: number[] = [];
  for (let i = 0; i < 56; i++) {
    h = (h * 1103515245 + 12345) >>> 0;
    out.push(5 + (h % 24));
  }
  return (
    <>
      {out.map((hh, i) => (
        <span key={i} style={{ height: hh }} data-played={i < played ? 'true' : 'false'} />
      ))}
    </>
  );
}

export async function importLrcForSong(songId: string, file: File): Promise<boolean> {
  const text = await file.text();
  const lines = parseLrc(text);
  if (!lines) return false;
  await getDb().lyrics.put({ songId, lines, synced: true, source: file.name });
  return true;
}
