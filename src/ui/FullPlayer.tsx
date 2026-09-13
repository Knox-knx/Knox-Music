import React, { useEffect, useMemo, useRef, useState } from 'react';
import { usePlayer } from '../audio/playerStore';
import { useSettings } from '../settings/settingsStore';
import { artworkFor, handleArtworkError, useOfflineStatus } from './SongRow';
import { SourceTagChip } from './editorial';
import { formatMs, clamp } from '../core/utils';
import { favoriteRepo, playlistRepo } from '../data/repositories';
import { useDownloads } from '../downloads/DownloadManager';
import { toast } from './toast';
import { getProviderManager } from '../providers/ProviderManager';
import { isPreviewSong, previewDurationFor } from '../providers/capabilities';
import { providerLabel } from '../providers/merge';
import { parseLrc, activeLyricIndex } from '../library/lyrics';
import { fetchLyricsForSong } from '../providers/lyrics/lrclib';
import { getDb } from '../data/db';

const SLEEP_OPTIONS: (number | 'song' | null)[] = [null, 5, 10, 15, 30, 45, 60, 'song'];

function sleepLabel(o: number | 'song' | null): string {
  return o === null ? 'Off' : o === 'song' ? 'End of song' : `${o} min`;
}

/**
 * Decorative soundbar + Knox mark (minimalist card slot where the reference
 * shows a Spotify code + logo). Bars are deterministic per track so they are
 * stable across renders; purely decorative (aria-hidden).
 */
function KnoxSoundCode({ seed }: { seed: string }) {
  const bars = (() => {
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    const out: number[] = [];
    for (let i = 0; i < 48; i++) {
      h = (h * 1103515245 + 12345) >>> 0;
      out.push(6 + (h % 26));
    }
    return out;
  })();
  return (
    <div className="knox-soundcode-row" aria-hidden>
      <div className="knox-waveform">
        {bars.map((hh, i) => (
          <span key={i} style={{ height: hh }} />
        ))}
      </div>
      <img
        src="/icons/icon-192.png"
        alt=""
        width={34}
        height={34}
        className="knox-soundcode-mark"
        loading="lazy"
      />
    </div>
  );
}

/**
 * Now Playing sheet — calm control-center card (Spec §4), warm KNOX skin.
 * Bottom sheet ~92% height, 24dp top corners, drag handle; artwork cross-fades
 * on track change and the sheet springs in (~300ms) as an approximation of the
 * mini-player shared-element morph. Swipe-down / backdrop-tap / ⌄ dismiss.
 * All playback logic is unchanged — only layout/styling moved here.
 */
