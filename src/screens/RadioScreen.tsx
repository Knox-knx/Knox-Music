// Dedicated live-radio screen. Stations are never treated as normal songs:
// no duration, no progress, no offline/download — play shows LIVE.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayer } from '../audio/playerStore';
import { favoriteRepo, songRepo } from '../data/repositories';
import { getRadioProvider } from '../providers/radio/radioBrowser';
import { stationToSong } from '../providers/radio/radioBrowser';
import type { RadioStation } from '../providers/radio/types';
import { messageForProviderError } from '../core/errors';
import { useSettings } from '../settings/settingsStore';
import { Skeleton, EmptyState, ErrorState } from '../ui/primitives';
import { toast } from '../ui/toast';

const TAGS = ['pop', 'rock', 'jazz', 'classical', 'news', 'talk', 'electronic', 'hits'];
const COUNTRIES = ['India', 'United States', 'United Kingdom', 'Germany', 'France', 'Japan'];
const LANGUAGES = ['hindi', 'english', 'spanish', 'french', 'german'];

function StationCard({ station }: { station: RadioStation }) {
  const playStation = usePlayer((s) => s.playStation);
  const currentStation = usePlayer((s) => s.currentStation);
  const playerMode = usePlayer((s) => s.playerMode);
  const state = usePlayer((s) => s.state);
  const [fav, setFav] = useState(false);
  const active = playerMode === 'radio' && currentStation?.id === station.id;
  const playing = active && (state === 'PLAYING' || state === 'BUFFERING');

  useEffect(() => {
    let live = true;
    favoriteRepo.isFavorite(station.id).then((f) => { if (live) setFav(f); }).catch(() => undefined);
    return () => { live = false; };
  }, [station.id]);

  const toggleFav = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await songRepo.upsert(stationToSong(station));
      if (fav) { await favoriteRepo.remove(station.id); setFav(false); toast('Removed from Favorites'); }
      else { await favoriteRepo.add(station.id); setFav(true); toast('♥ Added to Favorites'); }
    } catch { toast('Could not update favorites', 'warn'); }
  };

  const meta = [station.country, station.language].filter(Boolean).join(' • ');
  const tech = [station.codec?.toUpperCase(), station.bitrate ? `${station.bitrate}k` : ''].filter(Boolean).join(' ');
  return (
    <div className={`song-row${active ? ' current' : ''}`} data-testid="station-card">
      <button
        type="button" className="song-row-content"
        onClick={() => void playStation(station)}
        aria-label={`Play live station ${station.name}`}
        data-testid="station-play"
      >
        {station.favicon
          ? <img src={station.favicon} alt="" loading="lazy" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
          : <span className="station-fallback" aria-hidden style={{ width: 48, height: 48, borderRadius: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>◉</span>}
        <span className="song-meta">
          <span className="song-title">
            {station.name}
            <span className="cap-chip live" title="Live radio stream" aria-label="Live">● LIVE</span>
            {playing && <span className="eq" aria-label="Now playing" role="img"><span /><span /><span /></span>}
          </span>
          <span className="song-sub">{meta || 'Live radio'}{tech ? ` · ${tech}` : ''}</span>
          {station.tags.length > 0 && (
            <span className="song-badges">
              {station.tags.slice(0, 3).map((t) => <span key={t} className="provider-chip">{t}</span>)}
            </span>
          )}
        </span>
      </button>
      <button
        type="button" className="icon-btn song-row-menu-button" aria-label={fav ? `Remove ${station.name} from favorites` : `Add ${station.name} to favorites`}
        aria-pressed={fav} onClick={(e) => void toggleFav(e)}
      >{fav ? '♥' : '♡'}</button>
    </div>
  );
}

export function RadioScreen() {
  const enabled = useSettings((s) => s.providersEnabled['radio-browser'] !== false);
  const [query, setQuery] = useState('');
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState('Popular');
  const abortRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (label: string, fn: (signal: AbortSignal) => Promise<RadioStation[]>) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    setSection(label);
    try {
      const list = await fn(controller.signal);
      if (controller.signal.aborted) return;
      setStations(list);
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && !controller.signal.aborted) {
        setError(messageForProviderError(e));
        setStations([]);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  // Initial: popular stations. Never touches the audio engine.
  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    void load('Popular', (sig) => getRadioProvider().getPopularStations(sig));
    return () => { abortRef.current?.abort(); };
  }, [enabled, load]);

  // Debounced station search (250ms), stale responses discarded.
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const q = query.trim();
    if (!q || !enabled) return;
    timerRef.current = setTimeout(() => {
      void load(`Results for “${q}”`, (sig) => getRadioProvider().searchStations(q, sig));
    }, 250);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [query, enabled, load]);

  const rp = getRadioProvider();
  if (!enabled) {
    return <EmptyState icon="◉" title="Radio is disabled" body="Enable Radio Browser in Settings → Providers to browse live stations." />;
  }
  return (
    <div>
      <h1 className="section-title">Radio</h1>
      <div className="search-input" role="search" style={{ marginBottom: 12 }}>
        <span aria-hidden>⌕</span>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search live stations…" aria-label="Search live stations" />
        {query && <button className="icon-btn" style={{ width: 26, height: 26, fontSize: 12 }} onClick={() => setQuery('')} aria-label="Clear radio search">✕</button>}
      </div>
      <div className="chips" aria-label="Radio categories" style={{ marginBottom: 12 }}>
        <button className="chip" onClick={() => void load('Popular', (s) => rp.getPopularStations(s))}>Popular</button>
        {TAGS.map((t) => (
          <button key={t} className="chip" onClick={() => void load(t, (s) => rp.getStationsByTag(t, s))}>{t}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <label style={{ fontSize: 12, color: 'var(--text-2)' }}>Country{' '}
          <select aria-label="Stations by country" defaultValue="" onChange={(e) => { if (e.target.value) void load(e.target.value, (s) => rp.getStationsByCountry(e.target.value, s)); }}>
            <option value="">Choose…</option>
            {COUNTRIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12, color: 'var(--text-2)' }}>Language{' '}
          <select aria-label="Stations by language" defaultValue="" onChange={(e) => { if (e.target.value) void load(e.target.value, (s) => rp.getStationsByLanguage(e.target.value, s)); }}>
            <option value="">Choose…</option>
            {LANGUAGES.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </label>
      </div>
      <h3>{section}</h3>
      {loading && <div aria-label="Loading stations"><Skeleton count={5} /></div>}
      {error && <ErrorState message={error} onRetry={() => void load('Popular', (s) => rp.getPopularStations(s))} />}
      {!loading && !error && stations.length === 0 && (
        <EmptyState icon="◉" title="No stations" body="Nothing found — try another search or category." />
      )}
      {!loading && !error && stations.length > 0 && (
        <div className="results-glass" style={{ padding: 8 }} role="list" aria-label="Stations">
          {stations.map((s) => <StationCard key={s.id} station={s} />)}
        </div>
      )}
    </div>
  );
}
