import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Playlist, Song } from '../core/types';
import { favoriteRepo, offlineRepo, PAGE_SIZE, playlistRepo, songRepo } from '../data/repositories';
import { useScanner } from '../library/scanner';
import { findDuplicates } from '../library/metadata';
import { SongRow, artworkFor } from '../ui/SongRow';
import { Glyph, Icon } from '../ui/icons';
import { KnoxTopBar } from '../ui/editorial';
import { Skeleton, EmptyState, ErrorState, KnoxSelect } from '../ui/primitives';
import { usePlayer } from '../audio/playerStore';
import { toast } from '../ui/toast';

type LibTab = 'downloads' | 'favorites' | 'playlists';
type Sort = 'recent' | 'title' | 'artist' | 'played';

const SORT_OPTIONS: { value: Sort; label: string }[] = [
  { value: 'recent', label: 'Recently Added' },
  { value: 'played', label: 'Recently Played' },
  { value: 'title', label: 'Title' },
  { value: 'artist', label: 'Artist' },
];

export function LibraryScreen({ onOpenAlbum, onOpenArtist, onOpenMenu, onOpenSettings }: {
  onOpenAlbum: (s: Song) => void; onOpenArtist: (s: Song) => void;
  onOpenMenu?: () => void; onOpenSettings?: () => void;
}) {
  const [tab, setTab] = useState<LibTab>('downloads');
  const [sort, setSort] = useState<Sort>('recent');
  const [songs, setSongs] = useState<Song[]>([]);
  const [favorites, setFavorites] = useState<Song[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(null);
  const [showAddSongsPicker, setShowAddSongsPicker] = useState(false);
  const [pickerFilter, setPickerFilter] = useState('');
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [editingPlaylistId, setEditingPlaylistId] = useState<string | null>(null);
  const [editingPlaylistName, setEditingPlaylistName] = useState('');

  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [duplicates, setDuplicates] = useState<{ key: string; songs: Song[]; reason: string }[]>([]);
  const [dupScanned, setDupScanned] = useState(false);
  const [deletingDups, setDeletingDups] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const scanning = useScanner((s) => s.scanning);
  const progress = useScanner((s) => s.progress);
  const scanFiles = useScanner((s) => s.scanFiles);
  const scanDevice = useScanner((s) => s.scanDevice);
  const repairZeroDurations = useScanner((s) => s.repairZeroDurations);
  const cancelScan = useScanner((s) => s.cancel);
  const playSongs = usePlayer((s) => s.playSongs);
  const setShuffle = usePlayer((s) => s.setShuffle);
  const pullStartY = useRef<number | null>(null);
  const hasLoadedRef = useRef(false);

  const load = useCallback(async (silent = false) => {
    if (!silent && !hasLoadedRef.current) setLoading(true);
    setError(null);
    try {
      const [list, offList, favList, plList] = await Promise.all([
        songRepo.list(0, PAGE_SIZE, sort).catch(() => [] as Song[]),
        offlineRepo.list().catch(() => []),
        favoriteRepo.listSongs().catch(() => [] as Song[]),
        playlistRepo.list().catch(() => [] as Playlist[]),
      ]);

      // Merge offline records with songRepo so every downloaded song appears in Downloads
      const byId = new Map<string, Song>();
      for (const s of list) {
        if (s.providerId === 'radio-browser') continue;
        byId.set(s.id, s);
      }
      for (const o of offList) {
        const existing = byId.get(o.id);
        if (existing) {
          byId.set(o.id, { ...existing, isOfflineAvailable: true });
        } else {
          byId.set(o.id, {
            id: o.id,
            title: o.title,
            artist: o.artist,
            album: o.album,
            durationMs: o.durationMs,
            artworkUrl: '',
            providerId: o.provider,
            providerTrackId: o.providerTrackId,
            isOfflineAvailable: true,
            addedAt: o.createdAt,
          });
        }
      }

      const mergedSongs = Array.from(byId.values());
      if (sort === 'title') mergedSongs.sort((a, b) => a.title.localeCompare(b.title));
      else if (sort === 'artist') mergedSongs.sort((a, b) => a.artist.localeCompare(b.artist));
      else if (sort === 'played') mergedSongs.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0));
      else mergedSongs.sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0));

      setSongs(mergedSongs);
      setTotal(mergedSongs.length);
      setFavorites(favList);
      setPlaylists(plList);
      hasLoadedRef.current = true;

      try {
        const fixed = await repairZeroDurations();
        if (fixed > 0) {
          const relist = await songRepo.list(0, PAGE_SIZE, sort);
          setSongs(relist.filter((s) => s.providerId !== 'radio-browser'));
          toast(`Fixed duration for ${fixed} track${fixed === 1 ? '' : 's'}`);
        }
      } catch { /* best-effort */ }
    } catch {
      setError('Unable to load your library.');
    } finally {
      setLoading(false);
    }
  }, [sort, repairZeroDurations]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const onRefresh = () => { void load(true); };
    window.addEventListener('knox:library-updated', onRefresh);
    window.addEventListener('knox:favorites-updated', onRefresh);
    window.addEventListener('knox:playlists-updated', onRefresh);
    return () => {
      window.removeEventListener('knox:library-updated', onRefresh);
      window.removeEventListener('knox:favorites-updated', onRefresh);
      window.removeEventListener('knox:playlists-updated', onRefresh);
    };
  }, [load]);

  const filteredDownloads = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return songs;
    return songs.filter((s) => `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(q));
  }, [songs, filter]);

  const songMap = useMemo(() => {
    const m = new Map<string, Song>();
    for (const s of songs) m.set(s.id, s);
    for (const s of favorites) m.set(s.id, s);
    return m;
  }, [songs, favorites]);

  const activePlaylist = useMemo(
    () => playlists.find((p) => p.id === activePlaylistId) ?? null,
    [playlists, activePlaylistId],
  );

  const activePlaylistSongs = useMemo(() => {
    if (!activePlaylist) return [];
    return activePlaylist.trackIds
      .map((id) => songMap.get(id))
      .filter((s): s is Song => Boolean(s));
  }, [activePlaylist, songMap]);

  const handleFiles = async (files: FileList | null, folder: string) => {
    if (!files || files.length === 0) return;
    const added = await scanFiles(files, folder);
    toast(`Added ${added.length} song${added.length === 1 ? '' : 's'}`);
    await load();
  };

  const handleScanDevice = async () => {
    try {
      const added = await scanDevice();
      if (added.length > 0) {
        toast(`Found ${added.length} song${added.length === 1 ? '' : 's'} on this device`);
        await load();
      } else {
        toast('Scan complete — no new music found');
        await load();
      }
    } catch (e) {
      const code = (e as Error & { code?: string })?.code;
      if (code === 'PICKER_UNSUPPORTED') {
        toast('Directory picking is not supported here — use Add files / Add folder', 'warn');
        folderRef.current?.click();
        return;
      }
      const name = (e as Error)?.name ?? '';
      if (name === 'AbortError') return;
      toast(e instanceof Error ? e.message : 'Device scan failed', 'error');
    }
  };

  const playFromList = useCallback((list: Song[], startIndex: number) => {
    if (list.length === 0) return;
    void (async () => {
      const ok = await playSongs(list, startIndex);
      if (!ok) {
        const err = usePlayer.getState().error;
        toast(err || 'Unable to play this track', 'error');
      }
    })();
  }, [playSongs]);

  const requestPlayIn = useCallback((list: Song[]) => {
    return (song: Song): Promise<boolean> => {
      const idx = list.findIndex((s) => s.id === song.id);
      playFromList(list, idx >= 0 ? idx : 0);
      return Promise.resolve(true);
    };
  }, [playFromList]);

  const getContainerScrollTop = (el: HTMLElement | null): number => {
    const mainEl = el?.closest('.main') as HTMLElement | null
      ?? document.getElementById('main-content');
    return Math.max(
      el?.scrollTop ?? 0,
      mainEl?.scrollTop ?? 0,
      window.scrollY ?? 0,
      document.documentElement?.scrollTop ?? 0,
    );
  };

  const onPullStart = (e: React.TouchEvent) => {
    const el = e.currentTarget as HTMLDivElement;
    if (getContainerScrollTop(el) <= 0 && e.touches.length === 1) {
      pullStartY.current = e.touches[0].clientY;
    } else {
      pullStartY.current = null;
    }
  };
  const onPullMove = (e: React.TouchEvent) => {
    if (pullStartY.current === null) return;
    const el = e.currentTarget as HTMLDivElement;
    const dy = (e.touches[0]?.clientY ?? pullStartY.current) - pullStartY.current;
    if (getContainerScrollTop(el) > 0 || dy < -4) {
      pullStartY.current = null;
    }
  };
  const onPullEnd = (e: React.TouchEvent) => {
    if (pullStartY.current === null) return;
    const el = e.currentTarget as HTMLDivElement;
    const dy = e.changedTouches[0].clientY - pullStartY.current;
    pullStartY.current = null;
    if (getContainerScrollTop(el) <= 0 && dy > 140 && !scanning) {
      void load(true);
    }
  };

  // Keep hidden inputs & Menu drawer listeners active
  useEffect(() => {
    const onAddFiles = () => fileRef.current?.click();
    const onAddFolder = () => folderRef.current?.click();
    const onScan = () => void handleScanDevice();
    window.addEventListener('knox:add-files', onAddFiles);
    window.addEventListener('knox:add-folder', onAddFolder);
    window.addEventListener('knox:scan-device', onScan);
    return () => {
      window.removeEventListener('knox:add-files', onAddFiles);
      window.removeEventListener('knox:add-folder', onAddFolder);
      window.removeEventListener('knox:scan-device', onScan);
    };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCreatePlaylist = async () => {
    const trimmed = newPlaylistName.trim();
    if (!trimmed) {
      toast('Enter a playlist name first', 'warn');
      return;
    }
    const created = await playlistRepo.create(trimmed);
    setNewPlaylistName('');
    await load(true);
    setActivePlaylistId(created.id);
    setShowAddSongsPicker(true);
    window.dispatchEvent(new CustomEvent('knox:playlists-updated'));
    toast(`Created playlist "${created.name}"`);
  };

  const handleRenamePlaylist = async (pl: Playlist) => {
    const trimmed = editingPlaylistName.trim();
    if (!trimmed) return;
    await playlistRepo.update({ ...pl, name: trimmed });
    setEditingPlaylistId(null);
    setEditingPlaylistName('');
    await load(true);
    window.dispatchEvent(new CustomEvent('knox:playlists-updated'));
    toast(`Renamed playlist to "${trimmed}"`);
  };

  const handleDeletePlaylist = async (pl: Playlist) => {
    await playlistRepo.remove(pl.id);
    if (activePlaylistId === pl.id) {
      setActivePlaylistId(null);
      setShowAddSongsPicker(false);
    }
    await load(true);
    window.dispatchEvent(new CustomEvent('knox:playlists-updated'));
    toast(`Deleted playlist "${pl.name}"`);
  };

  const handleToggleSongInPlaylist = async (pl: Playlist, song: Song) => {
    await songRepo.upsert({ ...song, addedAt: song.addedAt || Date.now() }).catch(() => undefined);
    const inPl = pl.trackIds.includes(song.id);
    if (inPl) {
      await playlistRepo.removeTrack(pl.id, song.id);
      toast(`Removed "${song.title}" from ${pl.name}`);
    } else {
      await playlistRepo.addTrack(pl.id, song.id);
      toast(`Added "${song.title}" to ${pl.name}`);
    }
    await load(true);
    window.dispatchEvent(new CustomEvent('knox:playlists-updated'));
  };

  return (
    <div onTouchStart={onPullStart} onTouchMove={onPullMove} onTouchEnd={onPullEnd}>
      <KnoxTopBar
        title="Your Library"
        caption={total > 0 ? `${total.toLocaleString()} songs · stored on this device` : 'Knox Music'}
        onOpenMenu={onOpenMenu ?? (() => window.dispatchEvent(new CustomEvent('knox:open-menu')))}
        onOpenSettings={onOpenSettings ?? (() => window.dispatchEvent(new CustomEvent('knox:open-settings')))}
      />

      {/* Hidden inputs for Menu drawer Add files / Add folder actions */}
      <input
        ref={fileRef}
        type="file"
        accept="audio/*,.mp3,.flac,.wav,.m4a,.aac,.ogg,.opus"
        multiple
        hidden
        onChange={(e) => void handleFiles(e.target.files, '')}
        aria-label="Add music files"
      />
      <input
        ref={folderRef}
        type="file"
        multiple
        hidden
        {...{ webkitdirectory: '' } as Record<string, string>}
        onChange={(e) => {
          const files = e.target.files;
          const first = files?.[0] as unknown as { webkitRelativePath?: string } | undefined;
          const folder = (first?.webkitRelativePath?.split('/')[0]) || 'folder';
          void handleFiles(files, folder);
        }}
        aria-label="Add music folder"
      />

      {scanning && (
        <div className="card" style={{ padding: 16, margin: '12px 20px 0' }} role="status">
          <strong>Scanning Music</strong>
          <p style={{ color: 'var(--text-2)' }}>{progress.done.toLocaleString()} / {progress.total.toLocaleString()} {progress.current && `· Current: ${progress.current}`}</p>
          <div className="progress"><div style={{ width: `${progress.total ? (progress.done / progress.total) * 100 : 0}%` }} /></div>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <button className="btn" onClick={cancelScan}>Cancel scan</button>
            <span style={{ color: 'var(--text-2)', fontSize: 12 }}>Running in background — the UI stays usable.</span>
          </div>
        </div>
      )}

      {/* Three primary Library buttons: Downloads, Favourites, Playlist */}
      <div style={{ padding: '10px 20px 4px' }}>
        <div className="chips" role="tablist" aria-label="Library sections" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8 }}>
          <button
            role="tab"
            aria-selected={tab === 'downloads'}
            className={`chip${tab === 'downloads' ? ' active' : ''}`}
            style={{ justifyContent: 'center', textAlign: 'center', padding: '10px 8px', fontWeight: 650 }}
            onClick={() => setTab('downloads')}
          >
            <Icon name="download" size={14} /> Downloads ({songs.length})
          </button>
          <button
            role="tab"
            aria-selected={tab === 'favorites'}
            className={`chip${tab === 'favorites' ? ' active' : ''}`}
            style={{ justifyContent: 'center', textAlign: 'center', padding: '10px 8px', fontWeight: 650 }}
            onClick={() => setTab('favorites')}
          >
            <Icon name="heart" size={14} /> Favourites ({favorites.length})
          </button>
          <button
            role="tab"
            aria-selected={tab === 'playlists'}
            className={`chip${tab === 'playlists' ? ' active' : ''}`}
            style={{ justifyContent: 'center', textAlign: 'center', padding: '10px 8px', fontWeight: 650 }}
            onClick={() => setTab('playlists')}
          >
            <Icon name="list" size={14} /> Playlist ({playlists.length})
          </button>
        </div>
      </div>

      {tab === 'downloads' && (
        <div style={{ padding: '4px 0 0' }}>
          <div className="search-input knox-lib-search" role="search">
            <span aria-hidden><Glyph char="⌕" size={15} /></span>
            <input
              placeholder="Search downloaded songs…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Search library"
            />
            {filter ? (
              <button className="icon-btn" style={{ width: 26, height: 26, fontSize: 12 }} onClick={() => setFilter('')} aria-label="Clear library search">
                <Glyph char="✕" size={12} />
              </button>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, padding: '0 20px', flexWrap: 'wrap' }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)' }}>
              <span>Sort</span>
              <KnoxSelect
                value={sort}
                options={SORT_OPTIONS}
                onChange={(val) => setSort(val as Sort)}
                ariaLabel="Sort library"
              />
            </div>
            {filteredDownloads.length > 0 && (
              <button className="btn btn-primary" style={{ padding: '6px 14px', fontSize: 12.5 }} onClick={() => playFromList(filteredDownloads, 0)}>
                ▶ Play all
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button className="ghost-icon-btn" style={{ width: 'auto', padding: '0 10px', fontSize: 12.5 }} onClick={() => void load()} aria-label="Refresh library">
              ↻ Refresh
            </button>
          </div>
        </div>
      )}

      {loading && <div style={{ padding: '14px 20px' }}><Skeleton count={5} /></div>}
      {error && <div style={{ padding: '14px 20px' }}><ErrorState message={error} onRetry={() => void load()} /></div>}

      {/* TAB 1: DOWNLOADS (+ DUPLICATES AT BOTTOM) */}
      {!loading && !error && tab === 'downloads' && (
        <div style={{ padding: '6px 0 24px' }}>
          {songs.length === 0 ? (
            <div style={{ padding: '0 20px' }}>
              <EmptyState
                icon="↓"
                title="No downloaded songs yet"
                body="Songs you play from YouTube or download for offline listening, plus music added from your Menu, will appear here."
              />
            </div>
          ) : filteredDownloads.length === 0 ? (
            <div style={{ padding: '0 20px' }}>
              <EmptyState
                icon="♪"
                title="No matches"
                body={`Nothing in your downloads matches “${filter}”.`}
                actions={<button className="btn" onClick={() => setFilter('')}>Clear search</button>}
              />
            </div>
          ) : (
            <div style={{ padding: '10px 20px 0' }}>
              <div className="results-glass" style={{ padding: 8 }} role="list" aria-label="Downloaded songs">
                {filteredDownloads.map((s) => (
                  <SongRow
                    key={s.id}
                    song={s}
                    onOpenAlbum={onOpenAlbum}
                    onOpenArtist={onOpenArtist}
                    onRequestPlay={requestPlayIn(filteredDownloads)}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Duplicates logic at the bottom of Downloads */}
          {songs.length > 0 && (
            <div style={{ padding: '0 20px' }}>
              <div className="card" style={{ padding: 16, marginTop: 18 }}>
                <h3 style={{ marginTop: 0, fontFamily: 'var(--font-display)' }}>Duplicates</h3>
                <p style={{ color: 'var(--text-2)', fontSize: 13 }}>
                  Detection uses title, artist, duration and file size. Deleting duplicates removes only the extra duplicate copies and keeps one original copy of each song.
                </p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <button
                    className="btn"
                    onClick={() => {
                      void (async () => {
                        try {
                          const { getDb } = await import('../data/db');
                          const allRows = await getDb().songs.toArray();
                          const sourceList = allRows.length >= songs.length ? allRows : songs;
                          const sizes = new Map<string, number>();
                          for (const r of allRows) {
                            if (typeof r.fileSize === 'number' && r.fileSize > 0) {
                              sizes.set(r.id, r.fileSize);
                            }
                          }
                          const found = findDuplicates(sourceList, sizes);
                          setDuplicates(found);
                          setDupScanned(true);
                          const dupCount = found.reduce((n, g) => n + Math.max(0, g.songs.length - 1), 0);
                          if (dupCount > 0) {
                            toast(`Found ${dupCount} duplicate song${dupCount === 1 ? '' : 's'} in ${found.length} group${found.length === 1 ? '' : 's'}`);
                          } else {
                            toast('No duplicate songs found');
                          }
                        } catch {
                          const found = findDuplicates(songs, new Map());
                          setDuplicates(found);
                          setDupScanned(true);
                        }
                      })();
                    }}
                  >
                    {dupScanned ? 'Rescan for duplicates' : 'Scan for duplicates'}
                  </button>

                  {duplicates.length > 0 && (
                    <button
                      className="btn btn-primary"
                      disabled={deletingDups}
                      onClick={() => {
                        void (async () => {
                          const toDelete: Song[] = [];
                          for (const g of duplicates) {
                            if (g.songs.length > 1) {
                              toDelete.push(...g.songs.slice(1));
                            }
                          }
                          if (toDelete.length === 0) return;
                          setDeletingDups(true);
                          try {
                            const { getDb } = await import('../data/db');
                            const db = getDb();
                            const ids = toDelete.map((s) => s.id);
                            await Promise.all(ids.map(async (id) => {
                              await songRepo.remove(id);
                              await offlineRepo.remove(id).catch(() => undefined);
                            }));
                            try {
                              await db.localFiles.bulkDelete(ids);
                            } catch { /* best-effort */ }
                            setDuplicates([]);
                            await load(true);
                            window.dispatchEvent(new CustomEvent('knox:library-updated'));
                            toast(`Deleted ${ids.length} duplicate song${ids.length === 1 ? '' : 's'} (original copies kept)`);
                          } catch {
                            toast('Could not delete some duplicates', 'error');
                          } finally {
                            setDeletingDups(false);
                          }
                        })();
                      }}
                    >
                      {deletingDups
                        ? 'Deleting duplicates…'
                        : `Delete all duplicates (${duplicates.reduce((n, g) => n + Math.max(0, g.songs.length - 1), 0)})`}
                    </button>
                  )}
                </div>

                {dupScanned && duplicates.length === 0 && (
                  <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-2)' }}>
                    ✓ No duplicate songs found in your downloads.
                  </div>
                )}

                {duplicates.map((d) => (
                  <div key={d.key} style={{ padding: '10px 0', marginTop: 8, borderTop: '1px solid var(--border)' }}>
                    <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginBottom: 6 }}>
                      Duplicate group — {d.reason}
                    </div>
                    {d.songs.map((s, idx) => (
                      <div
                        key={s.id}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          gap: 8,
                          padding: '4px 0',
                          fontSize: 13.5,
                        }}
                      >
                        <div style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          <Glyph char="♪" size={12} /> {s.localPath || `${s.title} — ${s.artist}`}
                          <span
                            style={{
                              marginLeft: 8,
                              fontSize: 11,
                              padding: '2px 7px',
                              borderRadius: 999,
                              background: idx === 0 ? 'rgba(52, 211, 153, 0.14)' : 'rgba(248, 113, 113, 0.14)',
                              color: idx === 0 ? 'var(--match-exact)' : 'var(--danger)',
                            }}
                          >
                            {idx === 0 ? 'Original (Kept)' : 'Duplicate'}
                          </span>
                        </div>
                        {idx > 0 && (
                          <button
                            type="button"
                            className="btn"
                            style={{ padding: '4px 10px', fontSize: 12 }}
                            onClick={() => {
                              void (async () => {
                                try {
                                  await songRepo.remove(s.id);
                                  await offlineRepo.remove(s.id).catch(() => undefined);
                                  try {
                                    const { getDb } = await import('../data/db');
                                    await getDb().localFiles.delete(s.id);
                                  } catch { /* best-effort */ }
                                  setDuplicates((prev) =>
                                    prev
                                      .map((grp) =>
                                        grp.key === d.key
                                          ? { ...grp, songs: grp.songs.filter((item) => item.id !== s.id) }
                                          : grp,
                                      )
                                      .filter((grp) => grp.songs.length > 1),
                                  );
                                  await load(true);
                                  window.dispatchEvent(new CustomEvent('knox:library-updated'));
                                  toast(`Deleted duplicate: ${s.title}`);
                                } catch {
                                  toast('Could not delete duplicate', 'error');
                                }
                              })();
                            }}
                          >
                            Delete duplicate
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB 2: FAVOURITES */}
      {!loading && !error && tab === 'favorites' && (
        <div style={{ padding: '10px 20px 24px' }}>
          {favorites.length === 0 ? (
            <EmptyState
              icon="♥"
              title="No favourite songs yet"
              body="Tap the heart icon in the music player or on any song row to save your favourite tracks here."
            />
          ) : (
            <>
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
                <button className="btn btn-primary" onClick={() => playFromList(favorites, 0)}>
                  ▶ Play all ({favorites.length})
                </button>
                <button
                  className="btn"
                  onClick={() => {
                    setShuffle(true);
                    playFromList(favorites, Math.floor(Math.random() * favorites.length));
                  }}
                >
                  <Icon name="shuffle" size={14} /> Shuffle
                </button>
              </div>
              <div className="results-glass" style={{ padding: 8 }} role="list" aria-label="Favourite songs">
                {favorites.map((s) => (
                  <SongRow
                    key={s.id}
                    song={s}
                    onOpenAlbum={onOpenAlbum}
                    onOpenArtist={onOpenArtist}
                    onRequestPlay={requestPlayIn(favorites)}
                  />
                ))}
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB 3: PLAYLIST */}
      {!loading && !error && tab === 'playlists' && (
        <div style={{ padding: '10px 20px 24px' }}>
          {!activePlaylist ? (
            <>
              {/* Create new playlist bar */}
              <div className="card" style={{ padding: 12, marginBottom: 14, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  className="text-input"
                  style={{ flex: 1, minWidth: 180 }}
                  placeholder="New playlist name…"
                  value={newPlaylistName}
                  onChange={(e) => setNewPlaylistName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleCreatePlaylist(); }}
                  aria-label="New playlist name"
                />
                <button className="btn btn-primary" onClick={() => void handleCreatePlaylist()}>
                  <Icon name="plus" size={14} /> Create playlist
                </button>
              </div>

              {playlists.length === 0 ? (
                <EmptyState
                  icon="☰"
                  title="No playlists yet"
                  body="Create a playlist above and add your favourite or downloaded songs to it."
                />
              ) : (
                <div style={{ display: 'grid', gap: 10 }}>
                  {playlists.map((pl) => {
                    const isEditing = editingPlaylistId === pl.id;
                    return (
                      <div
                        key={pl.id}
                        className="card"
                        style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}
                      >
                        {isEditing ? (
                          <div style={{ display: 'flex', gap: 8, flex: 1, minWidth: 200, alignItems: 'center' }}>
                            <input
                              className="text-input"
                              style={{ flex: 1 }}
                              value={editingPlaylistName}
                              onChange={(e) => setEditingPlaylistName(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter') void handleRenamePlaylist(pl); }}
                              aria-label="Rename playlist"
                              autoFocus
                            />
                            <button className="btn btn-primary" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => void handleRenamePlaylist(pl)}>
                              Save
                            </button>
                            <button className="btn" style={{ padding: '6px 12px', fontSize: 12 }} onClick={() => setEditingPlaylistId(null)}>
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => { setActivePlaylistId(pl.id); setShowAddSongsPicker(false); }}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 12,
                                flex: 1,
                                minWidth: 160,
                                background: 'none',
                                border: 0,
                                color: 'inherit',
                                textAlign: 'left',
                                cursor: 'pointer',
                                padding: 0,
                              }}
                            >
                              <span className="knox-icon-tile sm" aria-hidden><Glyph char="☰" size={16} /></span>
                              <div style={{ minWidth: 0 }}>
                                <div style={{ fontWeight: 700, fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {pl.name}
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                                  {pl.trackIds.length} song{pl.trackIds.length === 1 ? '' : 's'} · Tap to view & add songs
                                </div>
                              </div>
                            </button>
                            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                              <button
                                type="button"
                                className="btn btn-primary"
                                style={{ padding: '6px 12px', fontSize: 12 }}
                                onClick={() => {
                                  const tracks = pl.trackIds.map((id) => songMap.get(id)).filter((s): s is Song => Boolean(s));
                                  if (tracks.length === 0) {
                                    setActivePlaylistId(pl.id);
                                    setShowAddSongsPicker(true);
                                    toast('Playlist is empty — add songs from your downloads');
                                    return;
                                  }
                                  playFromList(tracks, 0);
                                }}
                              >
                                ▶ Play
                              </button>
                              <button
                                type="button"
                                className="btn"
                                style={{ padding: '6px 10px', fontSize: 12 }}
                                onClick={() => { setActivePlaylistId(pl.id); setShowAddSongsPicker(true); }}
                              >
                                + Add songs
                              </button>
                              <button
                                type="button"
                                className="btn"
                                style={{ padding: '6px 10px', fontSize: 12 }}
                                onClick={() => { setEditingPlaylistId(pl.id); setEditingPlaylistName(pl.name); }}
                                aria-label={`Rename ${pl.name}`}
                              >
                                ✎ Edit
                              </button>
                              <button
                                type="button"
                                className="btn"
                                style={{ padding: '6px 10px', fontSize: 12, color: 'var(--danger)' }}
                                onClick={() => void handleDeletePlaylist(pl)}
                                aria-label={`Delete ${pl.name}`}
                              >
                                ✕ Delete
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          ) : (
            /* Active Playlist Detail View + Add Songs from Downloads */
            <div style={{ display: 'grid', gap: 12 }}>
              <div className="card" style={{ padding: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn" style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => { setActivePlaylistId(null); setShowAddSongsPicker(false); }}>
                    ← All playlists
                  </button>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {activePlaylistSongs.length > 0 && (
                      <button className="btn btn-primary" style={{ padding: '6px 12px', fontSize: 12.5 }} onClick={() => playFromList(activePlaylistSongs, 0)}>
                        ▶ Play ({activePlaylistSongs.length})
                      </button>
                    )}
                    <button
                      className="btn"
                      style={{ padding: '6px 12px', fontSize: 12.5 }}
                      onClick={() => setShowAddSongsPicker((v) => !v)}
                    >
                      {showAddSongsPicker ? 'Done adding songs' : '+ Add from Downloads'}
                    </button>
                    <button
                      className="btn"
                      style={{ padding: '6px 10px', fontSize: 12.5 }}
                      onClick={() => {
                        setEditingPlaylistId(activePlaylist.id);
                        setEditingPlaylistName(activePlaylist.name);
                      }}
                    >
                      ✎ Rename
                    </button>
                    <button
                      className="btn"
                      style={{ padding: '6px 10px', fontSize: 12.5, color: 'var(--danger)' }}
                      onClick={() => void handleDeletePlaylist(activePlaylist)}
                    >
                      ✕ Delete
                    </button>
                  </div>
                </div>

                {editingPlaylistId === activePlaylist.id ? (
                  <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
                    <input
                      className="text-input"
                      style={{ flex: 1 }}
                      value={editingPlaylistName}
                      onChange={(e) => setEditingPlaylistName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void handleRenamePlaylist(activePlaylist); }}
                      autoFocus
                    />
                    <button className="btn btn-primary" onClick={() => void handleRenamePlaylist(activePlaylist)}>Save</button>
                    <button className="btn" onClick={() => setEditingPlaylistId(null)}>Cancel</button>
                  </div>
                ) : (
                  <div style={{ marginTop: 10 }}>
                    <h3 style={{ margin: 0, fontSize: 18 }}>{activePlaylist.name}</h3>
                    <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 2 }}>
                      {activePlaylistSongs.length} song{activePlaylistSongs.length === 1 ? '' : 's'} in this playlist
                    </div>
                  </div>
                )}
              </div>

              {/* Add songs from Downloads picker */}
              {(showAddSongsPicker || activePlaylistSongs.length === 0) && (
                <div className="card" style={{ padding: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                    <div>
                      <strong style={{ fontSize: 14.5 }}>Add songs from Downloads</strong>
                      <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Tap any downloaded song to add or remove it from “{activePlaylist.name}”</div>
                    </div>
                    {showAddSongsPicker && activePlaylistSongs.length > 0 && (
                      <button className="btn" style={{ padding: '4px 10px', fontSize: 12 }} onClick={() => setShowAddSongsPicker(false)}>
                        Close
                      </button>
                    )}
                  </div>
                  <input
                    className="text-input"
                    style={{ width: '100%', marginBottom: 10 }}
                    placeholder="Filter downloaded songs…"
                    value={pickerFilter}
                    onChange={(e) => setPickerFilter(e.target.value)}
                  />
                  {songs.length === 0 ? (
                    <div style={{ fontSize: 13, color: 'var(--text-2)', padding: '8px 0' }}>
                      No downloaded songs available yet. Play or download songs first to add them here.
                    </div>
                  ) : (
                    <div style={{ maxHeight: 280, overflowY: 'auto', display: 'grid', gap: 6 }}>
                      {songs
                        .filter((s) =>
                          !pickerFilter.trim() ||
                          `${s.title} ${s.artist} ${s.album}`.toLowerCase().includes(pickerFilter.trim().toLowerCase()),
                        )
                        .map((s) => {
                          const inPl = activePlaylist.trackIds.includes(s.id);
                          return (
                            <div
                              key={s.id}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 10,
                                padding: '6px 8px',
                                borderRadius: 10,
                                background: inPl ? 'rgba(52, 211, 153, 0.08)' : 'transparent',
                              }}
                            >
                              <img
                                src={artworkFor(s)}
                                alt=""
                                width={38}
                                height={38}
                                style={{ width: 38, height: 38, borderRadius: 8, objectFit: 'cover', flexShrink: 0 }}
                              />
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div style={{ fontWeight: 600, fontSize: 13.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {s.title}
                                </div>
                                <div style={{ fontSize: 12, color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                  {s.artist}
                                </div>
                              </div>
                              <button
                                type="button"
                                className={inPl ? 'btn' : 'btn btn-primary'}
                                style={{ padding: '5px 12px', fontSize: 12 }}
                                onClick={() => void handleToggleSongInPlaylist(activePlaylist, s)}
                              >
                                {inPl ? '✓ In playlist' : '+ Add'}
                              </button>
                            </div>
                          );
                        })}
                    </div>
                  )}
                </div>
              )}

              {/* Songs currently inside the playlist */}
              {activePlaylistSongs.length > 0 && (
                <div>
                  <h4 style={{ margin: '4px 0 8px', fontSize: 14, color: 'var(--text-2)' }}>Songs in {activePlaylist.name}</h4>
                  <div className="results-glass" style={{ padding: 8 }} role="list" aria-label={`Songs in ${activePlaylist.name}`}>
                    {activePlaylistSongs.map((s) => (
                      <div key={s.id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <SongRow
                            song={s}
                            onOpenAlbum={onOpenAlbum}
                            onOpenArtist={onOpenArtist}
                            onRequestPlay={requestPlayIn(activePlaylistSongs)}
                          />
                        </div>
                        <button
                          type="button"
                          className="icon-btn"
                          style={{ width: 30, height: 30, flexShrink: 0, color: 'var(--danger)' }}
                          title="Remove from playlist"
                          aria-label={`Remove ${s.title} from ${activePlaylist.name}`}
                          onClick={() => void handleToggleSongInPlaylist(activePlaylist, s)}
                        >
                          <Glyph char="✕" size={12} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
