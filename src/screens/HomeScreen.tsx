import React, { useEffect, useMemo, useState } from 'react';
import type { Song } from '../core/types';
import { historyRepo, favoriteRepo, offlineRepo, songRepo } from '../data/repositories';
import { usePlayer } from '../audio/playerStore';
import { Skeleton, EmptyState } from '../ui/primitives';
import {
  TopBarWithIcons, CategoryPillRow, SpeedDialGrid, HorizontalMediaRail,
  type SpeedDialItem,
} from '../ui/editorial';
import type { Route } from '../ui/navigation';

const MOODS = ['Podcasts', 'Feel good', 'Relax', 'Romance', 'Energize', 'Commute', 'Workout', 'Focus'];

export function HomeScreen({ go, onOpenAlbum, onOpenArtist }: {
  go: (r: Route) => void; onOpenAlbum: (s: Song) => void; onOpenArtist: (s: Song) => void;
}) {
  const [loading, setLoading] = useState(true);
  const [recent, setRecent] = useState<Song[]>([]);
  const [favorites, setFavorites] = useState<Song[]>([]);
  const [offline, setOffline] = useState<Song[]>([]);
  const [added, setAdded] = useState<Song[]>([]);
  const [mood, setMood] = useState<string | null>(null);
  const playSongs = usePlayer((s) => s.playSongs);
  const setShuffle = usePlayer((s) => s.setShuffle);
  const totalSongs = recent.length + favorites.length + offline.length + added.length;

  useEffect(() => {
    let live = true;
    (async () => {
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
    })();
    return () => { live = false; };
  }, []);

  const allSongs = useMemo(() => {
    const seen = new Set<string>();
    return [...recent, ...favorites, ...offline, ...added].filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });
  }, [recent, favorites, offline, added]);

  // Mood pills filter the home collections by text match (title/artist/genre).
  // No mood metadata exists, so a pill with zero matches falls back to the
  // unfiltered collection — pills never produce a fake empty library.
  const matchesMood = (s: Song) => {
    if (!mood || mood === 'Podcasts') return true;
    const hay = `${s.title} ${s.artist} ${s.album} ${s.genre ?? ''}`.toLowerCase();
    return hay.includes(mood.toLowerCase());
  };
  const visible = (list: Song[]) => {
    if (!mood) return list;
    const f = list.filter(matchesMood);
    return f.length > 0 ? f : list;
  };

  const speedItems: SpeedDialItem[] = useMemo(() => {
    const pool = visible(allSongs).slice(0, 10);
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
  }, [allSongs, mood]); // eslint-disable-line react-hooks/exhaustive-deps

  const songById = useMemo(() => new Map(allSongs.map((s) => [s.id, s])), [allSongs]);

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
    if (s) void playSongs([s], 0);
  };

  if (loading) {
    return (
      <div>
        <TopBarWithIcons title="Home" onHistory={() => go('history')} onTrending={() => go('search')} onCommunity={() => go('playlists')} onProfile={() => go('settings')} />
        <div style={{ padding: '18px 20px' }}><Skeleton count={4} /></div>
      </div>
    );
  }

  if (totalSongs === 0) {
    return (
      <div>
        <TopBarWithIcons title="Home" onHistory={() => go('history')} onTrending={() => go('search')} onCommunity={() => go('playlists')} onProfile={() => go('settings')} />
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

  return (
    <div className="knox-home">
      <TopBarWithIcons
        title="Home"
        onHistory={() => go('history')}
        onTrending={() => go('search')}
        onCommunity={() => go('playlists')}
        onProfile={() => go('settings')}
      />
      <CategoryPillRow categories={MOODS} selected={mood} onSelect={setMood} />

      <SpeedDialGrid items={speedItems} onOpen={openSpeedItem} onSeeAll={() => go('library')} />

      <HorizontalMediaRail
        title="Keep listening"
        items={visible(recent).map((s) => rail(s))}
        onOpen={(id) => { const s = songById.get(id); if (s) onOpenAlbum(s); }}
        onPlay={(id) => { const s = songById.get(id); if (s) void playSongs([s], 0); }}
        onSeeAll={() => go('history')}
      />
      <HorizontalMediaRail
        title="Recently added"
        items={visible(added).map((s) => rail(s))}
        onOpen={(id) => { const s = songById.get(id); if (s) onOpenAlbum(s); }}
        onPlay={(id) => { const s = songById.get(id); if (s) void playSongs([s], 0); }}
        onSeeAll={() => go('library')}
      />
      {favorites.length > 0 && (
        <HorizontalMediaRail
          title="Made for you"
          items={visible(favorites).map((s) => rail(s))}
          onOpen={(id) => { const s = songById.get(id); if (s) onOpenAlbum(s); }}
          onPlay={(id) => { const s = songById.get(id); if (s) void playSongs([s], 0); }}
          onSeeAll={() => go('favorites')}
        />
      )}
      {offline.length > 0 && (
        <HorizontalMediaRail
          title="Local files"
          items={visible(offline).map((s) => rail(s))}
          onOpen={(id) => { const s = songById.get(id); if (s) onOpenAlbum(s); }}
          onPlay={(id) => { const s = songById.get(id); if (s) void playSongs([s], 0); }}
          onSeeAll={() => go('downloads')}
        />
      )}
    </div>
  );
}

const PAGE = 6;
const SPOT_POS = 4;
