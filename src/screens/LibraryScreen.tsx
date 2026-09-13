import React, { useEffect, useRef, useState } from 'react';
import type { Song } from '../core/types';
import { songRepo } from '../data/repositories';
import { PAGE_SIZE } from '../data/repositories';
import { useScanner } from '../library/scanner';
import { findDuplicates } from '../library/metadata';
import { SongRow } from '../ui/SongRow';
import { SectionTitle, Skeleton, EmptyState, ErrorState } from '../ui/primitives';
import { usePlayer } from '../audio/playerStore';
import { toast } from '../ui/toast';

type Tab = 'songs' | 'albums' | 'artists' | 'genres' | 'folders';
type Sort = 'recent' | 'title' | 'artist' | 'played';

export function LibraryScreen({ onOpenAlbum, onOpenArtist }: {
  onOpenAlbum: (s: Song) => void; onOpenArtist: (s: Song) => void;
}) {
  const [tab, setTab] = useState<Tab>('songs');
  const [sort, setSort] = useState<Sort>('recent');
  const [songs, setSongs] = useState<Song[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [duplicates, setDuplicates] = useState<{ key: string; songs: Song[]; reason: string }[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const scanning = useScanner((s) => s.scanning);
  const progress = useScanner((s) => s.progress);
  const scanFiles = useScanner((s) => s.scanFiles);
  const cancelScan = useScanner((s) => s.cancel);
  const playSongs = usePlayer((s) => s.playSongs);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const [list, count] = await Promise.all([songRepo.list(0, PAGE_SIZE, sort), songRepo.count()]);
      setSongs(list); setTotal(count);
    } catch { setError('Unable to load your library.'); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); }, [sort]); // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = filter.trim()
    ? songs.filter((s) => `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(filter.toLowerCase()))
    : songs;

  const grouped = tab === 'albums'
    ? groupBy(filtered, (s) => `${s.album} — ${s.artist}`)
    : tab === 'artists' ? groupBy(filtered, (s) => s.artist)
    : tab === 'genres' ? groupBy(filtered, (s) => s.genre || 'Unknown')
    : tab === 'folders' ? groupBy(filtered, (s) => (s.localPath?.split('/').slice(0, -1).join('/') || 'Catalog'))
    : null;

  const handleFiles = async (files: FileList | null, folder: string) => {
    if (!files || files.length === 0) return;
    const added = await scanFiles(files, folder);
    toast(`Added ${added.length} song${added.length === 1 ? '' : 's'}`);
    await load();
  };

  return (
    <div>
      <SectionTitle title="Your Library" sub={`${total.toLocaleString()} songs · stored on this device`}
        right={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => fileRef.current?.click()}>＋ Add files</button>
            <button className="btn" onClick={() => folderRef.current?.click()}>＋ Add folder</button>
            <input ref={fileRef} type="file" accept="audio/*,.mp3,.flac,.wav,.m4a,.aac,.ogg,.opus" multiple hidden
              onChange={(e) => void handleFiles(e.target.files, '')} aria-label="Add music files" />
            <input ref={folderRef} type="file" multiple hidden
              {...{ webkitdirectory: '' } as Record<string, string>}
              onChange={(e) => {
                const files = e.target.files;
                const first = files?.[0] as unknown as { webkitRelativePath?: string } | undefined;
                const folder = (first?.webkitRelativePath?.split('/')[0]) || 'folder';
                void handleFiles(files, folder);
              }} aria-label="Add music folder" />
          </div>
        } />

      {scanning && (
        <div className="card" style={{ padding: 16, marginBottom: 12 }} role="status">
          <strong>Scanning Music</strong>
          <p style={{ color: 'var(--text-2)' }}>{progress.done.toLocaleString()} / {progress.total.toLocaleString()} {progress.current && `· Current: ${progress.current}`}</p>
          <div className="progress"><div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn" onClick={cancelScan}>Cancel scan</button>
            <span style={{ color: 'var(--text-2)', fontSize: 12 }}>Running in background — the UI stays usable.</span>
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <div className="chips" role="tablist" aria-label="Library views">
          {(['songs', 'albums', 'artists', 'genres', 'folders'] as Tab[]).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={`chip${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <input className="text-input" style={{ maxWidth: 220 }} placeholder="Search library (Ctrl+F)" value={filter}
          onChange={(e) => setFilter(e.target.value)} aria-label="Search library" />
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort library">
          <option value="recent">Recently Added</option>
          <option value="played">Recently Played</option>
          <option value="title">Title</option>
          <option value="artist">Artist</option>
        </select>
      </div>

      {loading && <Skeleton count={6} />}
      {error && <ErrorState message={error} onRetry={() => void load()} />}
      {!loading && !error && total === 0 && (
        <EmptyState icon="♪" title="Your library is empty" body="Add a music folder or search for music to get started."
          actions={<><button className="btn btn-primary" onClick={() => fileRef.current?.click()}>Add Music</button></>} />
      )}

      {!loading && !error && total > 0 && tab === 'songs' && (
        <div className="card" style={{ padding: 8 }}>
          {filtered.map((s) => <SongRow key={s.id} song={s} onOpenAlbum={onOpenAlbum} onOpenArtist={onOpenArtist} />)}
          {total > filtered.length && <p style={{ color: 'var(--text-2)', padding: '8px 12px' }}>Showing {filtered.length} of {total.toLocaleString()} — refine search to narrow.</p>}
          {filtered.length > 1 && <div style={{ padding: 8 }}><button className="btn btn-primary" onClick={() => void playSongs(filtered, 0)}>▶ Play all</button></div>}
        </div>
      )}

      {!loading && !error && grouped && Object.entries(grouped).map(([name, list]) => (
        <div key={name} style={{ marginBottom: 18 }}>
          <h3 style={{ fontSize: 19, fontFamily: 'var(--font-display)', fontWeight: 600, letterSpacing: '-0.005em' }}>{name} <span style={{ color: 'var(--text-3)' }}>· {list.length}</span></h3>
          <div className="card" style={{ padding: 8 }}>
            {list.slice(0, 8).map((s) => <SongRow key={s.id} song={s} onOpenAlbum={onOpenAlbum} onOpenArtist={onOpenArtist} />)}
          </div>
        </div>
      ))}

      {!loading && !error && total > 0 && (
        <div className="card" style={{ padding: 16, marginTop: 16 }}>
          <h3 style={{ marginTop: 0 }}>Duplicates</h3>
          <p style={{ color: 'var(--text-2)', fontSize: 13 }}>Detection uses title, artist, duration and file size. Nothing is deleted automatically.</p>
          {duplicates.length === 0
            ? <button className="btn" onClick={() => setDuplicates(findDuplicates(songs, new Map()))}>Scan for duplicates</button>
            : duplicates.map((d) => (
              <div key={d.key} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                <div style={{ fontSize: 13, color: 'var(--text-2)' }}>Possible duplicates — {d.reason}</div>
                {d.songs.map((s) => <div key={s.id} style={{ fontSize: 13.5 }}>♪ {s.localPath || s.title}</div>)}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function groupBy(songs: Song[], key: (s: Song) => string): Record<string, Song[]> {
  const out: Record<string, Song[]> = {};
  for (const s of songs) {
    const k = key(s) || 'Unknown';
    (out[k] ||= []).push(s);
  }
  return out;
}
