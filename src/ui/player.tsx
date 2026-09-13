import React, { useState } from 'react';
import { usePlayer } from '../audio/playerStore';
import { useSettings } from '../settings/settingsStore';
import { formatMs, clamp } from '../core/utils';
import { isPreviewSong } from '../providers/capabilities';
import { providerLabel } from '../providers/merge';
import { artworkFor, handleArtworkError } from './SongRow';
import { ProgressRing } from './editorial';

function ProgressBar() {
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const playerMode = usePlayer((s) => s.playerMode);
  const seek = usePlayer((s) => s.seek);
  // Live radio has no duration and no seekable progress — show LIVE, never
  // a fake 00:00 / 03:42 bar.
  if (playerMode === 'radio') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }} aria-label="Live stream">
        <span className="cap-chip live" aria-label="Live">● LIVE</span>
      </div>
    );
  }
  const pct = durationMs > 0 ? clamp(positionMs / durationMs, 0, 1) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flex: 1, minWidth: 0 }}>
      <span style={{ fontSize: 11.5, color: 'var(--text-2)', minWidth: 38 }}>{formatMs(positionMs)}</span>
      <div
        className="progress" style={{ flex: 1 }} role="slider" aria-label="Seek"
        aria-valuemin={0} aria-valuemax={Math.round(durationMs)} aria-valuenow={Math.round(positionMs)}
        tabIndex={0}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          seek(((e.clientX - r.left) / r.width) * durationMs);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') seek(positionMs + 5000);
          if (e.key === 'ArrowLeft') seek(positionMs - 5000);
        }}
      >
        <div style={{ width: `${pct * 100}%` }} />
      </div>
      <span style={{ fontSize: 11.5, color: 'var(--text-2)', minWidth: 38 }}>{formatMs(durationMs)}</span>
    </div>
  );
}

function Transport({ big = false }: { big?: boolean }) {
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);
  const state = usePlayer((s) => s.state);
  const shuffle = usePlayer((s) => s.shuffle);
  const setShuffle = usePlayer((s) => s.setShuffle);
  const repeat = usePlayer((s) => s.repeat);
  const setRepeat = usePlayer((s) => s.setRepeat);
  const autoplay = useSettings((s) => s.autoplay);
  const patchSettings = useSettings((s) => s.patch);
  const playing = state === 'PLAYING' || state === 'BUFFERING';
  const cycleRepeat = () => setRepeat(repeat === 'OFF' ? 'ALL' : repeat === 'ALL' ? 'ONE' : 'OFF');
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: big ? 16 : 8 }}>
      <button className="icon-btn" onClick={() => setShuffle(!shuffle)} aria-label="Shuffle" aria-pressed={shuffle}
        style={{ opacity: shuffle ? 1 : 0.55, borderColor: shuffle ? 'var(--accent)' : undefined }}>⇄</button>
      <button className="icon-btn" onClick={() => void prev()} aria-label="Previous">⏮</button>
      <button className={`icon-btn${big ? ' lg' : ''}`} onClick={() => void toggle()} aria-label={playing ? 'Pause' : 'Play'}>
        {state === 'LOADING' || state === 'BUFFERING' ? '…' : playing ? '❚❚' : '▶'}
      </button>
      <button className="icon-btn" onClick={() => void next()} aria-label="Next">⏭</button>
      <button className="icon-btn" onClick={cycleRepeat} aria-label={`Repeat ${repeat}`} title={`Repeat: ${repeat}`}
        style={{ opacity: repeat === 'OFF' ? 0.55 : 1, borderColor: repeat === 'OFF' ? undefined : 'var(--accent)' }}>
        {repeat === 'ONE' ? '↻¹' : '↻'}
      </button>
      <button className="icon-btn" onClick={() => void patchSettings({ autoplay: !autoplay })}
        aria-label={`Autoplay ${autoplay ? 'on' : 'off'}`} aria-pressed={autoplay} title={`Autoplay: ${autoplay ? 'ON' : 'OFF'} — continue with related tracks when the queue ends`}
        style={{ opacity: autoplay ? 1 : 0.55, borderColor: autoplay ? 'var(--accent)' : undefined, fontSize: 13, fontWeight: 700 }}>
        ▶∞
      </button>
    </div>
  );
}

