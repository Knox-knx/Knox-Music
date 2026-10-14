import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar, TopBar, BottomNav, type Route } from './ui/navigation';
import { NavDrawer } from './ui/NavDrawer';
import { PlayerBar, MiniPlayer, QueuePanel } from './ui/player';
import { NotificationExplainer, NotificationDeniedBanner } from './ui/NotificationPrompt';
import { FullPlayer } from './ui/FullPlayer';
import { LiveWallpaper } from './ui/LiveWallpaper';
import { PermissionsScreen } from './screens/PermissionsScreen';
import { Toasts } from './ui/primitives';
import { toast } from './ui/toast';
import { HomeScreen } from './screens/HomeScreen';
import { SearchScreen } from './screens/SearchScreen';
import { RadioScreen } from './screens/RadioScreen';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { LibraryScreen } from './screens/LibraryScreen';
import { FavoritesScreen } from './screens/FavoritesScreen';
import { PlaylistsScreen, PlaylistDetailScreen } from './screens/PlaylistsScreen';
import { DownloadsScreen } from './screens/DownloadsScreen';
import { HistoryScreen } from './screens/HistoryScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { StorageScreen } from './screens/StorageScreen';
import { ArtistScreen, AlbumScreen } from './screens/DetailScreens';
import { YouTubeScreen } from './screens/YouTubeScreen';
import { OnboardingScreen, AboutScreen } from './screens/OnboardingAbout';
import { usePlayer } from './audio/playerStore';
import { useSettings } from './settings/settingsStore';
import { playlistRepo, songRepo } from './data/repositories';
import type { Playlist, Song } from './core/types';
import { getAudioEngine } from './audio/AudioEngine';

/**
 * Nearest-ancestor-or-self contenteditable state per the HTML spec: the
 * closest `contenteditable` attribute decides (`""`/`"true"` → editable,
 * `"false"` → not, anything else inherits from its parent). Implemented via
 * attributes (not `isContentEditable`) so it also works where the DOM
 * property is unimplemented (jsdom) and for descendants of editing hosts.
 */
function hasEditingHost(target: EventTarget | null): boolean {
  const el = target as Element | null;
  if (!el || typeof (el as Element).getAttribute !== 'function') return false;
  let node: Element | null = el;
  while (node) {
    if (typeof node.getAttribute === 'function') {
      const raw = node.getAttribute('contenteditable');
      if (raw !== null) {
        const v = raw.toLowerCase();
        if (v === '' || v === 'true') return true;
        if (v === 'false') return false;
        // Invalid value → inherit: keep walking up.
      }
    }
    node = node.parentElement;
  }
  return false;
}

/**
 * True when keyboard events originate from an editable text target: a native
 * form field or a rich-text (contenteditable) host. Global playback hotkeys
 * must NEVER steal plain typing from these — letters, numbers, spaces,
 * backspace, arrows, home/end, etc. all belong to the field.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  // Fast path in real browsers (also true for descendants of editing hosts).
  try {
    if ((el as HTMLElement).isContentEditable) return true;
  } catch {
    /* non-HTML targets (text nodes, document) — fall through to checks below */
  }
  const tag = typeof (el as Element).tagName === 'string' ? (el as Element).tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return hasEditingHost(target);
}

/**
 * True when global playback hotkeys (Space/arrows/m) must NOT fire: focus is
 * in a text field or inside an open menu/dialog overlay. Without this, e.g.
 * pressing Space on a focused context-menu item would both activate the item
 * AND toggle playback — stopping music the user never asked to stop.
 */
export function shouldDeferToOverlayHotkeys(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof (el as Element).closest !== 'function') return isTypingTarget(target);
  try {
    if ((el as HTMLElement).isContentEditable) return true;
  } catch {
    /* fall through to selector checks */
  }
  if (hasEditingHost(target)) return true;
  return Boolean(el.closest('input, textarea, select, [contenteditable], [role="menu"], [role="dialog"]'));
}

/** One in-app navigation history entry (explicit back stack). */
interface NavEntry {
  route: Route;
  playlistId: string | null;
  artistSeed: Song | null;
  albumSeed: Song | null;
}

function sameNav(a: NavEntry | undefined, b: NavEntry): boolean {
  if (!a) return false;
  return (
    a.route === b.route &&
    a.playlistId === b.playlistId &&
    (a.artistSeed?.id ?? null) === (b.artistSeed?.id ?? null) &&
    (a.albumSeed?.id ?? null) === (b.albumSeed?.id ?? null)
  );
}

