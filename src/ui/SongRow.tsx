import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Song } from '../core/types';
import { formatMs } from '../core/utils';
import { providerLabel } from '../providers/merge';
import { usePlayer } from '../audio/playerStore';
import { favoriteRepo, playlistRepo } from '../data/repositories';
import { useDownloads } from '../downloads/DownloadManager';
import { getProviderManager } from '../providers/ProviderManager';
import { isPreviewSong, previewDurationFor } from '../providers/capabilities';
import { toast } from './toast';
import { useSettings } from '../settings/settingsStore';

export function artworkFor(song: Song): string {
  if (song.artworkLocal) return song.artworkLocal;
  if (song.artworkUrl) return song.artworkUrl;
  return artworkPlaceholderFor(song);
}

/** Deterministic generated placeholder in the warm KNOX palette (never a
 *  remote fetch — always safe). Solid accent-tile style, never a broken image. */
export function artworkPlaceholderFor(song: Pick<Song, 'title'>): string {
  const sets: [string, string][] = [
    ['#3a2f22', '#241c13'],
    ['#6b7a4f', '#3d4a2c'],
    ['#c9a961', '#7a5f31'],
  ];
  const i = [...song.title].reduce((n, c) => n + c.charCodeAt(0), 0) % sets.length;
  const [a, b] = sets[i];
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs><rect width="96" height="96" fill="url(#g)"/><text x="48" y="60" font-size="32" text-anchor="middle" fill="#f5f0e8" font-family="serif">♪</text></svg>`)}`;
}

/**
 * Safe <img> fallback: a broken remote artwork URL swaps to the generated
 * placeholder exactly once (dataset guard prevents retry loops). Artwork
 * failure can therefore never break player rendering.
 */
export function handleArtworkError(song: Pick<Song, 'title'>): React.ReactEventHandler<HTMLImageElement> {
  return (e) => {
    const el = e.currentTarget;
    if (el.dataset.fbk) return;
    el.dataset.fbk = '1';
    try { el.src = artworkPlaceholderFor(song); } catch { /* never throw from UI */ }
  };
}

const MENU_W = 260;
const MENU_H_EST = 400;
const PLAYER_CLEARANCE = 120;

function clampMenuPosition(x: number, y: number): { x: number; y: number } {
  const vw = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 768 : window.innerHeight;
  const px = Math.max(8, Math.min(x, vw - MENU_W - 8));
  const lowest = vh - PLAYER_CLEARANCE - MENU_H_EST;
  const py = Math.max(8, Math.min(y, lowest > 8 ? lowest : Math.max(8, vh - MENU_H_EST - 8)));
  return { x: px, y: py };
}

