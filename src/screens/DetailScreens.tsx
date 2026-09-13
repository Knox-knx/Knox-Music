import React, { useEffect, useState } from 'react';
import type { Song } from '../core/types';
import { getProviderManager } from '../providers/ProviderManager';
import { songRepo } from '../data/repositories';
import { usePlayer } from '../audio/playerStore';
import { useDownloads } from '../downloads/DownloadManager';
import { SongRow, artworkFor } from '../ui/SongRow';
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
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginBottom: 16 }}>
        <div className="album-art lg" style={{ width: 120, height: 120, display: 'grid', placeItems: 'center', fontSize: 48 }} aria-hidden>☺</div>
        <div>
          <h1 style={{ margin: 0 }}>{artistName}</h1>
          <p style={{ color: 'var(--text-2)' }}>{songs.length} songs</p>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" disabled={songs.length === 0} onClick={() => void playSongs(songs, 0)}>▶ Play</button>
            <button className="btn" disabled={songs.length === 0}
              onClick={() => void playSongs([...songs].sort(() => Math.random() - 0.5), 0)}>⇄ Shuffle</button>
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

export function AlbumScreen({ seed, onOpenArtist }: { seed: Song; onOpenArtist: (s: Song) => void }) {
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
    <div>
      <div style={{ display: 'flex', gap: 18, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        {art ? <img src={art} alt="" style={{ width: 160, height: 160, borderRadius: 22, objectFit: 'cover' }} />
          : <div className="album-art lg" style={{ width: 160, height: 160, display: 'grid', placeItems: 'center', fontSize: 56 }} aria-hidden>⊙</div>}
        <div>
          <h1 style={{ margin: 0 }}>{seed.album}</h1>
          <p style={{ color: 'var(--text-2)' }}>{seed.artist} {seed.year ? `· ${seed.year}` : ''} · {tracks.length} songs</p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" disabled={tracks.length === 0} onClick={() => void playSongs(tracks, 0)}>▶ Play</button>
            <button className="btn" disabled={tracks.length === 0}
              onClick={() => void playSongs([...tracks].sort(() => Math.random() - 0.5), 0)}>⇄ Shuffle</button>
            <button className="btn" disabled={tracks.length === 0}
              onClick={() => { useDownloads.getState().enqueueMany(tracks).then(() => toast('↓ Saving album offline')); }}>↓ Offline</button>
          </div>
        </div>
      </div>
      <h3>Tracklist</h3>
      <div className="card" style={{ padding: 8 }}>
        {tracks.map((s, i) => <SongRow key={s.id} song={s} index={i} onOpenArtist={onOpenArtist} />)}
        {tracks.length === 0 && <p style={{ color: 'var(--text-2)', padding: 12 }}>No tracks found for this album.</p>}
      </div>
      {tracks.length > 0 && (
        <>
          <h3 style={{ marginTop: 18 }}>More like this</h3>
          <div className="grid-cards">
            {tracks.slice(0, 4).map((s) => <AlbumCard key={s.id} title={s.title} sub={s.artist} art={s.artworkLocal ?? s.artworkUrl} onClick={() => void playSongs([s], 0)} />)}
          </div>
        </>
      )}
    </div>
  );
}
