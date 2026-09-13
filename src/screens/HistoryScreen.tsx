import React, { useEffect, useState } from 'react';
import type { HistoryEntry } from '../core/types';
import { historyRepo, songRepo } from '../data/repositories';
import { usePlayer } from '../audio/playerStore';
import { EmptyState, SectionTitle, Skeleton } from '../ui/primitives';

export function HistoryScreen() {
  const [items, setItems] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const playSong = usePlayer((s) => s.playSong);

  const load = () => {
    setLoading(true);
    historyRepo.recent(100).then((h) => { setItems(h); setLoading(false); }).catch(() => setLoading(false));
  };
  useEffect(load, []);

  if (loading) return <Skeleton count={6} />;
  if (items.length === 0) {
    return <EmptyState icon="◷" title="No history yet" body="Songs you play will appear here. History never leaves this device." />;
  }

  return (
    <div>
      <SectionTitle title="History" sub="Stored locally only"
        right={<button className="btn" onClick={() => { if (window.confirm('Clear all history?')) void historyRepo.clear().then(load); }}>Clear history</button>} />
      <div className="card" style={{ padding: 8 }}>
        {items.map((h) => (
          <div key={h.id} className="song-row"
            onClick={() => { void songRepo.get(h.songId).then((s) => { if (s) void playSong(s); }); }}>
            <div className="song-meta">
              <div className="song-title">{h.title}</div>
              <div className="song-sub">{h.artist} · {new Date(h.playedAt).toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
