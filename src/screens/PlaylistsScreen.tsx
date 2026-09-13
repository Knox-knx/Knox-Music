import React, { useEffect, useState } from 'react';
import type { Playlist, Song } from '../core/types';
import { playlistRepo, songRepo } from '../data/repositories';
import { usePlayer } from '../audio/playerStore';
import { useDownloads } from '../downloads/DownloadManager';
import { SongRow } from '../ui/SongRow';
import { AlbumCard } from '../ui/AlbumCard';
import { EmptyState, SectionTitle, ErrorState } from '../ui/primitives';
import { toast } from '../ui/toast';

export function PlaylistsScreen({ onOpen, refreshKey }: { onOpen: (id: string) => void; refreshKey: number }) {
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [name, setName] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const load = () => { playlistRepo.list().then(setPlaylists).catch(() => undefined); };
  useEffect(load, [refreshKey]);

  const create = async () => {
    if (!name.trim()) return;
    const pl = await playlistRepo.create(name);
    setName(''); setShowCreate(false); load();
    toast(`Created playlist ${pl.name}`);
    onOpen(pl.id);
  };

  if (playlists.length === 0 && !showCreate) {
    return (
      <EmptyState icon="✎" title="No playlists yet" body="Create your first playlist to organize your music."
        actions={<button className="btn btn-primary" onClick={() => setShowCreate(true)}>Create Playlist</button>} />
    );
  }

  return (
    <div>
      <SectionTitle title="Playlists" right={<button className="btn btn-primary" onClick={() => setShowCreate((v) => !v)}>＋ New</button>} />
      {showCreate && (
        <div className="card" style={{ padding: 16, marginBottom: 14 }}>
          <label className="lbl" htmlFor="pl-name">Playlist name</label>
          <input id="pl-name" className="text-input" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="My Workout" onKeyDown={(e) => { if (e.key === 'Enter') void create(); }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn btn-primary" onClick={() => void create()}>Create</button>
            <button className="btn" onClick={() => setShowCreate(false)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="grid-cards">
        {playlists.map((p) => (
          <AlbumCard key={p.id} title={p.name} sub={`${p.trackIds.length} songs`} art={p.coverUrl} onClick={() => onOpen(p.id)} />
        ))}
      </div>
    </div>
  );
}

export function PlaylistDetailScreen({ id, onBack, onOpenAlbum, onOpenArtist }: {
  id: string; onBack: () => void; onOpenAlbum: (s: Song) => void; onOpenArtist: (s: Song) => void;
}) {
  const [pl, setPl] = useState<Playlist | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [error, setError] = useState<string | null>(null);
  const playSongs = usePlayer((s) => s.playSongs);

  const load = async () => {
    setError(null);
    try {
      const p = await playlistRepo.get(id);
      if (!p) { setError('Playlist not found.'); return; }
      setPl(p);
      const list: Song[] = [];
      for (const tid of p.trackIds) {
        const s = await songRepo.get(tid).catch(() => undefined);
        if (s) list.push(s);
      }
      setSongs(list);
    } catch { setError('Unable to load playlist.'); }
  };
  useEffect(() => { void load(); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;
  if (!pl) return <p style={{ color: 'var(--text-2)' }}>Loading…</p>;

  return (
    <div>
      <button className="btn" onClick={onBack}>← Back</button>
      <h1 className="section-title">{pl.name}</h1>
      <p className="section-sub">{songs.length} songs {pl.description && `· ${pl.description}`}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <button className="btn btn-primary" disabled={songs.length === 0} onClick={() => void playSongs(songs, 0)}>▶ Play</button>
        <button className="btn" disabled={songs.length === 0}
          onClick={() => void playSongs([...songs].sort(() => Math.random() - 0.5), 0)}>⇄ Shuffle</button>
        <button className="btn" disabled={songs.length === 0}
          onClick={() => { useDownloads.getState().enqueueMany(songs).then(() => toast('↓ Saving playlist offline')); }}>
          ↓ Make available offline</button>
        <button className="btn" onClick={() => {
          const blob = new Blob([playlistRepo.exportJson(pl)], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `${pl.name}.knox-playlist.json`;
          a.click();
        }}>Export</button>
        <button className="btn" onClick={() => {
          const next = window.prompt('Rename playlist', pl.name);
          if (next) void playlistRepo.update({ ...pl, name: next }).then(() => void load());
        }}>Rename</button>
        <button className="btn" onClick={() => {
          if (window.confirm(`Delete “${pl.name}”?`)) void playlistRepo.remove(pl.id).then(onBack);
        }}>Delete</button>
      </div>
      <div className="card" style={{ padding: 8 }}>
        {songs.map((s, i) => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ flex: 1, minWidth: 0 }}><SongRow song={s} index={i} onOpenAlbum={onOpenAlbum} onOpenArtist={onOpenArtist} /></div>
            <button className="icon-btn" style={{ width: 30, height: 30 }} aria-label={`Remove ${s.title}`}
              onClick={() => void playlistRepo.removeTrack(pl.id, s.id).then(() => void load())}>✕</button>
          </div>
        ))}
        {songs.length === 0 && <p style={{ color: 'var(--text-2)', padding: 12 }}>This playlist is empty. Add songs from any song menu.</p>}
      </div>
    </div>
  );
}
