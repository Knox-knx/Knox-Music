import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Album, Artist, Playlist, Song } from '../core/types';
import { getProviderManager } from '../providers/ProviderManager';
import { providerLabel, sortSongs, type SongSort } from '../providers/merge';
import { runSearchPipeline } from '../search/searchEngine';
import { scopeSearchView, ONLINE_PROVIDER_IDS } from '../search/filtering';
import { enrichSongs, mergeEnrichedSongs, needsEnrichment, createEnrichmentCache } from '../search/enrichment';
import { songRepo } from '../data/repositories';
import { messageForProviderError } from '../core/errors';
import { SongRow } from '../ui/SongRow';
import { AlbumCard } from '../ui/AlbumCard';
import { Skeleton, ErrorState, EmptyState } from '../ui/primitives';
import { usePlayer } from '../audio/playerStore';
import { toast } from '../ui/toast';

type Tab = 'all' | 'songs' | 'artists' | 'albums' | 'playlists';
const TABS: { id: Tab; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'songs', label: 'Songs' }, { id: 'artists', label: 'Artists' },
  { id: 'albums', label: 'Albums' }, { id: 'playlists', label: 'Playlists' },
];

const HISTORY_KEY = 'knox.searchHistory';
const PROVIDER_FILTERS = ['all', 'jamendo', 'internet-archive', 'freetouse', 'airbeats', 'youtube-music'];

function loadHistory(): string[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]') as string[]; } catch { return []; }
}