/** DOM id of the persistent global search field (TopBar). Stable by design. */
export const GLOBAL_SEARCH_INPUT_ID = 'knox-global-search';

/** Move focus to the global search field when it is mounted. Null-safe. */
export function focusGlobalSearch(): boolean {
  try {
    const el = document.getElementById(GLOBAL_SEARCH_INPUT_ID);
    if (el instanceof HTMLInputElement) {
      el.focus();
      return true;
    }
  } catch {
    /* non-DOM environment */
  }
  return false;
}

/**
 * The single global keyboard-shortcut decision point (extracted for
 * regression testing — App wires the returned listener to window).
 *
 * Rules (§16):
 * - Ctrl/⌘+K (jump to search) and Ctrl/⌘+F (jump to library) are explicitly
 *   intended to work while typing: they never insert text.
 * - Everything else defers while typing (input/textarea/select/
 *   contenteditable) or while a menu/dialog is focused.
 * - In particular Ctrl/⌘+N (new playlist → window.prompt) must NOT fire
 *   while typing: the prompt would rip focus out of the field mid-word.
 */
export function createGlobalHotkeyHandler(opts: {
  go: (r: Route) => void;
  createPlaylist: () => void;
}): (e: KeyboardEvent) => void {
  const { go, createPlaylist } = opts;
  return (e: KeyboardEvent) => {
    const key = (e.key || '').toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    if (mod && key === 'k') {
      e.preventDefault();
      go('search');
      // The TopBar search field stays mounted across routes, so focusing it
      // synchronously is safe and keeps keyboard users in flow.
      focusGlobalSearch();
      return;
    }
    if (mod && key === 'f') {
      e.preventDefault();
      go('library');
      return;
    }
    // Normal typing and overlay interaction always win over playback keys.
    if (isTypingTarget(e.target) || shouldDeferToOverlayHotkeys(e.target)) return;
    if (mod && key === 'n') {
      e.preventDefault();
      createPlaylist();
      return;
    }
    if (e.code === 'Space') { e.preventDefault(); void usePlayer.getState().toggle(); }
    else if (e.key === 'ArrowRight' && e.target === document.body) void usePlayer.getState().next();
    else if (e.key === 'ArrowLeft' && e.target === document.body) void usePlayer.getState().prev();
    else if (e.key === 'ArrowUp') usePlayer.getState().setVolume(Math.min(1, usePlayer.getState().volume + 0.05));
    else if (e.key === 'ArrowDown') usePlayer.getState().setVolume(Math.max(0, usePlayer.getState().volume - 0.05));
    else if (key === 'm' && !mod && !e.altKey) usePlayer.getState().setMuted(!usePlayer.getState().muted);
  };
}

