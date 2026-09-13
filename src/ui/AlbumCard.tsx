import React from 'react';

export function AlbumCard({ title, sub, art, onClick, badge }: {
  title: string; sub?: string; art?: string; onClick?: () => void; badge?: string;
}) {
  return (
    <div className="card album-card" onClick={onClick} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') onClick?.(); }} aria-label={title}>
      {art
        ? <img className="album-art" src={art} alt="" loading="lazy" />
        : <div className="album-art" style={{ display: 'grid', placeItems: 'center', fontSize: 40 }} aria-hidden>♪</div>}
      <div style={{ fontWeight: 700, fontSize: 13.5, marginTop: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {title} {badge && <span style={{ color: 'var(--text-3)' }}>{badge}</span>}
      </div>
      {sub && <div style={{ color: 'var(--text-2)', fontSize: 12, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{sub}</div>}
    </div>
  );
}
