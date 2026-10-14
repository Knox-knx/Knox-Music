import React, { useEffect, useMemo, useState } from 'react';
import type { Song } from '../core/types';
import { historyRepo, favoriteRepo, offlineRepo, songRepo } from '../data/repositories';
import { usePlayer } from '../audio/playerStore';
import { getProviderManager } from '../providers/ProviderManager';
import {
  cleanSongTitle,
  detectMusicVibe,
  enforceArtistDiversity,
  extractPrimarySongTitle,
  isCompilationOrJukebox,
  isNonMusicVideo,
  isSameSongOrVariant,
} from '../audio/vibeClassifier';
import { Skeleton, EmptyState } from '../ui/primitives';
import {
  KnoxTopBar, SpeedDialGrid, HorizontalMediaRail,
  type SpeedDialItem,
} from '../ui/editorial';
import type { Route } from '../ui/navigation';

function providerShortLabel(providerId: string): string {
  switch (providerId) {
    case 'jiosaavn':
      return 'JioSaavn';
    case 'spotify':
      return 'Spotify';
    case 'youtube-music':
      return 'YT Music';
    case 'youtube':
      return 'YouTube';
    default:
      return providerId;
  }
}

function readLastSearchQuery(): string {
  try {
    const raw = localStorage.getItem('knox.searchHistory');
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (Array.isArray(arr) && typeof arr[0] === 'string' && arr[0].trim()) {
      return arr[0].trim();
    }
  } catch { /* ignore */ }
  return '';
}

function menuFallback(): void {
  window.dispatchEvent(new CustomEvent('knox:open-menu'));
}
function settingsFallback(go: (r: Route) => void): void {
  try { go('settings'); }
  catch { window.dispatchEvent(new CustomEvent('knox:open-settings')); }
}