export default function App() {
  const [route, setRoute] = useState<Route>('home');
  const [query, setQuery] = useState('');
  const [playlistId, setPlaylistId] = useState<string | null>(null);
  const [artistSeed, setArtistSeed] = useState<Song | null>(null);
  const [albumSeed, setAlbumSeed] = useState<Song | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [playlistRefresh, setPlaylistRefresh] = useState(0);
  const [fullPlayer, setFullPlayer] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  // Drawer is a pure overlay — open state never touches route, scroll
  // position, or the player store, so the screen behind it is undisturbed.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const openMenu = useCallback(() => setDrawerOpen(true), []);
  const closeMenu = useCallback(() => setDrawerOpen(false), []);
  const onboarded = useSettings((s) => s.onboarded);
  const loaded = useSettings((s) => s.loaded);
  const uiStyle = useSettings((s) => s.uiStyle);
  const offlineMode = usePlayer((s) => s.offlineMode);
  const setOfflineMode = usePlayer((s) => s.setOfflineMode);
  const current = usePlayer((s) => s.current);

  useEffect(() => {
    document.documentElement.dataset.uiStyle = uiStyle || 'glassmorphism';
  }, [uiStyle]);

  useEffect(() => {
    const syncNet = () => {
      if (typeof navigator !== 'undefined') {
        setOfflineMode(!navigator.onLine);
      }
    };
    window.addEventListener('online', syncNet);
    window.addEventListener('offline', syncNet);
    return () => {
      window.removeEventListener('online', syncNet);
      window.removeEventListener('offline', syncNet);
    };
  }, [setOfflineMode]);

  const SWIPE_ROUTES: Route[] = ['home', 'search', 'library', 'radio'];
  const [slideAnim, setSlideAnim] = useState<'left' | 'right' | null>(null);
  const [animPhase, setAnimPhase] = useState<0 | 1>(0);
  const routeRef = useRef<Route>(route);
  routeRef.current = route;

  const triggerSlideAnim = useCallback((dir: 'left' | 'right') => {
    setSlideAnim(dir);
    setAnimPhase((p) => (p === 0 ? 1 : 0));
  }, []);

  const go = useCallback((r: Route) => {
    const prevRoute = routeRef.current;
    if (r !== prevRoute) {
      const prevIdx = SWIPE_ROUTES.indexOf(prevRoute);
      const nextIdx = SWIPE_ROUTES.indexOf(r);
      const dir: 'left' | 'right' =
        prevIdx !== -1 && nextIdx !== -1
          ? nextIdx > prevIdx
            ? 'left'
            : 'right'
          : 'left';
      triggerSlideAnim(dir);
    }
    setRoute(r);
    setQueueOpen(false);
    if (r !== 'playlist') setPlaylistId(null);
  }, [triggerSlideAnim]);

  const refreshPlaylists = useCallback(() => {
    playlistRepo.list().then(setPlaylists).catch(() => undefined);
    setPlaylistRefresh((n) => n + 1);
  }, []);

  useEffect(() => { refreshPlaylists(); }, [refreshPlaylists, route]);

  // ---- Explicit in-app navigation history stack ----
  // Every route change pushes a snapshot (seeds ride along so nested
  // screens restore exactly). Consecutive duplicates are dropped. Back
  // pops one entry and restores it; only an empty history exits.
  const navStack = useRef<NavEntry[]>([]);
  const suppressPush = useRef(false);
  const lastExitAsk = useRef(0);
  useEffect(() => {
    if (suppressPush.current) { suppressPush.current = false; return; }
    const entry: NavEntry = { route, playlistId, artistSeed, albumSeed };
    const stack = navStack.current;
    if (!sameNav(stack[stack.length - 1], entry)) {
      stack.push(entry);
      if (stack.length > 50) stack.splice(0, stack.length - 50);
    }
  }, [route, playlistId, artistSeed, albumSeed]);

  /** Step back one history entry. Returns true when something was restored. */
  const goBack = useCallback((): boolean => {
    const stack = navStack.current;
    if (stack.length < 2) return false;
    stack.pop(); // discard current
    const prev = stack[stack.length - 1];
    suppressPush.current = true;
    triggerSlideAnim('right');
    setPlaylistId(prev.playlistId);
    setArtistSeed(prev.artistSeed);
    setAlbumSeed(prev.albumSeed);
    setRoute(prev.route);
    setQueueOpen(false);
    return true;
  }, [triggerSlideAnim]);

  /**
   * Back-press priority (each step consumes the press):
   * 1. drawer/queue sheet open → close it
   * 2. expanded full-player → collapse to mini-player (playback continues)
   * 3. nested screen → previous screen in the stack
   * 4. root tabs → previous tab in the stack (never a direct exit)
   * 5. true root with empty history → false (caller shows "press back
   *    again to exit" / lets the OS exit on the confirming press).
   */
  const handleBack = useCallback((): boolean => {
    if (drawerOpen) { setDrawerOpen(false); return true; }
    if (queueOpen) { setQueueOpen(false); return true; }
    if (fullPlayer) { setFullPlayer(false); return true; }
    return goBack();
  }, [drawerOpen, queueOpen, fullPlayer, goBack]);
  const handleBackRef = useRef(handleBack);
  handleBackRef.current = handleBack;

  // Back-button wiring: browser back / gesture swipe (popstate), Cordova /
  // Capacitor WebView hardware key (backbutton). A seeded history entry
  // keeps the WebView's back from exiting outright, so every press flows
  // through handleBack() first.
  useEffect(() => {
    try { window.history.pushState({ knox: 1 }, ''); } catch { /* no history API */ }
    const exitAsk = () => {
      const now = Date.now();
      if (now - lastExitAsk.current < 2000) return true; // confirmed → exit
      lastExitAsk.current = now;
      toast('Press back again to exit');
      try { window.history.pushState({ knox: 1 }, ''); } catch { /* ignore */ }
      return false;
    };
    const onPopState = () => {
      if (handleBackRef.current()) {
        try { window.history.pushState({ knox: 1 }, ''); } catch { /* ignore */ }
      } else {
        exitAsk(); // true root: confirm, or exit on the confirming press
      }
    };
    const onNativeBack = (e: Event) => {
      if (handleBackRef.current()) {
        try { e.preventDefault(); } catch { /* ignore */ }
        return;
      }
      if (!exitAsk()) {
        try { e.preventDefault(); } catch { /* ignore */ }
      }
      // Confirmed second press: let the event propagate so the OS exits.
    };
    window.addEventListener('popstate', onPopState);
    document.addEventListener('backbutton', onNativeBack as EventListener);
    return () => {
      window.removeEventListener('popstate', onPopState);
      document.removeEventListener('backbutton', onNativeBack as EventListener);
    };
  }, []); // handlers read live state via handleBackRef

  // Drawer/menu + settings fallback events. knox:open-player arrives from
  // the native notification body tap (Android) — land on now-playing.
  useEffect(() => {
    const onMenu = () => setDrawerOpen(true);
    const onSettings = () => go('settings');
    const onOpenPlayer = () => setFullPlayer(true);
    window.addEventListener('knox:open-menu', onMenu);
    window.addEventListener('knox:open-settings', onSettings);
    window.addEventListener('knox:open-player', onOpenPlayer);
    return () => {
      window.removeEventListener('knox:open-menu', onMenu);
      window.removeEventListener('knox:open-settings', onSettings);
      window.removeEventListener('knox:open-player', onOpenPlayer);
    };
  }, [go]);

  // Restore queue + position across restarts ("Keep listening" resume).
  // Also boots the OS integration layer: clears any stale system media
  // card, restores persisted folder grants silently, and arms interruption
  // handling.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { restorePlaybackState } = await import('./audio/playerStore');
        if (live) await restorePlaybackState().catch(() => false);
      } catch { /* restore is best-effort */ }
      try {
        const { clearOsMediaSession, initOsMediaSession } = await import('./os/mediaSession');
        if (!live) return;
        clearOsMediaSession();
        initOsMediaSession();
      } catch { /* OS media layer is best-effort */ }
      try {
        const { restoreFolderGrants } = await import('./library/folderGrants');
        if (live) await restoreFolderGrants().catch(() => []);
      } catch { /* grants restore is best-effort */ }
      try {
        const { initAudioInterruptions } = await import('./os/audioInterruptions');
        if (live) initAudioInterruptions();
      } catch { /* interruption handling is best-effort */ }
    })();
    return () => { live = false; };
  }, []);

  // Swipe-from-left-edge opens the drawer. Only a horizontal swipe starting
  // within 24px of the left edge counts, so normal scrolling and player
  // gestures are unaffected.
  const edgeTouch = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) { edgeTouch.current = null; return; }
      const t = e.touches[0];
      edgeTouch.current = t.clientX <= 24 ? { x: t.clientX, y: t.clientY } : null;
    };
    const onEnd = (e: TouchEvent) => {
      const start = edgeTouch.current;
      edgeTouch.current = null;
      if (!start || drawerOpen) return;
      const t = e.changedTouches[0];
      if (t.clientX - start.x > 60 && Math.abs(t.clientY - start.y) < 40) setDrawerOpen(true);
    };
    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchend', onEnd, { passive: true });
    return () => { window.removeEventListener('touchstart', onStart); window.removeEventListener('touchend', onEnd); };
  }, [drawerOpen]);

  // Global keyboard shortcuts (desktop)
  useEffect(() => {
    const onKey = createGlobalHotkeyHandler({ go, createPlaylist: () => void createPlaylist() });
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go]);


  // Network awareness
  useEffect(() => {
    const off = () => toast("You're offline. Showing your local library.", 'warn');
    const on = () => toast('Back online');
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on); };
  }, []);

  const createPlaylist = async () => {
    const name = window.prompt('Playlist name');
    if (!name) return;
    const pl = await playlistRepo.create(name);
    refreshPlaylists();
    toast(`Created playlist ${pl.name}`);
    setPlaylistId(pl.id);
    setRoute('playlist');
  };

  const openAlbum = (s: Song) => { triggerSlideAnim('left'); setAlbumSeed(s); setRoute('album'); };
  const openArtist = (s: Song) => { triggerSlideAnim('left'); setArtistSeed(s); setRoute('artist'); };

  const mainRef = useRef<HTMLElement | null>(null);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const swipeAxisLocked = useRef<'x' | 'y' | null>(null);

  const resetSwipeDragStyle = useCallback(() => {
    const el = mainRef.current;
    if (!el) return;
    el.style.removeProperty('--swipe-drag-x');
    el.style.removeProperty('--swipe-drag-opacity');
    el.classList.remove('is-swiping-x');
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    const target = e.target as HTMLElement | null;
    if (
      target?.closest(
        'input, textarea, select, [role="slider"], .chips-scrollable, .knox-wave-strip, .knox-sheet, .knox-rail, .knox-rail-row, .knox-speed-pager, .knox-select-wrap, [data-no-swipe]',
      )
    ) {
      touchStartX.current = null;
      touchStartY.current = null;
      swipeAxisLocked.current = null;
      return;
    }
    // Ignore left-edge drawer gesture (<= 24px)
    if (e.touches[0].clientX <= 24) {
      touchStartX.current = null;
      touchStartY.current = null;
      swipeAxisLocked.current = null;
      return;
    }
    touchStartX.current = e.touches[0].clientX;
    touchStartY.current = e.touches[0].clientY;
    swipeAxisLocked.current = null;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const dx = e.touches[0].clientX - touchStartX.current;
    const dy = e.touches[0].clientY - touchStartY.current;

    if (swipeAxisLocked.current === null) {
      if (Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) {
        swipeAxisLocked.current = 'y';
        resetSwipeDragStyle();
        return;
      }
      if (Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        swipeAxisLocked.current = 'x';
      }
    }

    if (swipeAxisLocked.current === 'x' && mainRef.current) {
      const idx = SWIPE_ROUTES.indexOf(route);
      const atLeftEdge = dx > 0 && idx === 0;
      const atRightEdge = dx < 0 && idx === SWIPE_ROUTES.length - 1;
      const damping = atLeftEdge || atRightEdge ? 0.18 : 0.42;
      const clampedDx = Math.max(-110, Math.min(110, dx * damping));
      const fade = Math.max(0.78, 1 - Math.abs(clampedDx) / 360);
      mainRef.current.classList.add('is-swiping-x');
      mainRef.current.style.setProperty('--swipe-drag-x', `${clampedDx.toFixed(1)}px`);
      mainRef.current.style.setProperty('--swipe-drag-opacity', fade.toFixed(3));
    }
  }, [route, resetSwipeDragStyle]);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) {
      resetSwipeDragStyle();
      return;
    }
    const dx = e.changedTouches[0].clientX - touchStartX.current;
    const dy = e.changedTouches[0].clientY - touchStartY.current;
    const axis = swipeAxisLocked.current;
    touchStartX.current = null;
    touchStartY.current = null;
    swipeAxisLocked.current = null;
    resetSwipeDragStyle();

    if (axis !== 'y' && Math.abs(dx) > 52 && Math.abs(dx) > Math.abs(dy) * 1.3) {
      if (dx < 0) {
        // Swiped LEFT -> move forward to next tab
        const idx = SWIPE_ROUTES.indexOf(route);
        if (idx >= 0 && idx < SWIPE_ROUTES.length - 1) {
          triggerSlideAnim('left');
          go(SWIPE_ROUTES[idx + 1]);
        }
      } else {
        // Swiped RIGHT -> move backward to previous tab or back
        const idx = SWIPE_ROUTES.indexOf(route);
        if (idx > 0) {
          triggerSlideAnim('right');
          go(SWIPE_ROUTES[idx - 1]);
        } else if (idx === -1) {
          triggerSlideAnim('right');
          if (!goBack()) go('home');
        }
      }
    }
  }, [route, go, goBack, resetSwipeDragStyle, triggerSlideAnim]);

  if (!loaded) return <div style={{ padding: 40, color: 'var(--text-2)' }}>Loading KNOX Music…</div>;
  if (!onboarded) {
    return (
      <>
        <OnboardingScreen onDone={(mode) => {
          if (mode === 'local') go('library');
          else if (mode === 'online') go('search');
          else go('home');
        }} />
        <Toasts />
      </>
    );
  }

  const swipeClass = slideAnim
    ? ` knox-swipe-slide-${slideAnim} knox-swipe-slide-${slideAnim}-${animPhase}`
    : '';

  return (
    <div className="app-shell" data-ui-style={uiStyle || 'glassmorphism'}>
      <LiveWallpaper playerOpen={Boolean(fullPlayer && current)} />
      <TopBar query={query} setQuery={(q) => { setQuery(q); if (q.trim()) setRoute('search'); }} onOpenSettings={() => go('settings')} offlineMode={offlineMode} />
      <div className="app-body">
        <Sidebar route={route} go={go} playlists={playlists} onCreatePlaylist={() => void createPlaylist()} onOpenMenu={openMenu} />
        <main
          ref={mainRef}
          className={`main${swipeClass}`}
          id="main-content"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={resetSwipeDragStyle}
          onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) setSlideAnim(null);
          }}
        >
          <ErrorBoundary area="main-content">
          {route === 'home' && <HomeScreen go={go} onOpenAlbum={openAlbum} onOpenArtist={openArtist} onOpenMenu={openMenu} onOpenSettings={() => go('settings')} />}
          {route === 'search' && <SearchScreen query={query} setQuery={setQuery} onOpenAlbum={openAlbum} onOpenArtist={openArtist} onOpenPlayer={() => setFullPlayer(true)} onOpenMenu={openMenu} onOpenSettings={() => go('settings')} />}
          {route === 'radio' && <RadioScreen onOpenMenu={openMenu} onOpenSettings={() => go('settings')} />}
          {route === 'library' && <LibraryScreen onOpenAlbum={openAlbum} onOpenArtist={openArtist} onOpenMenu={openMenu} onOpenSettings={() => go('settings')} />}
          {route === 'favorites' && <FavoritesScreen onOpenAlbum={openAlbum} onOpenArtist={openArtist} />}
          {route === 'playlists' && <PlaylistsScreen refreshKey={playlistRefresh} onOpen={(id) => { setPlaylistId(id); setRoute('playlist'); }} />}
          {route === 'playlist' && playlistId && (
            <PlaylistDetailScreen id={playlistId} onBack={() => go('playlists')} onOpenAlbum={openAlbum} onOpenArtist={openArtist} />
          )}
          {route === 'downloads' && <DownloadsScreen />}
          {route === 'history' && <HistoryScreen />}
          {route === 'settings' && <SettingsScreen go={(r) => go(r)} onOpenMenu={openMenu} />}
          {route === 'permissions' && <PermissionsScreen go={go} />}
          {route === 'storage' && <StorageScreen />}
          {route === 'about' && <AboutScreen />}
          {route === 'providers' && <SettingsScreen go={(r) => go(r)} onOpenMenu={openMenu} />}
          {route === 'youtube' && <YouTubeScreen onOpenAlbum={openAlbum} onOpenArtist={openArtist} onOpenPlayer={() => setFullPlayer(true)} onOpenMenu={openMenu} onOpenSettings={() => go('settings')} />}
          {route === 'artist' && artistSeed && <ArtistScreen seed={artistSeed} onOpenAlbum={openAlbum} />}
          {route === 'album' && albumSeed && <AlbumScreen seed={albumSeed} onOpenArtist={openArtist} onBack={() => setRoute('home')} onOpenSearch={() => setRoute('search')} />}
          </ErrorBoundary>
        </main>
      </div>
      {current && !fullPlayer && (
        <>
          <PlayerBar onExpand={() => setFullPlayer(true)} onOpenQueue={() => setQueueOpen((v) => !v)} />
          <MiniPlayer onExpand={() => setFullPlayer(true)} />
        </>
      )}
      {queueOpen && (
        <QueuePanel
          onClose={() => setQueueOpen(false)}
          onSaveAsPlaylist={() => {
            const q = usePlayer.getState().queue;
            if (q.length === 0) return;
            const name = window.prompt('Playlist name', 'Queue mix');
            if (!name) return;
            void playlistRepo.create(name, '', q.map((s) => {
              void songRepo.upsert(s).catch(() => undefined);
              return s.id;
            })).then((pl) => { refreshPlaylists(); toast(`Saved queue as ${pl.name}`); setQueueOpen(false); });
          }}
        />
      )}
      {fullPlayer && current && (
        <ErrorBoundary area="full-player">
          <FullPlayer onClose={() => setFullPlayer(false)} onOpenQueue={() => setQueueOpen(true)} onOpenAlbum={openAlbum} />
        </ErrorBoundary>
      )}
      <BottomNav route={route} go={go} />
      <NavDrawer open={drawerOpen} onClose={closeMenu} go={go} route={route} />
      <NotificationExplainer />
      <Toasts />
    </div>
  );
}
