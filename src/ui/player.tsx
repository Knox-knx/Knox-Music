import React, { useState, useRef } from 'react';
import { usePlayer } from '../audio/playerStore';
import { useSettings } from '../settings/settingsStore';
import { formatMs, clamp } from '../core/utils';
import { isPreviewSong } from '../providers/capabilities';
import { providerLabel } from '../providers/merge';
import { artworkFor, handleArtworkError } from './SongRow';
import { Icon } from './icons';
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
        style={{ opacity: shuffle ? 1 : 0.55, borderColor: shuffle ? 'var(--accent)' : undefined }}><Icon name="shuffle" size={16} /></button>
      <button className="icon-btn" onClick={() => void prev()} aria-label="Previous"><Icon name="prev" size={16} /></button>
      <button className={`icon-btn${big ? ' lg' : ''}`} onClick={() => void toggle()} aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? <Icon name="pause" size={big ? 22 : 16} /> : <Icon name="play" size={big ? 22 : 16} />}
      </button>
      <button className="icon-btn" onClick={() => void next()} aria-label="Next"><Icon name="next" size={16} /></button>
      <button className="icon-btn" onClick={cycleRepeat} aria-label={`Repeat ${repeat}`} title={`Repeat: ${repeat}`}
        style={{ opacity: repeat === 'OFF' ? 0.55 : 1, borderColor: repeat === 'OFF' ? undefined : 'var(--accent)' }}>
        <span style={{ position: 'relative', display: 'inline-flex' }}><Icon name="repeat" size={16} />{repeat === 'ONE' && <span style={{ position: 'absolute', right: -5, bottom: -4, fontSize: 9, fontWeight: 800 }}>1</span>}</span>
      </button>
      <button className="icon-btn" onClick={() => void patchSettings({ autoplay: !autoplay })}
        aria-label={`Autoplay ${autoplay ? 'on' : 'off'}`} aria-pressed={autoplay} title={`Autoplay: ${autoplay ? 'ON' : 'OFF'} — continue with related tracks when the queue ends`}
        style={{ opacity: autoplay ? 1 : 0.55, borderColor: autoplay ? 'var(--accent)' : undefined, fontSize: 13, fontWeight: 700 }}>
        <Icon name="play" size={13} />∞
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
          display: 'flex', alignItems: 'center', gap: 12, minWidth: 0, width: 'clamp(180px, 22vw, 260px)', flexShrink: 0,
          background: 'none', border: 'none', padding: 0, cursor: 'pointer',
          textAlign: 'left', color: 'inherit', font: 'inherit', overflow: 'hidden',
        }}
      >
        <img src={artworkFor(current)} alt="" className={playing ? 'player-art playing knox-img-gold' : 'player-art knox-img-gold'} style={{ width: 52, height: 52, borderRadius: 12, objectFit: 'cover' }} onError={handleArtworkError(current)} />
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden' }}>
          <span style={{ display: 'block', fontWeight: 700, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{current.title}</span>
          <span style={{ display: 'block', color: 'var(--text-2)', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{current.artist}</span>
          {isRadio && currentStation && (
            <span style={{ display: 'block', fontSize: 11, color: 'var(--live-red)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} aria-label="Live radio">
              ● LIVE{currentStation.country ? ` · ${currentStation.country}` : ''}{currentStation.bitrate ? ` · ${currentStation.bitrate}k` : ''}
            </span>
          )}
          {!isRadio && isPreview && (
            <span style={{ display: 'block', fontSize: 11, color: 'var(--warning)', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} aria-label="30-second preview">
              {providerLabel(current.providerId)} · Preview 30s{previewEnded ? ' · Preview ended' : ''}
            </span>
          )}
        </span>
      </button>
      <Transport />
      <ProgressBar />
      <button className="icon-btn" onClick={onOpenQueue} aria-label="Open queue"><Icon name="list" size={16} /></button>
      <button className="icon-btn" onClick={onExpand} aria-label="Open full player"><Icon name="expand" size={16} /></button>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => setMuted(!muted)} aria-label={muted ? 'Unmute' : 'Mute'} title={muted ? 'Unmute' : 'Mute'}>
          <Icon name={muted ? 'volumeX' : 'speakerLow'} size={15} />
        </button>
        <input type="range" className="vol" min={0} max={1} step={0.01} value={muted ? 0 : volume}
          onChange={(e) => { if (muted) setMuted(false); setVolume(Number(e.target.value)); }} aria-label="Volume" style={{ width: 90 }} />
        <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={() => { if (muted) setMuted(false); setVolume(1); }} aria-label="Full volume" title="Full volume">
          <Icon name="speakerHigh" size={15} />
        </button>
      </div>
    </footer>
  );
}

export function MiniPlayer({ onExpand }: { onExpand: () => void }) {
  const current = usePlayer((s) => s.current);
  const toggle = usePlayer((s) => s.toggle);
  const next = usePlayer((s) => s.next);
  const prev = usePlayer((s) => s.prev);
  const state = usePlayer((s) => s.state);
  const volume = usePlayer((s) => s.volume);
  const setVolume = usePlayer((s) => s.setVolume);
  const muted = usePlayer((s) => s.muted);
  const setMuted = usePlayer((s) => s.setMuted);
  const playerMode = usePlayer((s) => s.playerMode);
  const touchStartY = useRef<number | null>(null);

  if (!current) return null;
  const playing = state === 'PLAYING' || state === 'BUFFERING';
  const isRadio = playerMode === 'radio';
  const isPreview = isPreviewSong(current);

  return (
    <div
      className="knox-miniplayer knox-image2-controller"
      aria-label={isPreview ? `Now playing: ${current.title} (30-second preview)` : `Now playing: ${current.title}`}
      role="region"
      onTouchStart={(e) => {
        touchStartY.current = e.touches[0].clientY;
      }}
      onTouchEnd={(e) => {
        if (touchStartY.current === null) return;
        const dy = touchStartY.current - e.changedTouches[0].clientY;
        touchStartY.current = null;
        if (dy > 30) {
          // Swiped up -> smoothly open full player like YouTube
          onExpand();
        }
      }}
    >
      {/* Square cover art on left (Image 2) — clicking expands full player */}
      <button
        type="button"
        className="knox-image2-art-btn"
        onClick={onExpand}
        aria-label={`Open full player: ${current.title}`}
        title="Open full player"
      >
        <img
          src={artworkFor(current)}
          alt=""
          className="knox-image2-art"
          onError={handleArtworkError(current)}
        />
      </button>

      {/* Center metadata area — clicking expands full player */}
      <button
        type="button"
        className="knox-image2-meta-btn"
        data-testid="mini-player-metadata"
        onClick={onExpand}
        aria-label={isPreview ? `Open now playing: ${current.title} (30-second preview)` : `Open now playing: ${current.title} by ${current.artist}`}
        title={`Open now playing: ${current.title}`}
      >
        <span className="knox-image2-title">{current.title}</span>
        <span className="knox-image2-artist">· {current.artist}</span>
        {isRadio && <span style={{ fontWeight: 700, fontSize: 10, color: 'var(--live-red)', marginLeft: 4 }} aria-label="Live">● LIVE</span>}
        {isPreview && (
          <span
            style={{ fontWeight: 700, fontSize: 10, color: 'var(--warning)', marginLeft: 4 }}
            aria-label="30-second preview"
          >
            Preview 30s
          </span>
        )}
      </button>

      {/* Right side compact controls */}
      <div className="knox-image2-right">
        <div className="knox-image2-transport-row">
          <button
            type="button"
            className="knox-image2-btn"
            onClick={(e) => { e.stopPropagation(); void prev(); }}
            aria-label="Previous"
            title="Previous track"
          >
            <Icon name="rewindDouble" size={17} />
          </button>
          <button
            type="button"
            className="knox-image2-btn knox-image2-play-btn"
            onClick={(e) => { e.stopPropagation(); void toggle(); }}
            aria-label={playing ? 'Pause' : 'Play'}
            title={playing ? 'Pause' : 'Play'}
          >
            {playing ? <Icon name="pause" size={18} /> : <Icon name="play" size={18} />}
          </button>
          <button
            type="button"
            className="knox-image2-btn"
            onClick={(e) => { e.stopPropagation(); void next(); }}
            aria-label="Next"
            title="Next track"
          >
            <Icon name="fastForwardDouble" size={17} />
          </button>
        </div>
      </div>
    </div>
  );
}

export const NotificationController = MiniPlayer;

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
          <button className="icon-btn" onClick={onClose} aria-label="Close queue"><Icon name="close" size={14} /></button>
        </div>
      </div>
      {autoplayNotice && (
        <div role="status" style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 8 }}>{autoplayNotice}</div>
      )}
      {index >= 0 && queue[index] && (
        <>
          <div className="nav-label">Now playing</div>
          <div style={{ padding: '6px 0 12px', fontWeight: 700 }}><Icon name="musicNote" size={14} /> {queue[index].title} — {queue[index].artist}</div>
          <div className="nav-label">Up next</div>
        </>
      )}
      {queue.length === 0 && <p style={{ color: 'var(--text-2)' }}>Queue is empty.</p>}
      {queue.map((s, i) => (
        i > index && (
          <div key={`${s.id}-${i}`} className="song-row" draggable
            onDragStart={() => setDrag(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => { if (drag !== null) reorderQueue(drag, i); setDrag(null); }}
            onClick={() => void playSong(s, queue)}
          >
            <span style={{ color: 'var(--text-3)', fontSize: 12 }}>{index >= 0 ? i - index : i + 1}.</span>
            <div className="song-meta">
              <div className="song-title">{s.title}</div>
              <div className="song-sub">{s.artist}{s.queueSource === 'autoplay' && <span style={{ marginLeft: 6, fontSize: 11, color: 'var(--text-3)' }} aria-label="Added by autoplay"> · Autoplay</span>}</div>
            </div>
            <button className="icon-btn" style={{ width: 28, height: 28 }} aria-label={`Remove ${s.title} from queue`}
              onClick={(e) => { e.stopPropagation(); removeFromQueue(s.id); }}><Icon name="close" size={13} /></button>
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
