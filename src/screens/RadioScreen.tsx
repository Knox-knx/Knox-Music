// Dedicated live-radio screen. Stations are never treated as normal songs:
// no duration, no progress, no offline/download — play shows LIVE.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { usePlayer } from '../audio/playerStore';
import { favoriteRepo, songRepo } from '../data/repositories';
import { getRadioProvider, stationToSong } from '../providers/radio/radioBrowser';
import type { RadioStation } from '../providers/radio/types';
import { messageForProviderError } from '../core/errors';
import { useSettings } from '../settings/settingsStore';
import { Skeleton, EmptyState, ErrorState, KnoxSelect } from '../ui/primitives';
import { KnoxTopBar } from '../ui/editorial';
import { toast } from '../ui/toast';
import { Icon, Glyph } from '../ui/icons';

const COUNTRIES = ['India', 'United States', 'United Kingdom', 'Germany', 'France', 'Japan'];
const LANGUAGES = ['hindi', 'english', 'spanish', 'french', 'german'];

const COUNTRY_OPTIONS = COUNTRIES.map((c) => ({ value: c, label: c }));
const LANGUAGE_OPTIONS = [
  { value: '', label: 'All languages' },
  ...LANGUAGES.map((l) => ({ value: l, label: l[0].toUpperCase() + l.slice(1) })),
];

function hasValidStationImage(station: RadioStation): boolean {
  const url = station.favicon?.trim() ?? '';
  return url.length > 0 && (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('data:') || url.startsWith('/'));
}

function StationCard({ station }: { station: RadioStation }) {
  const playStation = usePlayer((s) => s.playStation);
  const currentStation = usePlayer((s) => s.currentStation);
  const playerMode = usePlayer((s) => s.playerMode);
  const state = usePlayer((s) => s.state);
  const [fav, setFav] = useState(false);
  const [imgBroken, setImgBroken] = useState(false);
  const active = playerMode === 'radio' && currentStation?.id === station.id;
  const playing = active && (state === 'PLAYING' || state === 'BUFFERING');

  useEffect(() => {
    let live = true;
    favoriteRepo.isFavorite(station.id).then((f) => { if (live) setFav(f); }).catch(() => undefined);
    return () => { live = false; };
  }, [station.id]);

  // Remove stations without a profile pic / image or whose image fails to load
  if (!hasValidStationImage(station) || imgBroken) return null;

  const toggleFav = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await songRepo.upsert(stationToSong(station));
      if (fav) { await favoriteRepo.remove(station.id); setFav(false); toast('Removed from Favorites'); }
      else { await favoriteRepo.add(station.id); setFav(true); toast('Added to Favorites'); }
      window.dispatchEvent(new CustomEvent('knox:favorites-updated'));
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
        <img
          src={station.favicon}
          alt=""
          loading="lazy"
          onError={() => setImgBroken(true)}
        />
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
      >{fav ? <Icon name="heart" size={17} /> : <Icon name="heartOutline" size={17} />}</button>
    </div>
  );
}

export function RadioScreen({ onOpenMenu, onOpenSettings }: {
  onOpenMenu?: () => void; onOpenSettings?: () => void;
} = {}) {
  const enabled = useSettings((s) => s.providersEnabled['radio-browser'] !== false);
  const [query, setQuery] = useState('');
  const [country, setCountry] = useState('India');
  const [language, setLanguage] = useState('');
  const [stations, setStations] = useState<RadioStation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState('India');
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
      // Only keep stations that have a valid image/profile pic
      const withImages = list.filter(hasValidStationImage);
      setStations(withImages);
    } catch (e) {
      if ((e as Error).name !== 'AbortError' && !controller.signal.aborted) {
        setError(messageForProviderError(e));
        setStations([]);
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  // Initial: load India stations by default (with fallback to Popular if empty).
  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    void load('India', async (sig) => {
      const rp = getRadioProvider();
      const byCountry = await rp.getStationsByCountry('India', sig).catch(() => [] as RadioStation[]);
      if (byCountry.filter(hasValidStationImage).length > 0) return byCountry;
      return rp.getPopularStations(sig);
    });
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
      <KnoxTopBar
        title="Radio"
        caption="Live stations around the world"
        onOpenMenu={onOpenMenu ?? (() => window.dispatchEvent(new CustomEvent('knox:open-menu')))}
        onOpenSettings={onOpenSettings ?? (() => window.dispatchEvent(new CustomEvent('knox:open-settings')))}
      />
      <div style={{ padding: '6px 0 0' }}>
        <div className="search-input" role="search" style={{ marginBottom: 12 }}>
          <span aria-hidden><Glyph char="⌕" size={15} /></span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search live stations…" aria-label="Search live stations" />
          {query && <button className="icon-btn" style={{ width: 26, height: 26, fontSize: 12 }} onClick={() => setQuery('')} aria-label="Clear radio search"><Glyph char="✕" size={12} /></button>}
        </div>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12, padding: '0 20px' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)' }}>
            <span>Country</span>
            <KnoxSelect
              value={country}
              options={COUNTRY_OPTIONS}
              ariaLabel="Stations by country"
              onChange={(val) => {
                setCountry(val);
                setLanguage('');
                void load(val, (s) => rp.getStationsByCountry(val, s));
              }}
            />
          </div>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)' }}>
            <span>Language</span>
            <KnoxSelect
              value={language}
              options={LANGUAGE_OPTIONS}
              ariaLabel="Stations by language"
              onChange={(val) => {
                setLanguage(val);
                if (val) {
                  void load(val[0].toUpperCase() + val.slice(1), (s) => rp.getStationsByLanguage(val, s));
                } else {
                  void load(country, (s) => rp.getStationsByCountry(country, s));
                }
              }}
            />
          </div>
        </div>
      </div>
      <div style={{ padding: '0 20px' }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 19, margin: '8px 0 10px' }}>{section}</h3>
        {loading && <div aria-label="Loading stations"><Skeleton count={5} /></div>}
        {error && <ErrorState message={error} onRetry={() => void load(country, (s) => rp.getStationsByCountry(country, s))} />}
        {!loading && !error && stations.length === 0 && (
          <EmptyState icon="◉" title="No stations" body="Nothing found — try another search or country." />
        )}
        {!loading && !error && stations.length > 0 && (
          <div className="results-glass" style={{ padding: 8 }} role="list" aria-label="Stations">
            {stations.map((s) => <StationCard key={s.id} station={s} />)}
          </div>
        )}
      </div>
    </div>
  );
}