export function PlayerBar({ onExpand, onOpenQueue }: { onExpand: () => void; onOpenQueue: () => void }) {
  const current = usePlayer((s) => s.current);
  const volume = usePlayer((s) => s.volume);
  const setVolume = usePlayer((s) => s.setVolume);
  const muted = usePlayer((s) => s.muted);
  const setMuted = usePlayer((s) => s.setMuted);
  const state = usePlayer((s) => s.state);
  const previewEnded = usePlayer((s) => s.previewEnded);
  const playerMode = usePlayer((s) => s.playerMode);
  const currentStation = usePlayer((s) => s.currentStation);
  if (!current) return null;
  const playing = state === 'PLAYING' || state === 'BUFFERING';
  const isPreview = isPreviewSong(current);
  const isRadio = playerMode === 'radio';
  return (
    <footer className="player-bar desktop-only" aria-label="Now playing bar">
      {/* Metadata is the FullPlayer entry point: a real button (keyboard
          operable via Enter/Space) covering artwork + title + artist only.
          Transport / seek / volume / queue controls are siblings — clicking
          them never opens FullPlayer. */}
      <button
        type="button"
        className="player-bar-meta"
        data-testid="player-bar-metadata"
        onClick={onExpand}
        aria-label={`Open now playing: ${current.title} by ${current.artist}`}
        title={`Open now playing: ${current.title}`}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, width: 220,
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          textAlign: 'left', color: 'inherit', font: 'inherit',
        }}
      >
        <img src={artworkFor(current)} alt="" className={playing ? 'player-art playing' : 'player-art'} style={{ width: 52, height: 52, borderRadius: 12, objectFit: 'cover' }} onError={handleArtworkError(current)} />
        <span style={{ minWidth: 0 }}>
          <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{current.title}</span>
          <span style={{ display: 'block', color: 'var(--text-2)', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{current.artist}</span>
          {isRadio && currentStation && (
            <span style={{ display: 'block', fontSize: 11, color: 'var(--live-red)', fontWeight: 700 }} aria-label="Live radio">
              ● LIVE{currentStation.country ? ` · ${currentStation.country}` : ''}{currentStation.bitrate ? ` · ${currentStation.bitrate}k` : ''}
            </span>
          )}
          {!isRadio && isPreview && (
            <span style={{ display: 'block', fontSize: 11, color: 'var(--warning)', fontWeight: 700 }} aria-label="30-second preview">
              {providerLabel(current.providerId)} · Preview 30s{previewEnded ? ' · Preview ended' : ''}
            </span>
          )}
        </span>
      </button>
      <Transport />
      <ProgressBar />
      <button className="icon-btn" onClick={onOpenQueue} aria-label="Open queue">☰</button>
      <button className="icon-btn" onClick={onExpand} aria-label="Open full player">⛶</button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}>{muted ? '∅' : '♫'}</button>
        <input type="range" className="vol" min={0} max={1} step={0.01} value={muted ? 0 : volume}
          onChange={(e) => setVolume(Number(e.target.value))} aria-label="Volume" style={{ width: 90 }} />
      </div>
    </footer>
  );
}

