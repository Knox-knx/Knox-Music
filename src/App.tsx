import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Sidebar, BottomNav, type Route } from './ui/navigation';
import { NavDrawer } from './ui/NavDrawer';
import { PlayerBar, MiniPlayer, QueuePanel } from './ui/player';
import { FullPlayer } from './ui/FullPlayer';
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
import { OnboardingScreen, AboutScreen } from './screens/OnboardingAbout';
import { usePlayer } from './audio/playerStore';
import { useSettings } from './settings/settingsStore';
import { playlistRepo, songRepo } from './data/repositories';
import type { Playlist, Song } from './core/types';
import { getAudioEngine } from './audio/AudioEngine';

/**
 * True when global playback hotkeys (Space/arrows/m) must NOT fire: focus is
 * in a text field or inside an open menu/dialog overlay. Without this, e.g.
 * pressing Space on a focused context-menu item would both activate the item
 * AND toggle playback — stopping music the user never asked to stop.
 */
export function shouldDeferToOverlayHotkeys(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  return Boolean(el.closest('input, textarea, select, [role="menu"], [role="dialog"]'));
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
  // Spec §9: drawer is a pure overlay — open state never touches route, scroll
  // position, or the player store, so the screen behind it is undisturbed.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const openMenu = useCallback(() => setDrawerOpen(true), []);
  const closeMenu = useCallback(() => setDrawerOpen(false), []);
  const onboarded = useSettings((s) => s.onboarded);
  const loaded = useSettings((s) => s.loaded);
  const offlineMode = usePlayer((s) => s.offlineMode);
  const setOfflineMode = usePlayer((s) => s.setOfflineMode);
  const current = usePlayer((s) => s.current);

  const go = useCallback((r: Route) => {
    setRoute(r);
    setQueueOpen(false);
    if (r !== 'playlist') setPlaylistId(null);
  }, []);

  const refreshPlaylists = useCallback(() => {
    playlistRepo.list().then(setPlaylists).catch(() => undefined);
    setPlaylistRefresh((n) => n + 1);
  }, []);

  useEffect(() => { refreshPlaylists(); }, [refreshPlaylists, route]);

  // Global keyboard shortcuts (desktop)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const typing = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT';
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); go('search'); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'n') { e.preventDefault(); void createPlaylist(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); go('library'); }
      else if (typing) return;
      // Overlays handle their own keys (menu arrows/Enter/Space, dialog
      // sliders): global playback shortcuts must not double-fire or pause
      // music while the user interacts with a menu/dialog.
      else if (shouldDeferToOverlayHotkeys(e.target)) return;
      else if (e.code === 'Space') { e.preventDefault(); void usePlayer.getState().toggle(); }
      else if (e.key === 'ArrowRight' && e.target === document.body) void usePlayer.getState().next();
      else if (e.key === 'ArrowLeft' && e.target === document.body) void usePlayer.getState().prev();
      else if (e.key === 'ArrowUp') usePlayer.getState().setVolume(Math.min(1, usePlayer.getState().volume + 0.05));
      else if (e.key === 'ArrowDown') usePlayer.getState().setVolume(Math.max(0, usePlayer.getState().volume - 0.05));
      else if (e.key.toLowerCase() === 'm') usePlayer.getState().setMuted(!usePlayer.getState().muted);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [go]);

  // OS media keys
  useEffect(() => {
    try {
      const handlers: [MediaSessionAction, () => void][] = [
        ['play', () => void usePlayer.getState().toggle()],
        ['pause', () => void usePlayer.getState().toggle()],
        ['previoustrack', () => void usePlayer.getState().prev()],
        ['nexttrack', () => void usePlayer.getState().next()],
        ['stop', () => getAudioEngine().pause()],
      ];
      for (const [action, fn] of handlers) {
        try { navigator.mediaSession.setActionHandler(action, fn); } catch { /* unsupported */ }
      }
    } catch { /* unsupported */ }
  }, []);

  // Network awareness
  useEffect(() => {
    const off = () => toast("You're offline. Showing your local library.", 'warn');
    const on = () => toast('Back online');
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on); };
  }, []);

  // Swipe-from-left-edge opens the drawer (Spec §9.2). Only a horizontal
  // swipe starting within 24px of the left edge counts, so normal scrolling
  // and player gestures are unaffected.
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

  const createPlaylist = async () => {
    const name = window.prompt('Playlist name');
    if (!name) return;
    const pl = await playlistRepo.create(name);
    refreshPlaylists();
    toast(`Created playlist ${pl.name}`);
    setPlaylistId(pl.id);
    setRoute('playlist');
  };

  const openAlbum = (s: Song) => { setAlbumSeed(s); setRoute('album'); };
  const openArtist = (s: Song) => { setArtistSeed(s); setRoute('artist'); };

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

  return (
    <div className="app-shell">
      {/* Spec §9: no global search bar — the search input lives only inside
          the dedicated Search tab (SearchScreen). Home/Library/Radio render
          their own headers with no search input. */}
      <div style={{ display: 'flex', gap: 8, padding: '8px 26px 0', alignItems: 'center' }}>
        <button
          className={`chip${offlineMode ? ' active' : ''}`}
          onClick={() => { setOfflineMode(!offlineMode); toast(offlineMode ? 'Online mode' : '⊘ Offline mode — local music only'); }}
          aria-pressed={offlineMode}
          title="Toggle offline mode"
        >{offlineMode ? '⊘ Offline mode: ON' : '● Offline mode: OFF'}</button>
        {!navigator.onLine && <span style={{ fontSize: 12, color: 'var(--warning)' }}>No network — local library active</span>}
      </div>
      <div className="app-body">
        <Sidebar route={route} go={go} playlists={playlists} onCreatePlaylist={() => void createPlaylist()} onOpenMenu={openMenu} />
        <main className="main" id="main-content">
          <ErrorBoundary area="main-content">
          {route === 'home' && <HomeScreen go={go} onOpenAlbum={openAlbum} onOpenArtist={openArtist} />}
          {route === 'search' && <SearchScreen query={query} setQuery={setQuery} onOpenAlbum={openAlbum} onOpenArtist={openArtist} onOpenPlayer={() => setFullPlayer(true)} />}
          {route === 'radio' && <RadioScreen />}
          {route === 'library' && <LibraryScreen onOpenAlbum={openAlbum} onOpenArtist={openArtist} />}
          {route === 'favorites' && <FavoritesScreen onOpenAlbum={openAlbum} onOpenArtist={openArtist} />}
          {route === 'playlists' && <PlaylistsScreen refreshKey={playlistRefresh} onOpen={(id) => { setPlaylistId(id); setRoute('playlist'); }} />}
          {route === 'playlist' && playlistId && (
            <PlaylistDetailScreen id={playlistId} onBack={() => go('playlists')} onOpenAlbum={openAlbum} onOpenArtist={openArtist} />
          )}
          {route === 'downloads' && <DownloadsScreen />}
          {route === 'history' && <HistoryScreen />}
          {route === 'settings' && <SettingsScreen go={(r) => go(r)} />}
          {route === 'storage' && <StorageScreen />}
          {route === 'about' && <AboutScreen />}
          {route === 'providers' && <SettingsScreen go={(r) => go(r)} />}
          {route === 'artist' && artistSeed && <ArtistScreen seed={artistSeed} onOpenAlbum={openAlbum} />}
          {route === 'album' && albumSeed && <AlbumScreen seed={albumSeed} onOpenArtist={openArtist} />}
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
          <FullPlayer onClose={() => setFullPlayer(false)} onOpenQueue={() => setQueueOpen(true)} />
        </ErrorBoundary>
      )}
      <BottomNav route={route} go={go} onOpenMenu={openMenu} />
      <NavDrawer open={drawerOpen} onClose={closeMenu} go={go} />
      <Toasts />
    </div>
  );
}
