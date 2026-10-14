import React, { useEffect, useState } from 'react';
import type { Song } from '../core/types';
import { getProviderManager } from '../providers/ProviderManager';
import { songRepo } from '../data/repositories';
import { usePlayer } from '../audio/playerStore';
import { useDownloads } from '../downloads/DownloadManager';
import { SongRow, artworkFor } from '../ui/SongRow';
import { Glyph, Icon } from '../ui/icons';
import { AlbumCard } from '../ui/AlbumCard';
import { Skeleton } from '../ui/primitives';
import { toast } from '../ui/toast';

export function ArtistScreen({ seed, onOpenAlbum }: { seed: Song; onOpenAlbum: (s: Song) => void }) {
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const playSongs = usePlayer((s) => s.playSongs);
  const artistName = seed.artist;

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const local = await songRepo.searchLocal(artistName, 100);
        const mine = local.filter((s) => s.artist === artistName);
        // Provider popular tracks when available
        let remote: Song[] = [];
        try {
          const pm = getProviderManager();
          const p = pm.get(seed.providerId);
          if (p?.capabilities.supportsArtists) remote = await p.searchSongs(artistName);
        } catch { /* provider optional */ }
        const merged = new Map<string, Song>();
        [...mine, ...remote].forEach((s) => merged.set(s.id, s));
        if (live) setSongs([...merged.values()].slice(0, 30));
      } finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [artistName, seed.providerId]);

  if (loading) return <Skeleton count={5} />;
  return (
    <div>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <div className="album-art lg" style={{ width: 120, height: 120, display: 'grid', placeItems: 'center', fontSize: 48, flexShrink: 0 }} aria-hidden><Glyph char="☺" size={48} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ margin: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{artistName}</h1>
          <p style={{ color: 'var(--text-2)' }}>{songs.length} songs</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" disabled={songs.length === 0} onClick={() => void playSongs(songs, 0)}><Glyph char="▶" size={13} /> Play</button>
            <button className="btn" disabled={songs.length === 0}
              onClick={() => void playSongs([...songs].sort(() => Math.random() - 0.5), 0)}><Glyph char="⇄" size={13} /> Shuffle</button>
          </div>
        </div>
      </div>
      <h3>Popular Songs</h3>
      <div className="card" style={{ padding: 8 }}>
        {songs.map((s, i) => <SongRow key={s.id} song={s} index={i} onOpenAlbum={onOpenAlbum} />)}
        {songs.length === 0 && <p style={{ color: 'var(--text-2)', padding: 12 }}>No songs found for this artist.</p>}
      </div>
    </div>
  );
}

export function AlbumScreen({
  seed,
  onOpenArtist,
  onBack,
  onOpenSearch,
}: {
  seed: Song;
  onOpenArtist: (s: Song) => void;
  onBack?: () => void;
  onOpenSearch?: () => void;
}) {
  const [tracks, setTracks] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const playSongs = usePlayer((s) => s.playSongs);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        let list: Song[] = [];
        try {
          const pm = getProviderManager();
          const p = pm.get(seed.providerId);
          if (p?.capabilities.supportsAlbums && seed.albumId) {
            const albumId = seed.albumId.split(':').slice(1).join(':');
            list = await p.getAlbumTracks(albumId);
          }
        } catch { /* fall back to local */ }
        if (list.length === 0) {
          const local = await songRepo.searchLocal(seed.album, 100);
          list = local.filter((s) => s.album === seed.album);
        }
        list.sort((a, b) => (a.trackNo ?? 0) - (b.trackNo ?? 0));
        if (live) setTracks(list);
      } finally { if (live) setLoading(false); }
    })();
    return () => { live = false; };
  }, [seed]);

  const art = seed.artworkLocal ?? seed.artworkUrl ?? (tracks[0] ? artworkFor(tracks[0]) : undefined);
  if (loading) return <Skeleton count={6} />;

  return (
    <div className="knox-album-page">
      {/* Top Nav: Back left, Search right (Image 1) */}
      <div className="knox-album-topbar">
        {onBack ? (
          <button className="knox-icon-btn" onClick={onBack} aria-label="Go back">
            <Icon name="prev" size={18} />
          </button>
        ) : <div style={{ width: 38 }} />}
        {onOpenSearch && (
          <button className="knox-icon-btn" onClick={onOpenSearch} aria-label="Search">
            <Icon name="search" size={18} />
          </button>
        )}
      </div>

      {/* Album Info Row (Image 1) */}
      <div className="knox-album-header">
        <div className="knox-album-art-wrap">
          {art ? (
            <img src={art} alt="" className="knox-album-cover" />
          ) : (
            <div className="knox-album-cover knox-album-cover-placeholder">♪</div>
          )}
        </div>
        <div className="knox-album-meta">
          <div className="knox-album-tag">
            Album • {tracks.length} songs {seed.year ? `• ${seed.year}` : ''}
          </div>
          <h1 className="knox-album-title">{seed.album}</h1>
          <button
            type="button"
            className="knox-album-artist-link"
            onClick={() => onOpenArtist(seed)}
          >
            {seed.artist}
          </button>

          {/* Quick Action Pill Icons (Image 1) */}
          <div className="knox-album-quick-pills">
            <span className="knox-mini-pill" title="Album" aria-label="Album"><Icon name="musicNote" size={14} /></span>
            <button
              type="button"
              className="knox-mini-pill interactive"
              title="Save album offline"
              aria-label="Download album"
              disabled={tracks.length === 0}
              onClick={() => {
                useDownloads.getState().enqueueMany(tracks).then(() => toast('↓ Saving album offline'));
              }}
            >
              <Icon name="download" size={14} />
            </button>
            <span className="knox-mini-pill" title="More options" aria-label="More options">···</span>
          </div>
        </div>
      </div>

      {/* Main Action Buttons (Image 1): Black Play Pill + Light Shuffle Pill */}
      <div className="knox-album-actions">
        <button
          type="button"
          className="knox-btn-pill-play"
          disabled={tracks.length === 0}
          onClick={() => void playSongs(tracks, 0)}
        >
          <Icon name="play" size={16} /> Play
        </button>
        <button
          type="button"
          className="knox-btn-pill-shuffle"
          disabled={tracks.length === 0}
          onClick={() => void playSongs([...tracks].sort(() => Math.random() - 0.5), 0)}
        >
          <Icon name="shuffle" size={16} /> Shuffle
        </button>
      </div>

      {/* Tracklist (Image 1) */}
      <div className="knox-tracklist">
        {tracks.map((s, i) => (
          <SongRow key={s.id} song={s} index={i} onOpenArtist={onOpenArtist} />
        ))}
        {tracks.length === 0 && (
          <p style={{ color: 'var(--text-2)', padding: 16 }}>No tracks found for this album.</p>
        )}
      </div>

      {tracks.length > 0 && (
        <div style={{ marginTop: 24 }}>
          <h3 style={{ marginBottom: 12 }}>More like this</h3>
          <div className="grid-cards">
            {tracks.slice(0, 4).map((s) => (
              <AlbumCard
                key={s.id}
                title={s.title}
                sub={s.artist}
                art={s.artworkLocal ?? s.artworkUrl}
                onClick={() => void playSongs([s], 0)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
