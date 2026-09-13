import React, { useEffect, useState } from 'react';
import type { Song } from '../core/types';
import { favoriteRepo } from '../data/repositories';
import { usePlayer } from '../audio/playerStore';
import { useDownloads } from '../downloads/DownloadManager';
import { SongRow } from '../ui/SongRow';
import { EmptyState, SectionTitle, Skeleton } from '../ui/primitives';
import { toast } from '../ui/toast';

export function FavoritesScreen({ onOpenAlbum, onOpenArtist }: {
  onOpenAlbum: (s: Song) => void; onOpenArtist: (s: Song) => void;
}) {
  const [songs, setSongs] = useState<Song[]>([]);
  const [loading, setLoading] = useState(true);
  const playSongs = usePlayer((s) => s.playSongs);

  useEffect(() => {
    let live = true;
    favoriteRepo.listSongs().then((l) => { if (live) { setSongs(l); setLoading(false); } }).catch(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, []);

  if (loading) return <Skeleton count={5} />;
  if (songs.length === 0) return <EmptyState icon="♥" title="No favorites yet" body="Tap the heart on any song to keep it here." />;

  return (
    <div>
      <SectionTitle title="Favorites" sub={`${songs.length} songs`}
        right={
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn btn-primary" onClick={() => void playSongs(songs, 0)}>▶ Play all</button>
            <button className="btn" onClick={() => {
              const shuffled = [...songs].sort(() => Math.random() - 0.5);
              void playSongs(shuffled, 0);
            }}>⇄ Shuffle</button>
            <button className="btn" onClick={() => {
              useDownloads.getState().enqueueMany(songs).then(() => toast('↓ Saving favorites offline'));
            }}>↓ Save offline</button>
          </div>
        } />
      <div className="card" style={{ padding: 8 }}>
        {songs.map((s) => <SongRow key={s.id} song={s} onOpenAlbum={onOpenAlbum} onOpenArtist={onOpenArtist} />)}
      </div>
    </div>
  );
}