export function FullPlayer({ onClose, onOpenQueue }: { onClose: () => void; onOpenQueue?: () => void }) {
  const current = usePlayer((s) => s.current);
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);
  const state = usePlayer((s) => s.state);
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const seek = usePlayer((s) => s.seek);
  const rate = usePlayer((s) => s.rate);
  const setRate = usePlayer((s) => s.setRate);
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
  const addToQueue = usePlayer((s) => s.addToQueue);
  const previewEnded = usePlayer((s) => s.previewEnded);
  const playerError = usePlayer((s) => s.error);
  // Rules-of-Hooks: ALL subscriptions must run unconditionally before any
  // early return (see original comment — fewer hooks on current→null
  // unmounted the whole tree / black WebView while audio kept playing).
  const playerMode = usePlayer((s) => s.playerMode);
  const currentStation = usePlayer((s) => s.currentStation);
  const autoplayNotice = usePlayer((s) => s.autoplayNotice);
  const dismissAutoplayNotice = usePlayer((s) => s.dismissAutoplayNotice);
  const autoplayOn = useSettings((s) => s.autoplay);
  const patchSettings = useSettings((s) => s.patch);

  const [view, setView] = useState<'controls' | 'lyrics' | 'info'>('controls');
  const [lyrics, setLyrics] = useState<{ timeMs: number; text: string }[] | null>(null);
  const [lyricsSynced, setLyricsSynced] = useState(true);
  const [lyricsSource, setLyricsSource] = useState<string | null>(null);
  const [lyricsState, setLyricsState] = useState<'loading' | 'ready' | 'empty'>('loading');
  const [isFav, setIsFav] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [scrubDrag, setScrubDrag] = useState(false);
  const [sleepIdx, setSleepIdx] = useState(0);
  const touchY = useRef<number | null>(null);

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

  // Escape dismisses the sheet (overflow menu consumes its own keys first).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
  const canOffline = provider?.capabilities.supportsOffline ?? false;
  const isPreview = isPreviewSong(current);
  const isRadio = playerMode === 'radio';
  // Offline/download actions are only offered when the capability explicitly
  // permits them — never for preview-only sources, never for live radio.
  const showOfflineAction = !isPreview && !isRadio && canOffline;
  const sleepRemaining = sleepTimerEndsAt ? Math.max(0, sleepTimerEndsAt - Date.now()) : null;

  const doFavorite = async () => {
    try {
      if (isRadio) { const { songRepo } = await import('../data/repositories'); await songRepo.upsert(current).catch(() => undefined); }
      if (isFav) { await favoriteRepo.remove(current.id); setIsFav(false); toast('Removed from Favorites'); }
      else { await favoriteRepo.add(current.id); setIsFav(true); toast('♥ Added to Favorites'); }
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

  const cycleRepeat = () => setRepeat(repeat === 'OFF' ? 'ALL' : repeat === 'ALL' ? 'ONE' : 'OFF');
  const cycleSpeed = () => {
    const speeds = [0.75, 1, 1.25, 1.5, 2];
    const i = speeds.indexOf(rate);
    const nextRate = speeds[(i + 1) % speeds.length];
    setRate(nextRate);
    toast(`Speed ${nextRate}×`);
  };
  const cycleSleep = () => {
    const i = (sleepIdx + 1) % SLEEP_OPTIONS.length;
    setSleepIdx(i);
    setSleepTimer(SLEEP_OPTIONS[i]);
    toast(SLEEP_OPTIONS[i] === null ? 'Sleep timer off' : `Sleep timer: ${sleepLabel(SLEEP_OPTIONS[i])}`);
  };

  const seekFromClientX = (clientX: number, el: HTMLDivElement) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 0) return;
    seek(clamp((clientX - r.left) / r.width, 0, 1) * durationMs);
  };

  return (
    <div
      className="knox-sheet-backdrop"
      role="dialog"
      aria-label={`Now playing ${current.title}`}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="knox-sheet"
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => { touchY.current = e.touches[0].clientY; }}
        onTouchEnd={(e) => {
          if (touchY.current === null) return;
          const dy = e.changedTouches[0].clientY - touchY.current;
          touchY.current = null;
          if (dy > 90) onClose();
        }}
      >
        <div className="knox-drag-handle" aria-hidden />

        {/* Top row: dismiss left, overflow right */}
        <div className="knox-sheet-toprow">
          <button className="knox-icon-btn" onClick={onClose} aria-label="Close player">⌄</button>
          <button
            className="knox-icon-btn" onClick={() => setOverflowOpen((v) => !v)}
            aria-label="More options" aria-expanded={overflowOpen} aria-haspopup="menu"
          >•••</button>
        </div>
        {overflowOpen && (
          <div className="menu" role="menu" aria-label="More options" style={{ position: 'static', marginBottom: 8 }}>
            <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); setView('info'); }}>ⓘ Song information</button>
            <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); setView('lyrics'); }}>❝ Lyrics</button>
            <button type="button" role="menuitem" onClick={() => {
              setOverflowOpen(false);
              void (async () => {
                const pls = await playlistRepo.list();
                const name = window.prompt(`Add to playlist (existing: ${pls.map((p) => p.name).join(', ') || 'none'}). Type a new name to create:`);
                if (!name) return;
                const found = pls.find((p) => p.name.toLowerCase() === name.toLowerCase());
                if (found) { await playlistRepo.addTrack(found.id, current.id); toast(`Added to ${found.name}`); }
                else { const pl = await playlistRepo.create(name, '', [current.id]); toast(`Created playlist ${pl.name}`); }
              })();
            }}>✎ Add to playlist</button>
            <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); addToQueue(current, true); toast('Will play next'); }}>＋ Play next</button>
            {showOfflineAction && (
              <button type="button" role="menuitem" onClick={() => {
                setOverflowOpen(false);
                useDownloads.getState().enqueue(current).then(() => toast('↓ Download queued'), (e: Error) => toast(e.message, 'warn'));
              }}>↓ Make available offline</button>
            )}
            {current.sourceUrl && (
              <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); window.open(current.sourceUrl, '_blank', 'noopener'); }}>↗ Open source</button>
            )}
            <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); void doShare(); }}>↗ Share</button>
            <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); cycleSpeed(); }}>⏩ Speed: {rate}×</button>
            <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); cycleSleep(); }}>⏾ Sleep: {sleepLabel(SLEEP_OPTIONS[sleepIdx])}</button>
            <button type="button" role="menuitem" onClick={() => {
              setOverflowOpen(false);
              void patchSettings({ autoplay: !autoplayOn });
              toast(`Autoplay ${autoplayOn ? 'off' : 'on'}`);
            }}>▶∞ Autoplay: {autoplayOn ? 'on' : 'off'}</button>
          </div>
        )}

        {view !== 'controls' && (
          <div style={{ display: 'flex', marginBottom: 4 }}>
            <button className="knox-chevron-btn" onClick={() => setView('controls')} aria-label="Back to controls">‹ Back</button>
          </div>
        )}

        {view === 'controls' && (
          <>
            {/* Square artwork, generous surrounding space — cross-fades on track change. */}
            <div className="knox-sheet-art-wrap">
              <img
                key={current.id}
                src={art}
                alt={`${current.album} artwork`}
                className="knox-sheet-art knox-sheet-art-fade"
                onError={handleArtworkError(current)}
              />
            </div>

            {/* Decorative soundbar + Knox mark (minimalist card slot). */}
            <KnoxSoundCode seed={current.id} />

            {/* Song title (bold, large) + artist (smaller, muted), heart right */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, maxWidth: 420, margin: '0 auto', width: '100%', padding: '0 4px' }}>
              <div style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                <div className="knox-sheet-title" title={current.title}>{current.title}</div>
                <div className="knox-sheet-artist" title={`${current.artist} — ${current.album}`}>
                  {current.artist}{current.album ? ` — ${current.album}` : ''}
                </div>
              </div>
              <button
                className="knox-icon-btn knox-np-fav"
                onClick={() => void doFavorite()}
                aria-pressed={isFav}
                aria-label={isFav ? 'Remove from Favorites' : 'Add to Favorites'}
                title={isFav ? 'Remove from Favorites' : 'Add to Favorites'}
                style={{ color: isFav ? 'var(--accent-gold)' : undefined }}
              >{isFav ? '♥' : '♡'}</button>
            </div>

            {isRadio && currentStation && (
              <p style={{ color: 'var(--live-red)', fontSize: 12.5, fontWeight: 700, margin: '6px 0 0', textAlign: 'left' }} aria-label="Live radio">
                ● LIVE{currentStation.country ? ` · ${currentStation.country}` : ''}
                {currentStation.bitrate ? ` · ${currentStation.bitrate}k` : ''}
              </p>
            )}
            {!isRadio && isPreview && (
              <p style={{ color: 'var(--accent-gold)', fontSize: 12.5, fontWeight: 700, margin: '6px 0 0', textAlign: 'left' }} aria-label="30-second preview">
                {providerLabel(current.providerId)} · Preview 30s
              </p>
            )}
            {isPreview && previewEnded && (
              <p role="status" style={{ color: 'var(--accent-gold)', fontSize: 12.5, margin: '4px 0 0', textAlign: 'left' }}>
                Preview ended — press Play to replay from 0:00
              </p>
            )}
            {playerError && (
              <div role="alert" className="np-error">
                <strong>Unable to play this track</strong>
                <span>{playerError}</span>
              </div>
            )}
            {autoplayNotice && (
              <p role="status" style={{ color: 'var(--text-2)', fontSize: 12, margin: '4px 0 0', textAlign: 'left' }}>
                {autoplayNotice} <button className="ghost-icon-btn" style={{ width: 24, height: 24, display: 'inline-grid' }} onClick={dismissAutoplayNotice} aria-label="Dismiss autoplay notice">✕</button>
              </p>
            )}

            {isRadio ? (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-start', padding: '12px 0' }} aria-label="Live stream">
                <span className="cap-chip live" aria-label="Live">● LIVE</span>
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '14px auto 2px', maxWidth: 420, width: '100%', padding: '0 4px' }}>
                <span className="knox-time">{formatMs(positionMs)}</span>
                <div
                  className={`knox-scrub${scrubDrag ? ' dragging' : ''}`}
                  role="slider" aria-label="Seek"
                  aria-valuemin={0} aria-valuemax={Math.round(durationMs)} aria-valuenow={Math.round(positionMs)}
                  aria-valuetext={`${formatMs(positionMs)} of ${formatMs(durationMs)}`}
                  tabIndex={0}
                  onClick={(e) => seekFromClientX(e.clientX, e.currentTarget)}
                  onPointerDown={(e) => {
                    (e.currentTarget as HTMLDivElement).setPointerCapture?.(e.pointerId);
                    setScrubDrag(true);
                    seekFromClientX(e.clientX, e.currentTarget as HTMLDivElement);
                  }}
                  onPointerMove={(e) => {
                    if (scrubDrag) seekFromClientX(e.clientX, e.currentTarget as HTMLDivElement);
                  }}
                  onPointerUp={(e) => { setScrubDrag(false); seekFromClientX(e.clientX, e.currentTarget as HTMLDivElement); }}
                  onPointerCancel={() => setScrubDrag(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowRight') { e.preventDefault(); seek(positionMs + 5000); }
                    if (e.key === 'ArrowLeft') { e.preventDefault(); seek(positionMs - 5000); }
                    if (e.key === 'Home') { e.preventDefault(); seek(0); }
                    if (e.key === 'End') { e.preventDefault(); seek(durationMs); }
                  }}
                >
                  <div className="knox-scrub-fill" style={{ width: `${pct * 100}%` }}>
                    <span className="knox-scrub-knob" aria-hidden />
                  </div>
                </div>
                <span className="knox-time right">{formatMs(durationMs)}</span>
              </div>
            )}

            {/* Minimalist 5-button transport: shuffle · previous · outlined play · next · repeat */}
            <div className="knox-transport-5" role="toolbar" aria-label="Playback controls">
              <button className="knox-t5-btn" onClick={() => setShuffle(!shuffle)} aria-label="Shuffle" aria-pressed={shuffle} title="Shuffle">⇄</button>
              <button className="knox-t5-btn" onClick={() => void prev()} aria-label="Previous">⏮</button>
              <button className="knox-play-outline" onClick={() => void toggle()} aria-label={playing ? 'Pause' : 'Play'}>
                {busy ? '…' : playing ? '❚❚' : '▶'}
              </button>
              <button className="knox-t5-btn" onClick={() => void next()} aria-label="Next">⏭</button>
              <button
                className="knox-t5-btn" onClick={cycleRepeat}
                aria-label={`Repeat ${repeat}`} aria-pressed={repeat !== 'OFF'}
                title={`Repeat: ${repeat}`}
              >{repeat === 'ONE' ? '↻¹' : '↻'}</button>
            </div>

            {/* Volume row */}
            {!isRadio && (
              <div className="knox-vol-row" style={{ maxWidth: 420, margin: '8px auto 2px', width: '100%', padding: '0 4px' }}>
                <button className="ghost-icon-btn" onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}>♪</button>
                <input
                  type="range" min={0} max={1} step={0.01} value={muted ? 0 : volume}
                  onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume"
                />
                <button className="ghost-icon-btn" onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}>♫</button>
              </div>
            )}

            {/* Quiet utilities: queue + lyrics (the main row above stays exactly the required five). */}
            <div className="knox-utility-row" role="toolbar" aria-label="More playback options">
              <button
                className="ghost-icon-btn"
                style={{ width: 'auto', padding: '0 12px', borderRadius: 999, fontSize: 13, gap: 6 }}
                onClick={() => { if (onOpenQueue) onOpenQueue(); else { addToQueue(current, true); toast('Will play next'); } }}
                aria-label="Queue" title={onOpenQueue ? 'Open queue' : 'Play next'}
              >☰ Queue</button>
              <button
                className="ghost-icon-btn"
                style={{ width: 'auto', padding: '0 12px', borderRadius: 999, fontSize: 13 }}
                onClick={() => setView('lyrics')} aria-label="Lyrics" title="Lyrics"
              >❝ Lyrics</button>
            </div>
            {sleepRemaining !== null && (
              <p style={{ fontSize: 12, color: 'var(--text-2)', textAlign: 'center', margin: '2px 0' }}>
                ⏾ {formatMs(sleepRemaining)} left <button className="btn" style={{ padding: '2px 10px' }} onClick={() => { setSleepTimer(null); setSleepIdx(0); }}>Clear</button>
              </p>
            )}

            {/* Footer: source tag chip */}
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
              <SourceTagChip label={provider?.name ?? current.providerId} />
            </div>
            <p style={{ color: 'var(--text-2)', fontSize: 12, margin: '8px 0 0', textAlign: 'center' }}>
              {offlineAvailable ? '↓ Offline • ' : ''}{current.genre ?? ''} {current.year ?? ''}
              {qualityLabel ? ` • ${qualityLabel}` : ''}
            </p>
          </>
        )}

        {view === 'lyrics' && (
          <div style={{ maxHeight: '52dvh', overflowY: 'auto', textAlign: 'center', padding: '8px 4px' }} aria-label="Lyrics">
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
                        toast('✓ Lyrics imported');
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
        )}
        {view === 'info' && (
          <dl style={{ textAlign: 'left', fontSize: 13.5, display: 'grid', gridTemplateColumns: '120px 1fr', gap: '6px 12px' }}>
            <dt style={{ color: 'var(--text-2)' }}>Title</dt><dd style={{ margin: 0 }}>{current.title}</dd>
            <dt style={{ color: 'var(--text-2)' }}>Artist</dt><dd style={{ margin: 0 }}>{current.artist}</dd>
            <dt style={{ color: 'var(--text-2)' }}>Album</dt><dd style={{ margin: 0 }}>{current.album}</dd>
            <dt style={{ color: 'var(--text-2)' }}>Duration</dt><dd style={{ margin: 0 }}>{isRadio
              ? 'Live stream'
              : isPreview
              ? `Preview ${formatMs(durationMs || previewDurationFor(current))} · Full track ${formatMs(current.durationMs)}`
              : formatMs(current.durationMs)}</dd>
            <dt style={{ color: 'var(--text-2)' }}>Playback</dt><dd style={{ margin: 0 }}>{isRadio
              ? `Live radio${currentStation?.codec ? ` (${currentStation.codec.toUpperCase()}${currentStation.bitrate ? ` ${currentStation.bitrate}k` : ''})` : ''}`
              : isPreview
              ? `30-second preview (${provider?.name ?? current.providerId})`
              : 'Full track'}</dd>
            <dt style={{ color: 'var(--text-2)' }}>Source</dt><dd style={{ margin: 0 }}>{provider?.name ?? current.providerId}</dd>
            <dt style={{ color: 'var(--text-2)' }}>Quality</dt><dd style={{ margin: 0 }}>{qualityLabel ?? '—'}</dd>
            <dt style={{ color: 'var(--text-2)' }}>Offline</dt><dd style={{ margin: 0 }}>{offlineAvailable ? '✓ Available offline' : canOffline ? 'Not saved' : 'Not supported by source'}</dd>
          </dl>
        )}
      </div>
    </div>
  );
}

export async function importLrcForSong(songId: string, file: File): Promise<boolean> {
  const text = await file.text();
  const lines = parseLrc(text);
  if (!lines) return false;
  await getDb().lyrics.put({ songId, lines, synced: true, source: file.name });
  return true;
}
