import React, { useRef, useState } from 'react';

/**
 * Shared editorial components — KNOX warm "vinyl-lounge" system (Spec §6).
 * Pure presentation: no data fetching, no player logic. All styling is
 * theme-token driven via classes in styles/global.css (no hardcoded hex).
 */

export function TopBarWithIcons({ title, onHistory, onTrending, onCommunity, onProfile, hasUnread }: {
  title: string;
  onHistory: () => void;
  onTrending?: () => void;
  onCommunity?: () => void;
  onProfile: () => void;
  hasUnread?: boolean;
}) {
  return (
    <header className="knox-topbar" aria-label={`${title} header`}>
      <h1 className="knox-topbar-title">{title}</h1>
      <div className="knox-topbar-icons">
        <button className="knox-icon-btn" onClick={onHistory} aria-label="Recently played" title="Recently played">◷</button>
        <button className="knox-icon-btn" onClick={onTrending} aria-label="Trending" title="Trending">↗</button>
        <button className="knox-icon-btn" onClick={onCommunity} aria-label="Community" title="Community">☺☺</button>
        <button className="knox-icon-btn" onClick={onProfile} aria-label="Profile" title="Profile">
          <span aria-hidden>●</span>
          {hasUnread && <span className="knox-avatar-dot" aria-label="Unread notifications" />}
        </button>
      </div>
    </header>
  );
}

export function CategoryPillRow({ categories, selected, onSelect }: {
  categories: string[]; selected: string | null; onSelect: (c: string | null) => void;
}) {
  return (
    <div className="knox-pill-row" role="group" aria-label="Browse by mood">
      {categories.map((c) => (
        <button
          key={c}
          className="knox-pill"
          aria-pressed={selected === c}
          onClick={() => onSelect(selected === c ? null : c)}
        >{c}</button>
      ))}
    </div>
  );
}

export type SpeedDialItem = {
  id: string;
  title: string;
  art?: string;
  /** square = photo tile · artist = circular spotlight · accent-* = solid tile (missing-art fallback) */
  kind: 'square' | 'artist' | 'accent-olive' | 'accent-gold';
  glyph?: string;
};

const PAGE_SIZE = 6;

export function SpeedDialGrid({ items, onOpen, onSeeAll }: {
  items: SpeedDialItem[]; onOpen: (item: SpeedDialItem) => void; onSeeAll?: () => void;
}) {
  const pagerRef = useRef<HTMLDivElement>(null);
  const [page, setPage] = useState(0);
  const pages: SpeedDialItem[][] = [];
  for (let i = 0; i < items.length; i += PAGE_SIZE) pages.push(items.slice(i, i + PAGE_SIZE));
  if (pages.length === 0) return null;

  const onScroll = () => {
    const el = pagerRef.current;
    if (!el || el.clientWidth === 0) return;
    setPage(Math.round(el.scrollLeft / el.clientWidth));
  };

  return (
    <section aria-label="Speed dial">
      <div className="knox-section-head">
        <h2 className="knox-section-title">Speed dial</h2>
        {onSeeAll && (
          <button className="knox-chevron-btn" onClick={onSeeAll} aria-label="See all speed dial">›</button>
        )}
      </div>
      <div
        ref={pagerRef}
        onScroll={onScroll}
        style={{ display: 'flex', overflowX: 'auto', scrollSnapType: 'x mandatory', scrollbarWidth: 'none' }}
      >
        {pages.map((pg, pi) => (
          <div key={pi} style={{ flex: '0 0 100%', scrollSnapAlign: 'start' }}>
            <div className="knox-speed-grid">
              {pg.map((item) => (
                <SpeedDialTile key={item.id} item={item} onOpen={onOpen} />
              ))}
            </div>
          </div>
        ))}
      </div>
      {pages.length > 1 && (
        <div className="knox-page-dots" aria-hidden>
          {pages.map((_, i) => <span key={i} className={i === page ? 'on' : ''} />)}
        </div>
      )}
    </section>
  );
}

