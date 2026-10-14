import React from 'react';
import { Glyph, Icon } from './icons';

export type Route =
  | 'home' | 'search' | 'radio' | 'library' | 'favorites' | 'playlists'
  | 'playlist' | 'downloads' | 'history' | 'settings' | 'storage'
  | 'about' | 'artist' | 'album' | 'providers' | 'permissions' | 'youtube';

const MAIN: { id: Route; label: string; icon: string }[] = [
  { id: 'home', label: 'Home', icon: '⌂' },
  { id: 'search', label: 'Search', icon: '⌕' },
  { id: 'radio', label: 'Radio', icon: '◉' },
  { id: 'library', label: 'Library', icon: '♫' },
  { id: 'favorites', label: 'Favorites', icon: '♥' },
  { id: 'playlists', label: 'Playlists', icon: '☰' },
  { id: 'downloads', label: 'Downloads', icon: '↓' },
  { id: 'history', label: 'History', icon: '◷' },
];

export function Sidebar({ route, go, playlists, onCreatePlaylist, onOpenMenu }: {
  route: Route; go: (r: Route) => void; playlists: { id: string; name: string }[]; onCreatePlaylist: () => void; onOpenMenu?: () => void;
}) {
  return (
    <aside className="sidebar" aria-label="Primary">
      <div className="brand">
        <div className="brand-mark" aria-hidden>
          <img src="/icons/icon-192.png" alt="" width={36} height={36} />
        </div>
        <div>
          <div className="brand-name">KNOX MUSIC</div>
          <div className="brand-sub">LOCAL FIRST</div>
        </div>
      </div>
      {onOpenMenu && (
        <button className="nav-item" onClick={onOpenMenu} aria-haspopup="dialog" aria-label="Open menu">
          <span className="ico" aria-hidden><Glyph char="≡" size={18} /></span>Menu
        </button>
      )}
      {MAIN.slice(0, 3).map((n) => (
        <button key={n.id} className={`nav-item${route === n.id ? ' active' : ''}`} onClick={() => go(n.id)} aria-current={route === n.id ? 'page' : undefined}>
          <span className="ico" aria-hidden><Glyph char={n.icon} size={18} /></span>{n.label}
        </button>
      ))}
      <div className="nav-label">Your Music</div>
      {MAIN.slice(3).map((n) => (
        <button key={n.id} className={`nav-item${route === n.id ? ' active' : ''}`} onClick={() => go(n.id)} aria-current={route === n.id ? 'page' : undefined}>
          <span className="ico" aria-hidden><Glyph char={n.icon} size={18} /></span>{n.label}
        </button>
      ))}
      <div className="nav-label">Playlists</div>
      <button className="nav-item" onClick={onCreatePlaylist}><Icon name="plus" size={15} /> Create Playlist</button>
      {playlists.slice(0, 8).map((p) => (
        <button key={p.id} className={`nav-item${route === 'playlist' ? '' : ''}`} onClick={() => go('playlists')} title={p.name}>
          <span className="ico" aria-hidden><Glyph char="♪" size={18} /></span>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
        </button>
      ))}
      <div style={{ flex: 1 }} />
      <div className="nav-label">System</div>
      <button className={`nav-item${route === 'settings' ? ' active' : ''}`} onClick={() => go('settings')}><span className="ico" aria-hidden><Glyph char="⚙" size={18} /></span>Settings</button>
      <button className={`nav-item${route === 'permissions' ? ' active' : ''}`} onClick={() => go('permissions')}><span className="ico" aria-hidden><Glyph char="✓" size={18} /></span>App permissions</button>
      <button className={`nav-item${route === 'storage' ? ' active' : ''}`} onClick={() => go('storage')}><span className="ico" aria-hidden><Glyph char="🗄" size={18} /></span>Storage</button>
      <button className={`nav-item${route === 'about' ? ' active' : ''}`} onClick={() => go('about')}><span className="ico" aria-hidden><Glyph char="ⓘ" size={18} /></span>About</button>
    </aside>
  );
}

export function TopBar({ query, setQuery, onOpenSettings, offlineMode }: {
  query: string; setQuery: (q: string) => void; onOpenSettings: () => void; offlineMode: boolean;
}) {
  const [netOnline, setNetOnline] = React.useState<boolean>(() => (typeof navigator !== 'undefined' ? navigator.onLine !== false : true));
  React.useEffect(() => {
    const onOnline = () => setNetOnline(true);
    const onOffline = () => setNetOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);
  const isOff = offlineMode || !netOnline;
  return (
    <header className="topbar">
      <div className="search-input" role="search">
        <span aria-hidden><Glyph char="⌕" size={15} /></span>
        <input
          id="knox-global-search"
          type="search"
          value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
          placeholder={isOff ? 'Search your downloaded music (offline)' : 'Search songs, artists, albums...'}
          aria-label="Search songs, artists, albums"
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
          enterKeyHint="search"
        />
        {query
          ? <button className="icon-btn" style={{ width: 26, height: 26, fontSize: 12 }} onClick={() => setQuery('')} aria-label="Clear search"><Glyph char="✕" size={12} /></button>
          : <span className="kbd-hint" aria-hidden>Ctrl K</span>}
      </div>
      <div style={{ flex: 1 }} />
      <span className={`knox-live-pill ${isOff ? 'is-offline' : 'is-online'}`} role="status" aria-label={isOff ? 'Offline' : 'Online'}>
        <span className="dot" aria-hidden style={{ background: isOff ? '#ef4444' : '#22c55e' }} />{isOff ? 'Offline' : 'Online'}
      </span>
      <button className="icon-btn" onClick={onOpenSettings} aria-label="Open settings" title="Settings"><Glyph char="⚙" size={16} /></button>
    </header>
  );
}

export function BottomNav({ route, go }: { route: Route; go: (r: Route) => void }) {
  const items: { id: Route; label: string; icon: 'home' | 'search' | 'musicNote' | 'radio' }[] = [
    { id: 'home', label: 'Home', icon: 'home' },
    { id: 'search', label: 'Search', icon: 'search' },
    { id: 'library', label: 'Library', icon: 'musicNote' },
    { id: 'radio', label: 'Radio', icon: 'radio' },
  ];
  return (
    <nav className="menu knox-pill-menu" aria-label="Primary">
      {items.map((n) => {
        const isActive = route === n.id;
        return (
          <a
            key={n.id}
            href={`#${n.id}`}
            className={isActive ? 'active' : ''}
            onClick={(e) => {
              e.preventDefault();
              go(n.id);
            }}
            aria-current={isActive ? 'page' : undefined}
            title={n.label}
          >
            <Icon name={n.icon} size={22} />
            <span>{n.label}</span>
          </a>
        );
      })}
    </nav>
  );
}