export function SongRow({ song, index, onOpenAlbum, onOpenArtist, onRequestPlay, preparing }: {
  song: Song; index?: number; onOpenAlbum?: (s: Song) => void; onOpenArtist?: (s: Song) => void;
  /** Delegated playback (SearchScreen flow): resolve → play → open player only on success. */
  onRequestPlay?: (song: Song) => Promise<boolean>;
  /** True while this row's stream is being resolved ("Preparing track..."). */
  preparing?: boolean;
}) {
  const playSong = usePlayer((s) => s.playSong);
  const addToQueue = usePlayer((s) => s.addToQueue);
  const current = usePlayer((s) => s.current);
  // Rules-of-Hooks: every hook must run unconditionally on every render.
  // The previous `isCurrent && usePlayer(...)` skipped this subscription for
  // non-current rows, so the row that started playing rendered MORE hooks
  // than before → React threw and unmounted the whole tree (black WebView
  // while audio kept playing). Subscribe always, derive afterwards.
  const playerState = usePlayer((s) => s.state);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [infoOpen, setInfoOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);

  const closeMenu = useCallback((refocusButton = false) => {
    setMenu(null);
    if (refocusButton) menuButtonRef.current?.focus();
  }, []);

  // Outside / Escape / scroll-resize handling. The menu lives in a portal on
  // document.body, so these window listeners are the single close path and
  // row clicks can never leak into menu actions (or vice versa).
  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node | null;
      if (menuRef.current?.contains(t as Node)) return;
      if (menuButtonRef.current?.contains(t as Node)) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMenu(true);
      }
    };
    const onViewportChange = () => setMenu(null);
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('touchstart', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onViewportChange);
    // Capture scroll anywhere (results list scrolls under a fixed menu).
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('touchstart', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [menu, closeMenu]);

  // Focus the first menu item on open for keyboard users.
  useEffect(() => {
    if (!menu) return;
    const id = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [menu]);

  const isCurrent = current?.id === song.id;
  const isPlaying = isCurrent && playerState === 'PLAYING';
  const provider = getProviderManager().get(song.providerId);
  const providerAllows = provider?.capabilities.supportsOffline ?? false;
  // Truthful offline status (Phase 12): the badge reflects an ACTUAL valid
  // local file in offline storage — never provider existence, cache
  // metadata, reference URLs, or downloadAllowed alone. useOfflineStatus
  // checks offlineRepo.get(song.id); deleted/missing files show no badge.
  // Strict offline truth (§17): ONLY the live offlineRepo check counts.
  // The isOfflineAvailable flag is never consulted here — it can go stale
  // (file deleted outside the app) and must not produce a badge alone.
  const offlineAvailable = useOfflineStatus(song.id);
  // Per-track license wins when the provider reports it (Jamendo
  // audiodownload_allowed, IA rights, FreeToUse premium).
  // Visibility is NEVER gated here — only download/offline actions are.
  // Preview-only tracks are never offline-capable.
  const isPreview = isPreviewSong(song);
  // Discovery-only sources (e.g. YouTube Music metadata, web references):
  // searchable but never streamable/downloadable. Shown honestly — never a
  // fake Play. Includes web-* ids and per-track non-streamable records
  // (e.g. AirBeats without an authorized audio tier).
  const isWebId = song.providerId.startsWith('web-');
  const isDiscovery = isWebId
    || provider?.capabilities.supportsStreaming === false
    || (song.capabilities?.streamable === false && !song.streamUrl && !song.isLocalFile && !offlineAvailable);
  const canOffline = !isPreview && !isDiscovery && providerAllows && song.downloadAllowed !== false;
  const matchLabel = song.matchType === 'exact' ? 'Exact match'
    : song.matchType === 'strong' ? 'Strong match'
    : song.matchType === 'partial' ? 'Partial' : song.matchType === 'related' ? 'Related' : null;

  const doFav = async () => {
    const isFav = await favoriteRepo.isFavorite(song.id);
    if (isFav) { await favoriteRepo.remove(song.id); toast('Removed from Favorites'); }
    else { await favoriteRepo.add(song.id); toast('♥ Added to Favorites'); }
    setMenu(null);
  };

  const play = useCallback(() => {
    if (preparing) return;
    if (onRequestPlay) {
      void onRequestPlay(song);
      return;
    }
    if (isDiscovery) {
      toast('Playback isn\u2019t available for this source. This result is for discovery only.', 'warn');
      return;
    }
    void (async () => {
      const ok = await playSong(song);
      if (!ok) {
        const err = usePlayer.getState().error;
        toast(err || 'Unable to play this track', 'error');
      }
    })();
  }, [playSong, song, isDiscovery, onRequestPlay, preparing]);

  const toggleMenu = useCallback((e: React.MouseEvent | React.KeyboardEvent) => {
    // Isolation: the menu button must never trigger row playback.
    e.stopPropagation();
    if (menu) {
      setMenu(null);
      return;
    }
    const el = menuButtonRef.current;
    const r = el?.getBoundingClientRect();
    const anchorX = r ? r.left : (e as React.MouseEvent).clientX ?? 0;
    const anchorY = r ? r.bottom + 6 : (e as React.MouseEvent).clientY ?? 0;
    setMenu(clampMenuPosition(anchorX, anchorY));
  }, [menu]);

  const onMenuKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Roving arrow-key navigation between menu items.
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)') ?? [])];
    if (items.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    let i = items.findIndex((b) => b === active);
    if (e.key === 'ArrowDown') i = (i + 1) % items.length;
    else if (e.key === 'ArrowUp') i = (i - 1 + items.length) % items.length;
    else if (e.key === 'Home') i = 0;
    else i = items.length - 1;
    items[i]?.focus();
  }, []);

  const menuAction = useCallback((fn: () => void) => {
    // Menu lives in a portal outside the row, so its clicks never bubble to
    // the row — stopPropagation here is belt-and-braces for inner overlays.
    return (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  }, []);

  return (
    <div
      className={`song-row${isCurrent ? ' current' : ''}`}
      data-playing={isCurrent ? 'true' : 'false'}
      data-testid="song-row"
    >
      {/* Main play target: artwork + title + meta. Sibling of the menu
          button (never nested), so clicks here play and ONLY here play. */}
      <button
        type="button"
        className="song-row-content"
        onClick={play}
        aria-label={isDiscovery
          ? `View ${song.title} by ${song.artist} (discovery only, no playback)`
          : isPreview
          ? `Preview ${song.title} by ${song.artist} (30-second preview)`
          : `Play ${song.title} by ${song.artist}`}
        data-testid="song-row-play"
      >
        {index !== undefined && <span style={{ width: 26, flexShrink: 0, color: 'var(--text-3)', fontSize: 13 }}>{String(index + 1).padStart(2, '0')}</span>}
        <img src={artworkFor(song)} alt="" loading="lazy" onError={handleArtworkError(song)} />
        <span className="song-meta">
          <span className="song-title" title={song.title}>
            <span className="song-title-text">{song.title}</span>
            {offlineAvailable && <span className="song-offline-mark" title="Available offline" aria-label="Available offline">↓</span>}
          </span>
          <span className="song-sub" title={`${song.artist} • ${song.album}`}>{song.artist} • {song.album}</span>
          <span className="song-badges">
            <span className="provider-chip" aria-label={`Source ${providerLabel(song.providerId)}`}>● {providerLabel(song.providerId)}</span>
            {matchLabel && song.matchType && (
              <span className={`match-badge ${song.matchType}`} aria-label={`Match confidence: ${matchLabel}`}>{matchLabel}</span>
            )}
            {isPreview && <span className="cap-chip preview" title={`Only a 30-second preview is playable (full track ${formatMs(song.durationMs)})`}>Preview 30s</span>}
            {isDiscovery && <span className="cap-chip preview" title="Discovery-only metadata — playback, download, and offline are not available from this source">Discovery</span>}
            {isWebId && <span className="cap-chip preview" title="Reference/metadata only — not playable, not downloadable, never cached">Web reference</span>}
            {!isPreview && !isDiscovery && offlineAvailable && <span className="cap-chip offline-ok" title="Saved on this device — plays offline">Available Offline</span>}
          </span>
        </span>
        <span className="song-duration">
          {preparing
            ? <span role="status" aria-label="Preparing track" style={{ fontSize: 12 }}>Preparing…</span>
            : isPlaying && <span className="eq" aria-label="Now playing" role="img"><span /><span /><span /></span>}
          {/* Honest length: previews display the playable preview length
              (0:30), never the catalog's full commercial duration. */}
          <span
            className="song-duration-text"
            title={isPreview ? `30-second preview (full track ${formatMs(song.durationMs)})` : formatMs(isPreview ? previewDurationFor(song) : song.durationMs)}
          >
            {formatMs(isPreview ? previewDurationFor(song) : song.durationMs)}
          </span>
        </span>
      </button>
      <button
        ref={menuButtonRef}
        type="button"
        className="ghost-icon-btn song-row-menu-button"
        aria-label={`More options for ${song.title}`}
        aria-haspopup="menu"
        aria-expanded={menu ? true : false}
        data-testid="song-row-menu-button"
        // mousedown fires before the window outside-close listener would see
        // this click — stopping it here lets the button toggle instead of
        // instantly re-closing the menu it just opened.
        onMouseDown={(e) => e.stopPropagation()}
        onClick={toggleMenu}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            e.stopPropagation();
            toggleMenu(e);
          }
        }}
      >⋮</button>
      {menu && createPortal(
        <div
          ref={menuRef}
          className="menu song-context-menu"
          style={{ left: menu.x, top: menu.y }}
          role="menu"
          aria-label={`Options for ${song.title}`}
          onKeyDown={onMenuKeyDown}
          data-testid="song-context-menu"
        >
          {isDiscovery ? (
            <button type="button" role="menuitem" disabled title="This result is for discovery only — no playback from this source">
              ⓘ Discovery only — no playback
            </button>
          ) : (
            <button type="button" role="menuitem" onClick={menuAction(() => { play(); setMenu(null); })}>
              {isPreview ? '▶ Play Preview' : '▶ Play'}
            </button>
          )}
          <button type="button" role="menuitem" onClick={menuAction(() => { addToQueue(song, true); toast('Will play next'); setMenu(null); })}>⏭ Play next</button>
          <button type="button" role="menuitem" onClick={menuAction(() => { addToQueue(song); toast('Added to Queue'); setMenu(null); })}>＋ Add to queue</button>
          <button type="button" role="menuitem" onClick={menuAction(() => { void doFav(); })}>♥ Favorite</button>
          {/* Preview-only and discovery-only sources never offer offline/download
              actions — they are hidden (not just disabled) unless capability permits. */}
          {!isPreview && !isDiscovery && (
          <button
            type="button"
            role="menuitem"
            disabled={!canOffline}
            title={canOffline ? 'Save for offline listening' : "Offline storage isn't available for this source"}
            onClick={menuAction(() => {
              setMenu(null);
              useDownloads.getState().enqueue(song).then(
                () => toast('↓ Download queued'),
                (err: Error) => toast(err.message, 'warn'),
              );
            })}
          >↓ {canOffline ? 'Make available offline' : 'Offline download unavailable'}</button>
          )}
          <button type="button" role="menuitem" onClick={menuAction(() => { setMenu(null); onOpenArtist?.(song); })}>☺ View artist</button>
          <button type="button" role="menuitem" onClick={menuAction(() => { setMenu(null); onOpenAlbum?.(song); })}>⊙ View album</button>
          {song.sourceUrl && (
            <button type="button" role="menuitem" onClick={menuAction(() => { setMenu(null); window.open(song.sourceUrl, '_blank', 'noopener'); })}>↗ Open source</button>
          )}
          <button type="button" role="menuitem" onClick={menuAction(() => { setMenu(null); setInfoOpen(true); })}>ⓘ Song information</button>
          <button type="button" role="menuitem" onClick={menuAction(() => {
            setMenu(null);
            void (async () => {
              const pls = await playlistRepo.list();
              const name = window.prompt(`Add to playlist (existing: ${pls.map((p) => p.name).join(', ') || 'none'}). Type a new name to create:`);
              if (!name) return;
              const found = pls.find((p) => p.name.toLowerCase() === name.toLowerCase());
              if (found) { await playlistRepo.addTrack(found.id, song.id); toast(`Added to ${found.name}`); }
              else { const pl = await playlistRepo.create(name, '', [song.id]); toast(`Created playlist ${pl.name}`); }
            })();
          })}>✎ Add to playlist</button>
          <button type="button" role="menuitem" onClick={menuAction(() => {
            setMenu(null);
            const text = `${song.title} — ${song.artist} (${song.album})`;
            if (navigator.share) navigator.share({ title: song.title, text }).catch(() => undefined);
            else void navigator.clipboard?.writeText(text).then(() => toast('Song info copied'));
          })}>↗ Share</button>
        </div>,
        document.body,
      )}
      {infoOpen && createPortal(
        <SongInfoDialog song={song} onClose={() => setInfoOpen(false)} />,
        document.body,
      )}
    </div>
  );
}