function SpeedDialTile({ item, onOpen }: { item: SpeedDialItem; onOpen: (i: SpeedDialItem) => void }) {
  if (item.kind === 'artist') {
    return (
      <button className="knox-tile artist-spot" onClick={() => onOpen(item)} aria-label={`${item.title} — see more`}>
        {item.art
          ? <img src={item.art} alt="" loading="lazy" />
          : <span className="knox-tile-glyph" aria-hidden>♪</span>}
        <span className="knox-spot-chevron" aria-hidden>›</span>
      </button>
    );
  }
  if (item.kind === 'accent-olive' || item.kind === 'accent-gold' || !item.art) {
    return (
      <button
        className={`knox-tile ${item.kind.startsWith('accent') ? item.kind : 'accent-olive'}`}
        onClick={() => onOpen(item)}
        aria-label={item.title}
      >
        <span className="knox-tile-glyph" aria-hidden>{item.glyph ?? '✦'}</span>
        <span className="knox-tile-scrim" aria-hidden />
        <span className="knox-tile-label">{item.title}</span>
      </button>
    );
  }
  return (
    <button className="knox-tile" onClick={() => onOpen(item)} aria-label={item.title}>
      <img src={item.art} alt="" loading="lazy" />
      <span className="knox-tile-scrim" aria-hidden />
      <span className="knox-tile-label">{item.title}</span>
    </button>
  );
}

export type RailItem = {
  id: string;
  title: string;
  sub?: string;
  art?: string;
  round?: boolean;
};

export function HorizontalMediaRail({ title, items, onOpen, onPlay, onSeeAll, gold = false }: {
  title: string;
  items: RailItem[];
  onOpen: (id: string) => void;
  onPlay?: (id: string) => void;
  onSeeAll?: () => void;
  gold?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title}>
      <div className="knox-section-head">
        <h2 className={`knox-section-title${gold ? '' : ' neutral'}`}>{title}</h2>
        {onSeeAll && (
          <button className="knox-chevron-btn" onClick={onSeeAll} aria-label={`See all ${title}`}>›</button>
        )}
      </div>
      <div className="knox-rail">
        {items.map((item) => (
          <button
            key={item.id}
            className={`knox-rail-card${item.round ? ' round' : ''}`}
            onClick={() => { onPlay?.(item.id); onOpen(item.id); }}
            aria-label={`${item.title}${item.sub ? ` — ${item.sub}` : ''}`}
          >
            <span style={{ position: 'relative', display: 'block' }}>
              {item.art
                ? <img src={item.art} alt="" loading="lazy" />
                : <span className="knox-rail-art" aria-hidden style={{ display: 'grid', placeItems: 'center', fontSize: 28, color: 'var(--accent-gold)' }}>♪</span>}
              <span className="knox-rail-play" aria-hidden>▶</span>
            </span>
            <span className="knox-rail-title">{item.title}</span>
            {item.sub && <span className="knox-rail-sub">{item.sub}</span>}
          </button>
        ))}
      </div>
    </section>
  );
}

export function SourceTagChip({ label }: { label: string }) {
  return <span className="knox-source-chip">{label}</span>;
}

/** Quiet gold-outline confidence chip, sentence case (§5). */
export function MatchChip({ matchType }: { matchType: 'exact' | 'strong' | 'partial' | 'related' }) {
  const label = matchType === 'exact' ? 'Exact match'
    : matchType === 'strong' ? 'Strong match'
    : matchType === 'partial' ? 'Partial' : 'Related';
  return <span className={`match-badge ${matchType}`}>{label}</span>;
}

/** Thin circular progress ring around mini-player artwork (§2). */
export function ProgressRing({ progress, size = 42, stroke = 2 }: {
  progress: number; size?: number; stroke?: number;
}) {
  const r = (size - stroke) / 2 - 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.max(0, Math.min(1, progress));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--divider)" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="var(--accent-gold)" strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={c * (1 - clamped)}
      />
    </svg>
  );
}
