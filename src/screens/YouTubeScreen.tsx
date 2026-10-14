import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Song } from '../core/types';
import { getProviderManager } from '../providers/ProviderManager';
import { SongRow } from '../ui/SongRow';
import { Skeleton, EmptyState, ErrorState } from '../ui/primitives';
import { usePlayer } from '../audio/playerStore';
import { toast } from '../ui/toast';
import { providerLabel } from '../providers/merge';
import { useYouTubeProgress, YOUTUBE_STAGE_LABEL, clearYouTubeStage, youtubeVideoIdOf } from '../providers/youtube/youtubeOffline';
import { Glyph } from '../ui/icons';
import { KnoxTopBar } from '../ui/editorial';

export function YouTubeScreen({
  onOpenAlbum,
  onOpenArtist,
  onOpenPlayer,
  onOpenMenu,
  onOpenSettings,
}: {
  onOpenAlbum: (s: Song) => void;
  onOpenArtist: (s: Song) => void;
  onOpenPlayer?: () => void;
  onOpenMenu?: () => void;
  onOpenSettings?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [songs, setSongs] = useState<Song[]>([]);
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [preparingTitle, setPreparingTitle] = useState<string>('');
  const [playError, setPlayError] = useState<string | null>(null);
  const offlineMode = usePlayer((s) => s.offlineMode);
  const ytStages = useYouTubeProgress((s) => s.stages);
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enrichGen = useRef(0);
  const preparingStage = preparingId ? ytStages[preparingId] : undefined;
  const preparingLabel = preparingStage ? YOUTUBE_STAGE_LABEL[preparingStage] : 'Preparing track…';

  const handleSearch = useCallback(async (q: string) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    abortRef.current?.abort();
    const trimmed = q.trim();
    if (!trimmed) {
      setSongs([]);
      setLoading(false);
      setError(null);
      return;
    }
    setSongs([]);
    setLoading(true);
    setError(null);

    timerRef.current = setTimeout(() => {
      void (async () => {
        const controller = new AbortController();
        abortRef.current = controller;
        try {
          if (offlineMode) {
            setSongs([]);
            setLoading(false);
            return;
          }
          const pm = getProviderManager();
          const provider = pm.get('youtube');
          if (!provider) {
            throw new Error('YouTube provider not available');
          }
          if (!provider.capabilities.supportsSearch) {
            throw new Error('YouTube search not supported');
          }
          const results = await provider.searchSongs(trimmed, controller.signal);
          if (controller.signal.aborted) return;
          const { processSmartYouTubeResults } = await import('../audio/vibeClassifier');
          const smartResults = await processSmartYouTubeResults(results, trimmed, controller.signal);
          if (controller.signal.aborted) return;
          setSongs(smartResults);
        } catch (e) {
          if ((e as Error).name !== 'AbortError') {
            setError(e instanceof Error ? e.message : 'Search failed');
          }
        } finally {
          if (!controller.signal.aborted) setLoading(false);
        }
      })();
    }, 250);
  }, [offlineMode]);

  useEffect(() => {
    handleSearch(query);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      abortRef.current?.abort();
    };
  }, [query, handleSearch]);

  // Duration enrichment: YouTube search no longer ships track lengths, so
  // rows render instantly with –:–– and fill in here via the lightweight
  // native length resolve (no bytes downloaded). Bounded to the first 10
  // unknown rows, 4 concurrent, stale generations dropped — a slow lookup
  // can never overwrite a newer search.
  useEffect(() => {
    const missing = songs.filter((s) => !(s.durationMs > 0)).slice(0, 25);
    if (missing.length === 0) return;
    const gen = (enrichGen.current += 1);
    let cancelled = false;
    void (async () => {
      try {
        const { nativeDuration } = await import('../providers/youtube/device');
        const filled = new Map<string, number>();
        const workers = Array.from({ length: Math.min(4, missing.length) }, async () => {
          while (!cancelled) {
            const next = missing.find(
              (m) => !filled.has(m.id) && youtubeVideoIdOf(m) !== null,
            );
            if (!next) return;
            // Claim synchronously so workers never double-fetch one row.
            filled.set(next.id, -1);
            const vid = youtubeVideoIdOf(next);
            const secs = vid ? await nativeDuration(vid) : null;
            if (cancelled) return;
            if (typeof secs === 'number' && secs > 0) filled.set(next.id, secs * 1000);
            else filled.delete(next.id);
          }
        });
        await Promise.all(workers);
        if (cancelled || gen !== enrichGen.current) return;
        const usable = [...filled.entries()].filter(([, ms]) => ms > 0) as [string, number][];
        if (usable.length === 0) return;
        const byId = new Map(usable);
        setSongs((prev) =>
          prev.map((s) => {
            const ms = byId.get(s.id);
            if (ms === undefined || s.durationMs > 0) return s;
            return { ...s, durationMs: ms };
          }),
        );
      } catch {
        /* enrichment never breaks the list */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [songs]);

  const handleRequestPlay = useCallback(async (song: Song): Promise<boolean> => {
    if (preparingId) return false;
    setPlayError(null);

    try {
      const pm = getProviderManager();
      const provider = pm.get(song.providerId);
      const isDiscovery = provider?.capabilities.supportsStreaming === false;
      if (isDiscovery) {
        const msg = `This ${provider?.name ?? song.providerId} result is discovery-only — playback isn\u2019t available from this source.`;
        setPlayError(msg);
        toast(msg, 'warn');
        return false;
      }
    } catch {
      // fall through to store
    }

    setPreparingId(song.id);
    setPreparingTitle(`${song.title} — ${song.artist}`);
    try {
      const ok = await usePlayer.getState().playSong(song);
      clearYouTubeStage(song.id);
      if (ok) {
        setPreparingId(null);
        setPlayError(null);
        // Up Next: fetch real-time YouTube Mix playlist and replace queue cleanly
        void (async () => {
          try {
            const { startYouTubeUpNext } = await import('../providers/youtube/upNext');
            const r = await startYouTubeUpNext(song, songs, query);
            if (r.queued > 0) {
              const label = r.genreLabel ? ` (${r.genreLabel})` : '';
              toast(`Up Next: ${r.queued} related tracks queued${label}`);
            }
          } catch {
            /* up-next never breaks playback */
          }
        })();
        onOpenPlayer?.();
        return true;
      }
      const err = usePlayer.getState().error || 'Unable to play this track';
      setPlayError(err);
      toast(err, 'error');
      setPreparingId(null);
      return false;
    } catch (e) {
      clearYouTubeStage(song.id);
      const raw = e instanceof Error ? e.message : 'Playback failed';
      let label = song.providerId;
      try { label = getProviderManager().get(song.providerId)?.name ?? song.providerId; } catch { /* keep id */ }
      const msg = `Unable to play this track (${label}: ${raw})`;
      setPlayError(msg);
      toast(msg, 'error');
      setPreparingId(null);
      return false;
    }
  }, [preparingId, onOpenPlayer, songs, query]);

  const handlePlayAll = useCallback(async (list: Song[]) => {
    if (list.length === 0 || preparingId) return;
    const first = list[0];
    setPlayError(null);
    try {
      const pm = getProviderManager();
      const provider = pm.get(first.providerId);
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
      clearYouTubeStage(first.id);
      if (ok) {
        setPreparingId(null);
        setPlayError(null);
        if (first.providerId === 'youtube') {
          void (async () => {
            try {
              const { startYouTubeUpNext } = await import('../providers/youtube/upNext');
              const r = await startYouTubeUpNext(first, list, query);
              if (r.queued > 0) {
                const label = r.genreLabel ? ` (${r.genreLabel})` : '';
                toast(`Up Next: ${r.queued} related tracks queued${label}`);
              }
            } catch {
              /* up-next never breaks playback */
            }
          })();
        }
        onOpenPlayer?.();
      } else {
        const err = usePlayer.getState().error || 'Unable to play this track';
        setPlayError(err);
        toast(err, 'error');
        setPreparingId(null);
      }
    } catch (e) {
      clearYouTubeStage(first.id);
      const msg = `Unable to play this track (${e instanceof Error ? e.message : 'Playback failed'})`;
      setPlayError(msg);
      toast(msg, 'error');
      setPreparingId(null);
    }
  }, [preparingId, onOpenPlayer, query]);

  return (
    <div>
      <KnoxTopBar
        title="YouTube"
        caption={offlineMode ? 'Offline mode — connect to search YouTube' : 'Hotlist & instant audio streaming'}
        onOpenMenu={onOpenMenu ?? (() => window.dispatchEvent(new CustomEvent('knox:open-menu')))}
        onOpenSettings={onOpenSettings ?? (() => window.dispatchEvent(new CustomEvent('knox:open-settings')))}
      />
      <div style={{ marginBottom: 16, padding: '6px 0 0' }}>
        <div className="search-input" role="search" style={{ maxWidth: '100%' }}>
          <span aria-hidden><Glyph char="▶" size={13} /></span>
          <input
            id="knox-youtube-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
            placeholder="Search YouTube…"
            aria-label="Search YouTube"
            autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
            enterKeyHint="search"
          />
          {query
            ? <button className="icon-btn" style={{ width: 26, height: 26, fontSize: 12 }} onClick={() => setQuery('')} aria-label="Clear search"><Glyph char="✕" size={12} /></button>
            : <span className="kbd-hint" aria-hidden>Ctrl K</span>}
        </div>
        {offlineMode && (
          <div className="card" style={{ padding: 12, marginTop: 12, borderColor: 'var(--warning)' }}>
            <div style={{ fontSize: 13 }}>Offline mode — YouTube search requires an internet connection.</div>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>Disable offline mode in the header to search YouTube.</div>
          </div>
        )}
      </div>

      {preparingId && (
        <div className="card" role="status" aria-live="polite" style={{ padding: '10px 14px', marginBottom: 12, borderColor: 'var(--accent)' }}>
          <div style={{ fontSize: 13, fontWeight: 650 }}>{preparingLabel}</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{preparingTitle || 'Downloading and processing audio…'}</div>
          {preparingStage && preparingStage !== 'ready' && (
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>First play downloads once and saves offline — replays play instantly.</div>
          )}
        </div>
      )}
      {playError && !preparingId && (
        <div className="card" role="alert" style={{ padding: '10px 14px', marginBottom: 12, borderColor: 'var(--danger)' }}>
          <div style={{ fontSize: 13, fontWeight: 650 }}>Unable to play this track</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 2 }}>{playError}</div>
          <button className="btn" style={{ marginTop: 8, padding: '4px 12px', fontSize: 12 }} onClick={() => setPlayError(null)}>Dismiss</button>
        </div>
      )}

      {loading && <div style={{ display: 'grid', gap: 10 }} aria-label="Loading results"><Skeleton count={5} /></div>}
      {error && <ErrorState message={error} onRetry={() => handleSearch(query)} />}
      {!loading && !error && songs.length === 0 && query.trim() && (
        <EmptyState
          icon="▶"
          title="No results found"
          body={`Nothing found for “${query}” on YouTube.`}
          actions={<button className="btn" onClick={() => setQuery('')}>Clear search</button>}
        />
      )}

      {!loading && !error && songs.length > 0 && (
        <>
          <h3>SONGS</h3>
          <div className="results-glass" style={{ padding: 8 }}>
            {songs.map((s, idx) => (
              <SongRow
                key={s.id}
                song={s}
                index={idx}
                onOpenAlbum={onOpenAlbum}
                onOpenArtist={onOpenArtist}
                onRequestPlay={handleRequestPlay}
                preparing={preparingId === s.id}
              />
            ))}
          </div>
          {songs.length > 1 && (
            <button className="btn btn-primary" style={{ marginTop: 8 }} onClick={() => void handlePlayAll(songs)}>
              ▶ Play all
            </button>
          )}
        </>
      )}
    </div>
  );
}