function SongInfoDialog({ song, onClose }: { song: Song; onClose: () => void }) {
  const [title, setTitle] = useState(song.title);
  const [artist, setArtist] = useState(song.artist);
  const [album, setAlbum] = useState(song.album);
  const [genre, setGenre] = useState(song.genre ?? '');
  const [year, setYear] = useState(song.year ? String(song.year) : '');
  const editable = song.isLocalFile || song.providerId === 'local';
  const provider = getProviderManager().get(song.providerId);

  const save = async () => {
    const { songRepo } = await import('../data/repositories');
    await songRepo.upsert({
      ...song,
      title: title.trim() || song.title,
      artist: artist.trim() || song.artist,
      album: album.trim() || song.album,
      genre: genre.trim() || undefined,
      year: year.trim() ? Number(year) : undefined,
    });
    toast('✓ Song info updated');
    onClose();
  };

  return (
    <div className="now-playing" role="dialog" aria-label={`Song information for ${song.title}`} onClick={(e) => { e.stopPropagation(); }}>
      <div className="now-playing-card glass" style={{ textAlign: 'left' }} onClick={(e) => e.stopPropagation()}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>Song information</strong>
          <button className="icon-btn" onClick={onClose} aria-label="Close song information">✕</button>
        </div>
        <div style={{ display: 'grid', gap: 10, marginTop: 12 }}>
          <label className="lbl">Title<input className="text-input" value={title} onChange={(e) => setTitle(e.target.value)} disabled={!editable} /></label>
          <label className="lbl">Artist<input className="text-input" value={artist} onChange={(e) => setArtist(e.target.value)} disabled={!editable} /></label>
          <label className="lbl">Album<input className="text-input" value={album} onChange={(e) => setAlbum(e.target.value)} disabled={!editable} /></label>
          <label className="lbl">Genre<input className="text-input" value={genre} onChange={(e) => setGenre(e.target.value)} disabled={!editable} /></label>
          <label className="lbl">Year<input className="text-input" value={year} onChange={(e) => setYear(e.target.value)} disabled={!editable} inputMode="numeric" /></label>
          <div style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
            Duration {formatMs(song.durationMs)} · Source {provider?.name ?? song.providerId} ·
            {editable ? ' Edits update your local library record.' : ' Metadata from online providers is read-only.'}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {editable && <button className="btn btn-primary" onClick={() => void save()}>Save</button>}
            <button className="btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function useOfflineStatus(songId: string): boolean {
  const [off, setOff] = useState(false);
  useEffect(() => {
    if (!songId) {
      setOff(false);
      return;
    }
    let live = true;
    setOff(false);
    import('../data/repositories').then(({ offlineRepo }) => {
      offlineRepo.get(songId).then((r) => { if (live) setOff(!!r); }).catch(() => undefined);
    });
    return () => { live = false; };
  }, [songId]);
  void useSettings;
  return off;
}