export function MiniPlayer({ onExpand }: { onExpand: () => void }) {
  const current = usePlayer((s) => s.current);
  const toggle = usePlayer((s) => s.toggle);
  const state = usePlayer((s) => s.state);
  const positionMs = usePlayer((s) => s.positionMs);
  const durationMs = usePlayer((s) => s.durationMs);
  const playerMode = usePlayer((s) => s.playerMode);
  if (!current) return null;
  const playing = state === 'PLAYING';
  const isRadio = playerMode === 'radio';
  const pct = !isRadio && durationMs > 0 ? (positionMs / durationMs) * 100 : 0;
  const isPreview = isPreviewSong(current);
  // Only the metadata area (artwork + title/artist) opens FullPlayer: a real
  // button, so Enter/Space work natively. The play/pause control is a
  // sibling — activating it never opens FullPlayer. Playback state is
  // preserved (nothing restarts; the store is untouched by opening).
  // Warm editorial dock (§2): circular thumbnail + progress ring, one-line
  // truncate, play/pause right. Tapping metadata opens the full sheet.
  return (
    <div className="knox-miniplayer" aria-label={isPreview ? `Now playing: ${current.title} (30-second preview)` : `Now playing: ${current.title}`}>
      <span className="knox-ring" aria-hidden>
        <ProgressRing progress={isRadio ? 0 : pct / 100} />
        <img src={artworkFor(current)} alt="" onError={handleArtworkError(current)} />
      </span>
      <button
        type="button"
        className="knox-mini-meta"
        data-testid="mini-player-metadata"
        onClick={onExpand}
        aria-label={isPreview ? `Open now playing: ${current.title} (30-second preview)` : `Open now playing: ${current.title} by ${current.artist}`}
        title={`Open now playing: ${current.title}`}
      >
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="knox-mini-title">
            {current.title}
            {isRadio && <span style={{ fontWeight: 700, fontSize: 11, color: 'var(--live-red)', marginLeft: 6 }} aria-label="Live">● LIVE</span>}
            {!isRadio && isPreview && <span style={{ fontWeight: 700, fontSize: 11, color: 'var(--accent-gold)', marginLeft: 6 }} aria-label="30-second preview">Preview 30s</span>}
          </span>
          <span className="knox-mini-artist">{current.artist}</span>
        </span>
      </button>
      <div style={{ flex: '0 0 auto', display: 'flex', alignItems: 'center' }}>
        <button className="knox-icon-btn" aria-label={playing ? 'Pause' : 'Play'}
          onClick={() => void toggle()}>{playing ? '❚❚' : '▶'}</button>
      </div>
    </div>
  );
}

export function QueuePanel({ onClose, onSaveAsPlaylist }: { onClose: () => void; onSaveAsPlaylist: () => void }) {
  const queue = usePlayer((s) => s.queue);
  const index = usePlayer((s) => s.index);
  const playSong = usePlayer((s) => s.playSong);
  const removeFromQueue = usePlayer((s) => s.removeFromQueue);
  const clearQueue = usePlayer((s) => s.clearQueue);
  const reorderQueue = usePlayer((s) => s.reorderQueue);
  const autoplayNotice = usePlayer((s) => s.autoplayNotice);
  const autoplayOn = useSettings((s) => s.autoplay);
  const [drag, setDrag] = useState<number | null>(null);
  const upcoming = index >= 0 ? queue.slice(index + 1) : queue;
  const hasManualUpcoming = upcoming.some((s) => s.queueSource !== 'autoplay');
  return (
    <div className="queue-panel glass" role="dialog" aria-label="Queue">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
        <strong>Queue</strong>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn" onClick={onSaveAsPlaylist}>Save as playlist</button>
          <button className="icon-btn" onClick={onClose} aria-label="Close queue">✕</button>
        </div>
      </div>
      {autoplayNotice && (
        <div role="status" style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 8 }}>{autoplayNotice}</div>
      )}
      {index >= 0 && queue[index] && (
        <>
          <div className="nav-label">Now playing</div>
          <div style={{ padding: '6px 0 12px', fontWeight: 700 }}>♪ {queue[index].title} — {queue[index].artist}</div>
          <div className="nav-label">Up next</div>
        </>
      )}
      {queue.length === 0 && <p style={{ color: 'var(--text-2)' }}>Queue is empty.</p>}
      {queue.map((s, i) => (
        i !== index && (
          <div key={`${s.id}-${i}`} className="song-row" draggable
            onDragStart={() => setDrag(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (drag !== null) reorderQueue(drag, i); setDrag(null); }}
            onClick={() => void playSong(s)}
          >
            <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{i + 1}.</span>
            <div className="song-meta">
              <div className="song-title">{s.title}</div>
              <div className="song-sub">{s.artist}{s.queueSource === 'autoplay' && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-3)' }} aria-label="Added by autoplay"> · Autoplay</span>}</div>
            </div>
            <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label={`Remove ${s.title} from queue`}
              onClick={(e) => { e.stopPropagation(); removeFromQueue(s.id); }}>✕</button>
          </div>
        )
      ))}
      {queue.length > 0 && !hasManualUpcoming && autoplayOn && (
        <p style={{ fontSize: 12, color: 'var(--text-3)', margin: '8px 0 0' }}>Autoplay will continue with related tracks.</p>
      )}
      {queue.length > 0 && <button className="btn" style={{ marginTop: 10 }} onClick={clearQueue}>Clear queue</button>}
    </div>
  );
}
