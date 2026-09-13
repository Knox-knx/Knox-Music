import React from 'react';

export type Route =
  | 'home' | 'search' | 'radio' | 'library' | 'favorites' | 'playlists'
  | 'playlist' | 'downloads' | 'history' | 'settings' | 'storage'
  | 'about' | 'artist' | 'album' | 'providers';

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
          <span className="ico" aria-hidden>≡</span>Menu
        </button>
      )}
      {MAIN.slice(0, 3).map((n) => (
        <button key={n.id} className={`nav-item${route === n.id ? ' active' : ''}`} onClick={() => go(n.id)} aria-current={route === n.id ? 'page' : undefined}>
          <span className="ico" aria-hidden>{n.icon}</span>{n.label}
        </button>
      ))}
      <div className="nav-label">Your Music</div>
      {MAIN.slice(3).map((n) => (
        <button key={n.id} className={`nav-item${route === n.id ? ' active' : ''}`} onClick={() => go(n.id)} aria-current={route === n.id ? 'page' : undefined}>
          <span className="ico" aria-hidden>{n.icon}</span>{n.label}
        </button>
      ))}
      <div className="nav-label">Playlists</div>
      <button className="nav-item" onClick={onCreatePlaylist}>＋ Create Playlist</button>
      {playlists.slice(0, 8).map((p) => (
        <button key={p.id} className={`nav-item${route === 'playlist' ? '' : ''}`} onClick={() => go('playlists')} title={p.name}>
          <span className="ico" aria-hidden>♪</span>
          <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.name}</span>
        </button>
      ))}
      <div style={{ flex: 1 }} />
      <div className="nav-label">System</div>
      <button className={`nav-item${route === 'settings' ? ' active' : ''}`} onClick={() => go('settings')}><span className="ico" aria-hidden>⚙︎</span>Settings</button>
      <button className={`nav-item${route === 'storage' ? ' active' : ''}`} onClick={() => go('storage')}><span className="ico" aria-hidden>▤</span>Storage</button>
      <button className={`nav-item${route === 'about' ? ' active' : ''}`} onClick={() => go('about')}><span className="ico" aria-hidden>ⓘ</span>About</button>
    </aside>
  );
}

/**
 * Legacy global header (pre-§9). Unused — the search input now lives ONLY
 * inside the dedicated Search tab (SearchScreen). Kept exported so existing
 * imports don't break; do not render it in the app shell.
 */
export function TopBar({ query, setQuery, onOpenSettings, offlineMode }: {
  query: string; setQuery: (q: string) => void; onOpenSettings: () => void; offlineMode: boolean;
}) {
  return (
    <header className="topbar">
      <div className="search-input" role="search">
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
      <div style={{ flex: 1 }} />
      <span className={`status-pill${offlineMode ? ' offline' : ' online'}`} role="status" aria-label={offlineMode ? 'Offline mode on' : 'Online'}>
        <span className="dot" aria-hidden />{offlineMode ? 'Offline' : 'Online'}
      </span>
      <button className="icon-btn" onClick={onOpenSettings} aria-label="Open settings" title="Settings">⚙︎</button>
    </header>
  );
}

export function BottomNav({ route, go, onOpenMenu }: { route: Route; go: (r: Route) => void; onOpenMenu: () => void }) {
  // Primary mobile nav: Home, Search, Menu, Radio, Library — five evenly
  // spaced tabs sharing one icon style (20px glyph + 11px label via CSS).
  // Search is a real route (same SearchScreen as sidebar/Ctrl+K). Menu opens
  // the NavDrawer overlay — never navigates — so it gets no "selected" state.
  const items: { id: Route; label: string; icon: string }[] = [
    { id: 'home', label: 'Home', icon: '⌂' },
    { id: 'search', label: 'Search', icon: '⌕' },
    { id: 'radio', label: 'Radio', icon: '◉' },
    { id: 'library', label: 'Library', icon: '♫' },
  ];
  const renderTab = (n: { id: Route; label: string; icon: string }) => (
    <button
      key={n.id}
      type="button"
      onClick={() => go(n.id)}
      className={route === n.id ? 'active' : ''}
      aria-current={route === n.id ? 'page' : undefined}
    >
      <div style={{ fontSize: 20 }} aria-hidden>{n.icon}</div>{n.label}
    </button>
  );
  return (
    <nav className="bottom-nav" aria-label="Primary">
      {renderTab(items[0])}
      {renderTab(items[1])}
      <button type="button" onClick={onOpenMenu} aria-haspopup="dialog" aria-label="Open menu">
        <div style={{ fontSize: 20 }} aria-hidden>≡</div>Menu
      </button>
      {renderTab(items[2])}
      {renderTab(items[3])}
    </nav>
  );
}