export function HomeScreen({ go, onOpenAlbum, onOpenArtist, onOpenMenu, onOpenSettings }: {
  go: (r: Route) => void; onOpenAlbum: (s: Song) => void; onOpenArtist: (s: Song) => void;
  onOpenMenu?: () => void; onOpenSettings?: () => void;
}) {
  const openMenu = onOpenMenu ?? menuFallback;
  const openSettings = onOpenSettings ?? (() => settingsFallback(go));
  const [loading, setLoading] = useState(true);
  const [recent, setRecent] = useState<Song[]>([]);
  const [favorites, setFavorites] = useState<Song[]>([]);
  const [offline, setOffline] = useState<Song[]>([]);
  const [added, setAdded] = useState<Song[]>([]);
  const [suggestedFeed, setSuggestedFeed] = useState<Song[]>([]);
  const [suggestedLabel, setSuggestedLabel] = useState<string>('Suggested by last search');
  const [lastSearch] = useState<string>(() => readLastSearchQuery());

  const currentSong = usePlayer((s) => s.current);
  const offlineMode = usePlayer((s) => s.offlineMode);
  const playSongs = usePlayer((s) => s.playSongs);
  const setShuffle = usePlayer((s) => s.setShuffle);
  const totalSongs = recent.length + favorites.length + offline.length + added.length;

  useEffect(() => {
    let live = true;
    const loadHomeData = async () => {
      try {
        const [hist, favs, off, fresh] = await Promise.all([
          historyRepo.recent(8),
          favoriteRepo.listSongs().catch(() => [] as Song[]),
          offlineRepo.list().catch(() => []),
          songRepo.list(0, 8, 'recent').catch(() => [] as Song[]),
        ]);
        if (!live) return;
        const histSongs: Song[] = [];
        for (const h of hist) {
          const s = await songRepo.get(h.songId).catch(() => undefined);
          if (s) histSongs.push(s);
          if (histSongs.length >= 6) break;
        }
        setRecent(histSongs);
        setFavorites(favs.slice(0, 8));
        setAdded(fresh);
        const offSongs: Song[] = [];
        for (const o of off.slice(0, 8)) {
          const s = await songRepo.get(o.id).catch(() => undefined);
          if (s) offSongs.push(s);
        }
        setOffline(offSongs);
      } finally { if (live) setLoading(false); }
    };
    void loadHomeData();
    const onLibUpdated = () => { void loadHomeData(); };
    window.addEventListener('knox:library-updated', onLibUpdated);
    window.addEventListener('knox:favorites-updated', onLibUpdated);
    return () => {
      live = false;
      window.removeEventListener('knox:library-updated', onLibUpdated);
      window.removeEventListener('knox:favorites-updated', onLibUpdated);
    };
  }, []);

  const allSongs = useMemo(() => {
    const seen = new Set<string>();
    return [...recent, ...favorites, ...offline, ...added].filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
  }, [recent, favorites, offline, added]);

  // Seed song for provider feed discovery: currently playing song first, otherwise most recent library track
  const vibeSeedSong = useMemo(() => {
    if (currentSong && currentSong.title) return currentSong;
    return recent[0] ?? favorites[0] ?? added[0] ?? offline[0] ?? null;
  }, [currentSong, recent, favorites, added, offline]);

  // Fetch non-downloaded provider feed suggestions matching the active listening vibe or last search
  useEffect(() => {
    if ((!vibeSeedSong && !lastSearch) || offlineMode) {
      setSuggestedFeed([]);
      return;
    }

    const controller = new AbortController();
    let active = true;

    (async () => {
      try {
        const vibe = detectMusicVibe(vibeSeedSong);
        const [offlineEntries, librarySongs] = await Promise.all([
          offlineRepo.list().catch(() => []),
          songRepo.list(0, 300, 'recent').catch(() => [] as Song[]),
        ]);
        if (!active || controller.signal.aborted) return;

        const ownedIds = new Set<string>();
        const ownedCleanTitles = new Set<string>();
        const ownedPrimaryTitles = new Set<string>();
        const ownedSongs: Song[] = [...allSongs, ...librarySongs];

        for (const o of offlineEntries) {
          ownedIds.add(o.id);
          if (o.title) {
            const ct = cleanSongTitle(o.title);
            const pt = extractPrimarySongTitle(o.title);
            if (ct) ownedCleanTitles.add(ct);
            if (pt) ownedPrimaryTitles.add(pt);
          }
        }
        for (const ls of ownedSongs) {
          if (!ls) continue;
          ownedIds.add(ls.id);
          if (ls.title) {
            const ct = cleanSongTitle(ls.title);
            const pt = extractPrimarySongTitle(ls.title);
            if (ct) ownedCleanTitles.add(ct);
            if (pt) ownedPrimaryTitles.add(pt);
          }
        }

        const isAlreadyOwned = (cand: Song): boolean => {
          if (!cand || !cand.id || !cand.title) return true;
          if (ownedIds.has(cand.id) || cand.isOfflineAvailable || cand.isLocalFile) return true;
          const ct = cleanSongTitle(cand.title);
          const pt = extractPrimarySongTitle(cand.title);
          if (ct && ownedCleanTitles.has(ct)) return true;
          if (pt && pt.length >= 2 && ownedPrimaryTitles.has(pt)) return true;
          if (isSameSongOrVariant(cand, vibeSeedSong)) return true;
          return ownedSongs.some((os) => isSameSongOrVariant(cand, os));
        };

        const pm = getProviderManager();
        const enabledSet = new Set(pm.enabledProviders().map((p) => p.id));
        const providerIds = ['jiosaavn', 'youtube-music', 'spotify', 'youtube'] as const;
        const activeProviders = providerIds
          .map((pid) => pm.get(pid))
          .filter((p): p is NonNullable<typeof p> =>
            Boolean(p && enabledSet.has(p.id) && p.capabilities.supportsSearch && p.capabilities.supportsStreaming),
          );

        if (activeProviders.length === 0) {
          if (active) setSuggestedFeed([]);
          return;
        }

        const baseQueries = vibe.relatedQueries
          .map((q) => q.replace(/^Mix\s*-\s*/i, '').trim())
          .filter(Boolean);
        const queries = (lastSearch ? [lastSearch, ...baseQueries] : baseQueries).slice(0, 2);

        const rawCandidates: Song[] = [];
        await Promise.allSettled(
          activeProviders.slice(0, 3).map(async (prov, idx) => {
            const q = queries[idx % queries.length] || queries[0];
            if (!q) return;
            const results = await prov.searchSongs(q, controller.signal);
            if (Array.isArray(results)) {
              rawCandidates.push(...results.slice(0, 10));
            }
          }),
        );

        if (!active || controller.signal.aborted) return;

        const filtered = rawCandidates.filter((c) => {
          if (!c || !c.id || !c.title) return false;
          if (isAlreadyOwned(c)) return false;
          if (isNonMusicVideo(c.title, c.artist)) return false;
          if (isCompilationOrJukebox(c.title)) return false;
          if (c.durationMs > 0 && c.durationMs < 40_000) return false;
          return true;
        });

        // Prefer strict vibe matches first, then fill with remaining valid results
        const strictVibeMatches =
          vibe.vibe !== 'general' ? filtered.filter((c) => vibe.isSameVibe(c)) : filtered;
        const pool = strictVibeMatches.length >= 3 ? strictVibeMatches : filtered;

        const diverse = enforceArtistDiversity(pool, vibeSeedSong, 14);
        if (!active || controller.signal.aborted) return;

        if (diverse.length > 0) {
          setSuggestedFeed(diverse.slice(0, 12));
          setSuggestedLabel('Suggested by last search');
        } else {
          setSuggestedFeed([]);
        }
      } catch {
        if (active) setSuggestedFeed([]);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [vibeSeedSong?.id, vibeSeedSong?.title, lastSearch, offlineMode, allSongs.length]);

  const speedItems: SpeedDialItem[] = useMemo(() => {
    const pool = allSongs.slice(0, 10);
    const items: SpeedDialItem[] = [];
    pool.forEach((s, i) => {
      // Only real artwork is passed — missing art falls back to the solid
      // accent tile style inside SpeedDialTile (never a broken image).
      const art = s.artworkLocal ?? s.artworkUrl ?? undefined;
      // One circular artist spotlight per page (positions 4, 10, …).
      if (i % PAGE === SPOT_POS) {
        items.push({ id: `artist-${s.id}`, title: s.artist, art, kind: 'artist' });
      } else if (!art) {
        items.push({ id: s.id, title: s.album || s.title, kind: 'accent-olive', glyph: '♪' });
      } else {
        items.push({ id: s.id, title: s.album || s.title, art, kind: 'square' });
      }
    });
    // One solid accent tile per page: Shuffle All (olive) opens the grid.
    items.splice(2, 0, { id: '__shuffle', title: 'Shuffle All', kind: 'accent-olive', glyph: '✦' });
    if (allSongs.length > 4) {
      items.splice(8, 0, { id: '__discover', title: 'Discover', kind: 'accent-gold', glyph: '✦' });
    }
    return items.slice(0, 12);
  }, [allSongs]);

  const songById = useMemo(() => {
    const map = new Map<string, Song>();
    for (const s of allSongs) map.set(s.id, s);
    for (const s of suggestedFeed) map.set(s.id, s);
    return map;
  }, [allSongs, suggestedFeed]);

  const playSingleSong = (s: Song) => {
    void (async () => {
      const ok = await playSongs([s], 0);
      if (ok) {
        try {
          const { isRealtimeUpNextProvider, startYouTubeUpNext } = await import('../providers/youtube/upNext');
          if (isRealtimeUpNextProvider(s.providerId)) {
            await startYouTubeUpNext(s, [], s.title);
          }
        } catch {
          /* best-effort */
        }
      }
    })();
  };

  const openSpeedItem = (item: SpeedDialItem) => {
    if (item.id === '__shuffle') {
      if (allSongs.length === 0) return;
      setShuffle(true);
      void playSongs(allSongs, Math.floor(Math.random() * allSongs.length));
      return;
    }
    if (item.id === '__discover') { go('search'); return; }
    if (item.id.startsWith('artist-')) {
      const s = songById.get(item.id.slice('artist-'.length));
      if (s) onOpenArtist(s);
      return;
    }
    const s = songById.get(item.id);
    if (s) playSingleSong(s);
  };

  if (loading) {
    return (
      <div>
        <KnoxTopBar title="Home" caption="Your music, your device" onOpenMenu={openMenu} onOpenSettings={openSettings} />
        <div style={{ padding: '18px 20px' }}><Skeleton count={4} /></div>
      </div>
    );
  }

  if (totalSongs === 0 && suggestedFeed.length === 0) {
    return (
      <div>
        <KnoxTopBar title="Home" caption="Your music, your device" onOpenMenu={openMenu} onOpenSettings={openSettings} />
        <EmptyState
          icon="♪" title="Your library is empty"
          body="Add a music folder or search for music to get started."
          actions={<><button className="btn btn-primary" onClick={() => go('library')}>Add Music</button><button className="btn" onClick={() => go('search')}>Search Music</button></>}
        />
      </div>
    );
  }

  const rail = (s: Song, round = false) => ({
    id: s.id, title: s.title, sub: s.artist,
    art: s.artworkLocal ?? s.artworkUrl ?? undefined, round,
  });

  const suggestionRail = (s: Song) => ({
    id: s.id,
    title: s.title,
    sub: `${s.artist} · ${providerShortLabel(s.providerId)}`,
    art: s.artworkLocal ?? s.artworkUrl ?? undefined,
    round: false,
  });

  return (
    <div className="knox-home">
      <KnoxTopBar
        title="Home"
        caption="Your music, your device"
        onOpenMenu={openMenu}
        onOpenSettings={openSettings}
      />

      <SpeedDialGrid items={speedItems} onOpen={openSpeedItem} onSeeAll={() => go('library')} icon="✦" title="Speed dial" />

      {suggestedFeed.length > 0 && (
        <HorizontalMediaRail
          title={suggestedLabel || 'Suggested by last search'}
          icon="✦"
          gold
          items={suggestedFeed.map((s) => suggestionRail(s))}
          onOpen={(id) => { const s = songById.get(id); if (s) playSingleSong(s); }}
          onPlay={(id) => { const s = songById.get(id); if (s) playSingleSong(s); }}
          onSeeAll={() => go('search')}
        />
      )}

      <HorizontalMediaRail
        title="Keep listening"
        icon="▷"
        gold
        items={recent.map((s) => rail(s))}
        onOpen={(id) => { const s = songById.get(id); if (s) onOpenAlbum(s); }}
        onPlay={(id) => { const s = songById.get(id); if (s) playSingleSong(s); }}
        onSeeAll={() => go('history')}
      />
      <HorizontalMediaRail
        title="Recently added"
        icon="🕐"
        gold
        items={added.map((s) => rail(s))}
        onOpen={(id) => { const s = songById.get(id); if (s) onOpenAlbum(s); }}
        onPlay={(id) => { const s = songById.get(id); if (s) playSingleSong(s); }}
        onSeeAll={() => go('library')}
      />
      {favorites.length > 0 && (
        <HorizontalMediaRail
          title="Made for you"
          icon="♥"
          gold
          items={favorites.map((s) => rail(s))}
          onOpen={(id) => { const s = songById.get(id); if (s) onOpenAlbum(s); }}
          onPlay={(id) => { const s = songById.get(id); if (s) playSingleSong(s); }}
          onSeeAll={() => go('favorites')}
        />
      )}
    </div>
  );
}

const PAGE = 6;
const SPOT_POS = 4;