export function SearchScreen({ query, setQuery, onOpenAlbum, onOpenArtist, onOpenPlayer }: {
  query: string; setQuery: (q: string) => void;
  onOpenAlbum: (s: Song) => void; onOpenArtist: (s: Song) => void;
  /** Open the dedicated Now Playing screen — called only after successful stream resolution. */
  onOpenPlayer?: () => void;
}) {
  const [tab, setTab] = useState<Tab>('all');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [artists, setArtists] = useState<Artist[]>([]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [failures, setFailures] = useState<string[]>([]);
  const [hasExact, setHasExact] = useState(false);
  const [hasStrong, setHasStrong] = useState(false);
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [sort, setSort] = useState<SongSort>('relevance');
  const [history, setHistory] = useState<string[]>(loadHistory);
  // Search → Now Playing resolution state. Navigation happens only on success;
  // failure stays on this screen with a visible error (never a blank player).
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [preparingTitle, setPreparingTitle] = useState<string>('');
  const [playError, setPlayError] = useState<string | null>(null);
  const offlineMode = usePlayer((s) => s.offlineMode);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Progressive enrichment (§5): detail cache survives across searches so an
  // already-enriched track is never fetched twice; the sequence guard drops
  // stale batches when the query changes mid-flight.
  const enrichCacheRef = useRef<Map<string, Song>>(createEnrichmentCache());
  const enrichSeqRef = useRef(0);

  const showSongs = tab === 'all' || tab === 'songs';
  const showArtists = tab === 'all' || tab === 'artists';
  const showAlbums = tab === 'all' || tab === 'albums';
  const showPlaylists = tab === 'all' || tab === 'playlists';

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    const q = query.trim();
    if (!q) { setSongs([]); setArtists([]); setAlbums([]); setPlaylists([]); setLoading(false); setError(null); setFailures([]); setHasExact(false); setHasStrong(false); return; }
    setLoading(true);
    setError(null);
    // Debounced search (250ms) — feels instant without hammering providers.
    timerRef.current = setTimeout(() => {
      void (async () => {
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          if (offlineMode) {
            const local = await songRepo.searchLocal(q, 50);
            if (controller.signal.aborted) return;
            const outcome = runSearchPipeline(local, q);
            setSongs(outcome.songs); setHasExact(outcome.hasExactMatch); setHasStrong(outcome.hasStrongMatch);
            setArtists([]); setAlbums([]); setPlaylists([]); setFailures([]);
          } else {
            const pm = getProviderManager();
            const [rs, ra, rl, rp] = await Promise.all([
              showSongs ? pm.searchAll(q, 'songs', controller.signal) : Promise.resolve({ items: [], failures: [] }),
              showArtists ? pm.searchAll(q, 'artists', controller.signal) : Promise.resolve({ items: [], failures: [] }),
              showAlbums ? pm.searchAll(q, 'albums', controller.signal) : Promise.resolve({ items: [], failures: [] }),
              showPlaylists ? pm.searchAll(q, 'playlists', controller.signal) : Promise.resolve({ items: [], failures: [] }),
            ]);
            if (controller.signal.aborted) return;
            // Rank through the dedicated search engine (parse → dedupe →
            // relevance score + matchType). ProviderManager already isolated
            // failures via allSettled — one failure never breaks the search.
            const outcome = runSearchPipeline(rs.items as Song[], q);
            setSongs(outcome.songs);
            setHasExact(outcome.hasExactMatch);
            setHasStrong(outcome.hasStrongMatch);
            setArtists(ra.items as Artist[]);
            setAlbums(rl.items as Album[]);
            setPlaylists(rp.items as Playlist[]);
            const failed = [...new Set([...rs.failures, ...ra.failures, ...rl.failures, ...rp.failures])];
            setFailures(failed);
          }
          // Normal search is provider-only: no Web Discovery, no page
          // scraping, no web references (stable restoration).
          setHistory((h) => {
            const next = [q, ...h.filter((x) => x !== q)].slice(0, 10);
            try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* private mode */ }
            return next;
          });
        } catch (e) {
          if ((e as Error).name !== 'AbortError') setError(messageForProviderError(e));
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      })();
    }, 250);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      // Abort in-flight provider fetches when the query/tab changes or the
      // screen unmounts, so stale responses can never overwrite fresh ones.
      abortRef.current?.abort();
    };
  }, [query, tab, offlineMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // Progressive metadata enrichment: fast search rows (e.g. YouTube Music
  // discovery with durationMs 0) render immediately; details merge in place.
  // No flicker (order preserved), no duplicates (merge by id), cached,
  // cancelled when the search changes, and never blocking initial render.
  useEffect(() => {
    if (offlineMode || loading || songs.length === 0) return;
    if (!songs.some(needsEnrichment)) return;
    const seq = ++enrichSeqRef.current;
    const controller = new AbortController();
    const snapshot = songs;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const provider = getProviderManager().get('youtube-music');
          if (!provider) return;
          const merged = await enrichSongs(snapshot, {
            fetchDetail: (s) => {
              if (controller.signal.aborted) return Promise.resolve(null);
              return provider.getSong(s.providerTrackId).catch(() => null);
            },
            cache: enrichCacheRef.current,
            signal: controller.signal,
            maxDetails: 8,
          });
          if (controller.signal.aborted || enrichSeqRef.current !== seq) return;
          setSongs((prev) => mergeEnrichedSongs(prev, merged));
        } catch {
          /* graceful: keep the fast rows as-is */
        }
      })();
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [songs, offlineMode, loading]);

  // Scoped view (pure helper, unit-tested): the selected provider id is
  // compared against result.providerId only; unrelated failures never hide
  // valid results or trigger a false "all sources down" state.
  // `enabledCount` includes always-available local/demo providers that never
  // fail, so `scopeSearchView` compares failures against the *online*
  // providers that were actually queried.
  let enabledIds: string[] = [];
  try {
    enabledIds = getProviderManager().list().filter((p) => p.enabled).map((p) => p.id);
  } catch {
    enabledIds = ['jamendo', 'internet-archive', 'freetouse', 'airbeats', 'youtube-music'];
  }
  const {
    visibleSongs, visibleArtists, visibleAlbums, visiblePlaylists,
    scopedFailures, onlineFailures, visibleEmpty, allFailed,
  } = scopeSearchView({
    songs, artists, albums, playlists, failures, providerFilter, enabledIds, loading, error, query,
  });
  // Engine-ranked order already carries relevanceScore/matchType; only
  // re-sort for the explicit non-relevance modes.
  const orderedSongs = sort === 'relevance' ? visibleSongs : sortSongs(visibleSongs, sort, query);
  const onlineDisabled = (() => {
    try {
      const list = getProviderManager().list();
      return !offlineMode && ONLINE_PROVIDER_IDS.every((id) => list.find((p) => p.id === id)?.enabled === false);
    } catch { return false; }
  })();

  const retry = () => { const q = query; setQuery(''); setTimeout(() => setQuery(q), 30); };

  /**
   * Search result → Now Playing flow (spec §1–§2):
   * resolve provider → verify supportsStreaming → fresh getStream() via the
   * store → load singleton AudioEngine → start playback → open Now Playing.
   * Navigation happens ONLY on success. Discovery-only (YouTube Music) shows
   * a graceful message and stays here. Failures show "Unable to play this
   * track" with provider info — never a blank/black player.
   */
  const handleRequestPlay = useCallback(async (song: Song): Promise<boolean> => {
    if (preparingId) return false;
    setPlayError(null);
    // Capability safety: web references stop BEFORE getStream/AudioEngine.
    // Never invent an audio URL — reject with a clear message. Checks both
    // provider-level (YouTube Music discovery-only, unregistered web-* ids)
    // and per-track (AirBeats record without an authorized audio tier).
    try {
      const provider = getProviderManager().get(song.providerId);
      const isWebId = song.providerId.startsWith('web-');
      const providerDiscoveryOnly = provider
        ? provider.capabilities.supportsStreaming === false
        : song.capabilities?.streamable === false;
      const trackNotStreamable =
        song.capabilities?.streamable === false && !song.streamUrl && !song.isLocalFile && !song.isOfflineAvailable;
      const discoveryOnly = isWebId || providerDiscoveryOnly || trackNotStreamable;
      const hasLocalCopy = Boolean(
        song.isLocalFile || (song.streamUrl && song.streamUrl.startsWith('blob:')),
      );
      if (discoveryOnly && !hasLocalCopy) {
        const label = provider?.name ?? song.providerId;
        const msg =
          song.providerId === 'airbeats' && trackNotStreamable
            ? 'AirBeats provided a web page rather than a playable audio source.'
            : isWebId || trackNotStreamable
              ? 'This result is a web reference and does not provide authorized playback in KNOX Music.'
              : `This ${label} result is discovery-only — playback isn\u2019t available from this source.`;
        setPlayError(msg);
        toast(msg, 'warn');
        return false;
      }
    } catch {
      /* fall through to the store, which fails honestly */
    }
    setPreparingId(song.id);
    setPreparingTitle(`${song.title} — ${song.artist}`);
    try {
      const ok = await usePlayer.getState().playSong(song);
      if (ok) {
        setPreparingId(null);
        setPlayError(null);
        onOpenPlayer?.();
        return true;
      }
      const err = usePlayer.getState().error || 'Unable to play this track';
      setPlayError(err);
      toast(err, 'error');
      setPreparingId(null);
      return false;
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'Playback failed';
      let label = song.providerId;
      try { label = getProviderManager().get(song.providerId)?.name ?? song.providerId; } catch { /* keep id */ }
      const msg = `Unable to play this track (${label}: ${raw})`;
      setPlayError(msg);
      toast(msg, 'error');
      setPreparingId(null);
      return false;
    }
  }, [preparingId, onOpenPlayer]);

  const handlePlayAll = useCallback(async (list: Song[]) => {
    if (list.length === 0 || preparingId) return;
    // Play-all resolves the first track through the same safe flow; the rest
    // of the list becomes the queue on success.
    const first = list[0];
    setPlayError(null);
    try {
      const provider = getProviderManager().get(first.providerId);
      if (provider && provider.capabilities.supportsStreaming === false) {
        const msg = `This ${provider.name} result is discovery-only — playback isn\u2019t available from this source.`;
        setPlayError(msg);
        toast(msg, 'warn');
        return;
      }
    } catch { /* store handles honestly */ }
    setPreparingId(first.id);
    setPreparingTitle(`${first.title} — ${first.artist}`);
    try {
      const ok = await usePlayer.getState().playSongs(list, 0);
      if (ok) {
        setPreparingId(null);
        setPlayError(null);
        onOpenPlayer?.();
      } else {
        const err = usePlayer.getState().error || 'Unable to play this track';
        setPlayError(err);
        toast(err, 'error');
        setPreparingId(null);
      }
    } catch (e) {
      const msg = `Unable to play this track (${e instanceof Error ? e.message : 'Playback failed'})`;
      setPlayError(msg);
      toast(msg, 'error');
      setPreparingId(null);
    }
  }, [preparingId, onOpenPlayer]);

  return (
    <div>
      {/* Spec §9: the search input lives ONLY on this tab — no other screen
          renders a song search input at any scroll position. */}
      <div className="search-input" role="search" style={{ margin: '6px 0 10px' }}>
        <span aria-hidden>⌕</span>
        <input
          value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder={offlineMode ? '⊘ Search your downloaded music' : 'Search songs, artists, albums...'}
          aria-label="Search songs, artists, albums"
        />
        {query
          ? <button className="icon-btn" style={{ width: 26, height: 26, fontSize: 12 }} onClick={() => setQuery('')} aria-label="Clear search">✕</button>
          : <span className="kbd-hint" aria-hidden>Ctrl K</span>}
      </div>
      <div className="chips" role="tablist" aria-label="Search categories" style={{ margin: '6px 0 10px' }}>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`chip${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      {query.trim() && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
          <div className="chips" aria-label="Provider filter">
            {PROVIDER_FILTERS.map((p) => (
              <button
                key={p}
                className={`chip${providerFilter === p ? ' active' : ''}`}
                aria-pressed={providerFilter === p}
                onClick={() => setProviderFilter(p)}
              >{p === 'all' ? 'All sources' : providerLabel(p)}</button>
            ))}
          </div>
          <label style={{ fontSize: 12, color: 'var(--text-2)' }}>
            Sort{' '}
            <select value={sort} onChange={(e) => setSort(e.target.value as SongSort)} aria-label="Sort results">
              <option value="relevance">Relevance</option>
              <option value="title">Title</option>
              <option value="artist">Artist</option>
              <option value="duration">Duration</option>
              <option value="provider">Provider</option>
            </select>
          </label>
          {scopedFailures.length > 0 && !allFailed && (
            <PartialResultsNotice failures={scopedFailures} />
          )}
        </div>
      )}
      {query.trim() && !offlineMode && onlineDisabled && !loading && (
        <div className="card" style={{ padding: 12, marginBottom: 12, borderColor: 'var(--warning)' }}>
          <div style={{ fontSize: 13 }}>Online sources are disabled — only your local library and demo tracks are searched.</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>Enable Jamendo / Internet Archive / FreeToUse / AirBeats / YouTube Music in Settings → Providers to search online music.</div>
        </div>
      )}
      {/* Preparing / error states for Search → Now Playing (§1). */}
      {preparingId && (
        <div className="card" role="status" aria-live="polite" style={{ padding: '10px 14px', marginBottom: 12, borderColor: 'var(--accent)' }}>
          <div style={{ fontSize: 13, fontWeight: 650 }}>Preparing track…</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{preparingTitle || 'Resolving a fresh stream URL…'}</div>
        </div>
      )}
      {playError && !preparingId && (
        <div className="card" role="alert" style={{ padding: '10px 14px', marginBottom: 12, borderColor: 'var(--danger)' }}>
          <div style={{ fontSize: 13, fontWeight: 650 }}>Unable to play this track</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{playError}</div>
          <button className="btn" style={{ marginTop: 8, padding: '4px 12px', fontSize: 12 }} onClick={() => setPlayError(null)}>Dismiss</button>
        </div>
      )}
      {!loading && !error && !visibleEmpty && !allFailed && query.trim() && !hasExact && !hasStrong && songs.length > 0 && (
        <div className="card" role="status" style={{ padding: '10px 14px', marginBottom: 12, borderColor: 'var(--border)' }}>
          <div style={{ fontSize: 13, fontWeight: 650 }}>No exact match found</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Showing related results from available sources. Try another spelling, artist + song, or another provider.</div>
        </div>
      )}

      {!query.trim() && (
        <div>
          {history.length > 0 && (
            <>
              <h3 style={{ fontSize: 14, color: 'var(--text-2)' }}>Recent searches</h3>
              <div className="chips">
                {history.map((h) => <button key={h} className="chip" onClick={() => setQuery(h)}>{h}</button>)}
                <button className="chip" onClick={() => { setHistory([]); localStorage.removeItem(HISTORY_KEY); }}>Clear</button>
              </div>
            </>
          )}
          <EmptyState icon="⌕" title={offlineMode ? 'Search your downloaded music' : 'Search KNOX Music'}
            body={offlineMode ? 'Offline mode: only locally available music is searched.' : 'Find songs, artists, albums and playlists from your enabled providers.'} />
        </div>
      )}

      {loading && <div style={{ display: 'grid', gap: 10 }} aria-label="Loading results"><Skeleton count={5} /></div>}
      {error && <ErrorState message={error} onRetry={retry} />}
      {allFailed && (
        <EmptyState
          icon="⚠︎"
          title={providerFilter === 'all'
            ? 'No music sources are currently available.'
            : `${providerLabel(providerFilter)} is currently unavailable.`}
          body={onlineFailures.length > 0
            ? `(${onlineFailures.map(providerLabel).join(', ')} failed — check your connection, then retry.${scopedFailures.includes('freetouse') ? ' FreeToUse needs the dev proxy: VITE_FREETOUSE_API_BASE_URL=/api/freetouse.' : ''})`
            : 'Check your internet connection and try again.'}
          actions={(
            <span style={{ display: 'inline-flex', gap: 8 }}>
              {providerFilter !== 'all' && (
                <button className="btn" onClick={() => setProviderFilter('all')}>Show all sources</button>
              )}
              <button className="btn" onClick={retry}>Retry</button>
            </span>
          )}
        />
      )}
      {visibleEmpty && !allFailed && (
        <EmptyState
          icon="♪"
          title="No results found"
          body={providerFilter === 'all'
            ? `Nothing found for “${query}”.`
            : `Nothing found for “${query}” from ${providerLabel(providerFilter)}.`}
          actions={(
            <span style={{ display: 'inline-flex', gap: 8 }}>
              {providerFilter !== 'all' && (
                <button className="btn" onClick={() => setProviderFilter('all')}>Show all sources</button>
              )}
              <button className="btn" onClick={() => setQuery('')}>Clear search</button>
            </span>
          )}
        />
      )}

      {!loading && !error && showSongs && orderedSongs.length > 0 && (
        <>
          <h3 className="section-title">Songs</h3>
          <div className="results-glass" style={{ padding: 8 }}>
            {(tab === 'all' ? orderedSongs.slice(0, 6) : orderedSongs).map((s) => (
              <SongRow
                key={s.id}
                song={s}
                onOpenAlbum={onOpenAlbum}
                onOpenArtist={onOpenArtist}
                onRequestPlay={handleRequestPlay}
                preparing={preparingId === s.id}
              />
            ))}
          </div>
          {tab === 'all' && orderedSongs.length > 6 && <button className="btn" style={{ marginTop: 8 }} onClick={() => setTab('songs')}>Show all {orderedSongs.length} songs</button>}
          {tab === 'songs' && orderedSongs.length > 1 && <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => void handlePlayAll(orderedSongs)}>▶ Play all</button>}
        </>
      )}
      {!loading && !error && showArtists && visibleArtists.length > 0 && (
        <>
          <h3 className="section-title">Artists</h3>
          <div className="grid-cards">
            {visibleArtists.map((a) => (
              <AlbumCard key={a.id} title={a.name} sub="Artist" art={a.artworkUrl}
                onClick={() => onOpenArtist({ id: a.id, providerId: a.providerId, providerTrackId: '', title: '', artist: a.name, album: '', durationMs: 0, addedAt: 0 } as Song)} />
            ))}
          </div>
        </>
      )}
      {!loading && !error && showAlbums && visibleAlbums.length > 0 && (
        <>
          <h3 className="section-title">Albums</h3>
          <div className="grid-cards">
            {visibleAlbums.map((a) => (
              <AlbumCard key={a.id} title={a.title} sub={a.artist} art={a.artworkUrl}
                onClick={() => onOpenAlbum({ id: a.id, providerId: a.providerId, providerTrackId: '', title: '', artist: a.artist, album: a.title, albumId: a.id, addedAt: 0, durationMs: 0 } as Song)} />
            ))}
          </div>
        </>
      )}
      {!loading && !error && showPlaylists && visiblePlaylists.length > 0 && (
        <>
          <h3 className="section-title">Playlists</h3>
          <div className="grid-cards">
            {visiblePlaylists.map((p) => <AlbumCard key={p.id} title={p.name} sub={`${p.trackIds.length} songs`} art={p.coverUrl} />)}
          </div>
        </>
      )}
    </div>
  );
}

export function PartialResultsNotice({ failures }: { failures: string[] }) {
  const pm = (() => {
    try { return getProviderManager(); } catch { return null; }
  })();
  const isDiscoveryOnly = (id: string): boolean => {
    try {
      const p = pm?.get(id);
      return p ? p.capabilities.supportsStreaming === false : id === 'youtube-music';
    } catch {
      return id === 'youtube-music';
    }
  };
  const playback = failures.filter((f) => !isDiscoveryOnly(f));
  const discovery = failures.filter((f) => isDiscoveryOnly(f));
  return (
    <span style={{ fontSize: 12, color: 'var(--warning)', display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {playback.length > 0 && (
        <span title={playback.includes('freetouse') ? 'FreeToUse blocks direct browser requests (no CORS headers). In dev, set VITE_FREETOUSE_API_BASE_URL=/api/freetouse to use the built-in proxy; in the desktop app it goes through the local proxy.' : undefined}>
          Some sources are temporarily unavailable ({playback.map(providerLabel).join(', ')}) — showing partial results
        </span>
      )}
      {discovery.length > 0 && (
        <span>
          {discovery.map(providerLabel).join(', ')} discovery is unavailable — showing partial results
        </span>
      )}
    </span>
  );
}
