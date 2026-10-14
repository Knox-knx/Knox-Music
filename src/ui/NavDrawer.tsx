import React, { useEffect, useRef } from 'react';
import { APP_NAME, APP_TAGLINE, APP_VERSION } from '../appVersion';
import { useSettings, type UIStyle } from '../settings/settingsStore';
import { toast } from './toast';
import type { Route } from './navigation';
import { Glyph } from './icons';

export type DrawerItem = { id: Route; label: string; icon: string };

const UI_STYLE_OPTIONS: { id: UIStyle; label: string; badge: string }[] = [
  { id: 'glassmorphism', label: 'Glass 3D', badge: '◈' },
  { id: 'spatial_ui', label: 'Spatial 3D', badge: '✦' },
  { id: 'neomorphism', label: 'Neomorph 3D', badge: '◎' },
  { id: 'claymorphism', label: 'Clay 3D', badge: '◉' },
  { id: 'neubrutalism', label: 'Brutal 3D', badge: '★' },
  { id: 'pixel_art', label: 'Pixel 3D', badge: '▣' },
];

/**
 * Drawer menu items — data-driven list (Spec §9.1 step 4), not hardcoded to
 * exactly two rows. Insert future items (Help, Privacy, …) here.
 */
export const DRAWER_ITEMS: DrawerItem[] = [
  { id: 'settings', label: 'Settings', icon: '⚙︎' },
  { id: 'permissions', label: 'App permissions', icon: '✓' },
  { id: 'about', label: 'About', icon: 'ⓘ' },
];

const PRIMARY_NAV: DrawerItem[] = [
  { id: 'home', label: 'Home', icon: '⌂' },
  { id: 'search', label: 'Search', icon: '⌕' },
  { id: 'radio', label: 'Radio', icon: '◉' },
  { id: 'library', label: 'Library', icon: '♫' },
];

/**
 * NavDrawer — left-side sidebar overlay (Spec §9 + build-brief §2.2).
 * Overlay only: opening/closing never touches route, scroll position, or the
 * player store, so the screen behind it is undisturbed (§9.3).
 *
 * Layout: header block (gold tile + serif name + version) → primary nav →
 * library management (with subtitles, wired to the scan pipeline) → app
 * section (chevrons) → footer tagline. Panel uses --bg-base over a dimmed
 * scrim (existing dim behavior kept, contents restyled).
 */
export function NavDrawer({ open, onClose, go, route, items = DRAWER_ITEMS }: {
  open: boolean;
  onClose: () => void;
  go: (r: Route) => void;
  route?: Route;
  items?: DrawerItem[];
}) {
  const panelRef = useRef<HTMLElement>(null);
  const touchX = useRef<number | null>(null);
  const uiStyle = useSettings((s) => s.uiStyle) || 'glassmorphism';
  const patchSettings = useSettings((s) => s.patch);

  // Escape closes; focus the first item on open for keyboard users.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    const id = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>('.knox-drawer-nav-row')?.focus();
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(id);
    };
  }, [open, onClose]);

  // Fully unmounted while closed — never a lingering invisible click-blocker,
  // never a scroll/player reset on the screen behind it.
  if (!open) return null;

  const fireLibraryAction = (name: 'knox:add-files' | 'knox:add-folder' | 'knox:scan-device') => {
    // LibraryScreen listens for these when mounted; otherwise fall back to
    // opening the Library tab first so the action has a visible target.
    onClose();
    const target = route === 'library' ? null : ('library' as Route);
    if (target) go(target);
    window.setTimeout(() => window.dispatchEvent(new CustomEvent(name)), target ? 120 : 0);
  };

  const renderRow = (
    key: string,
    glyph: string,
    label: string,
    sub: string | undefined,
    opts: { current?: boolean; chevron?: boolean; onClick: () => void; ariaLabel?: string },
  ) => (
    <button
      key={key}
      type="button"
      className={`knox-drawer-nav-row${opts.current ? ' current' : ''}`}
      aria-current={opts.current ? 'page' : undefined}
      aria-label={opts.ariaLabel ?? label}
      onClick={opts.onClick}
    >
      <span className="knox-icon-tile sm" aria-hidden><Glyph char={glyph} size={17} /></span>
      <span className="knox-drawer-row-text">
        <span className="knox-drawer-row-label">{label}</span>
        {sub && <span className="knox-drawer-row-sub">{sub}</span>}
      </span>
      {opts.chevron && <span className="knox-drawer-chevron" aria-hidden>›</span>}
    </button>
  );

  return (
    <div className="knox-drawer-root" role="dialog" aria-modal="true" aria-label="Menu" data-no-swipe="true">
      <div
        className="knox-drawer-scrim"
        onClick={onClose}
        aria-label="Close menu"
        role="button"
        tabIndex={-1}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClose(); }}
      />
      <aside
        ref={panelRef}
        className="knox-drawer-panel"
        aria-label={`${APP_NAME} menu`}
        onTouchStart={(e) => { touchX.current = e.touches[0].clientX; }}
        onTouchEnd={(e) => {
          if (touchX.current === null) return;
          const dx = e.changedTouches[0].clientX - touchX.current;
          touchX.current = null;
          if (dx < -60) onClose();
        }}
      >
        {/* Header block: safe-area cleared below OS status bar clock */}
        <div className="knox-drawer-brand">
          <span className="knox-icon-tile sm" aria-hidden style={{ background: 'transparent', width: 38, height: 38 }}>
            <img src="/icons/icon-192.png" alt="" width={34} height={34} style={{ width: 34, height: 34, objectFit: 'cover', borderRadius: 8 }} />
          </span>
          <span className="knox-drawer-brand-titles">
            <span className="knox-drawer-brand-name" style={{ display: 'block', fontSize: 16 }}>{APP_NAME}</span>
            <span className="knox-drawer-brand-version" style={{ display: 'block', fontSize: 11 }}>v{APP_VERSION}</span>
          </span>
        </div>

        {/* Primary navigation */}
        <nav aria-label="Primary">
          <p className="knox-drawer-section-label">Browse</p>
          {PRIMARY_NAV.map((item) => renderRow(item.id, item.icon, item.label, undefined, {
            current: route === item.id,
            onClick: () => { onClose(); go(item.id); },
          }))}
        </nav>

        {/* Library management */}
        <nav aria-label="Library management">
          <p className="knox-drawer-section-label">Your library</p>
          {renderRow('add-files', '＋', 'Add files', undefined, {
            onClick: () => fireLibraryAction('knox:add-files'),
          })}
          {renderRow('add-folder', '▤', 'Add folder', undefined, {
            onClick: () => fireLibraryAction('knox:add-folder'),
          })}
          {renderRow('scan-device', '◉', 'Scan device for music', undefined, {
            onClick: () => fireLibraryAction('knox:scan-device'),
          })}
        </nav>

        {/* App section */}
        <nav aria-label="App">
          <p className="knox-drawer-section-label">App</p>
          {items.map((item) => renderRow(item.id, item.icon, item.label, undefined, {
            current: route === item.id,
            chevron: true,
            onClick: () => { onClose(); go(item.id); },
          }))}
        </nav>

        {/* Quick 3D UI Style Switcher */}
        <section aria-label="3D UI Style" style={{ padding: '2px 12px 8px' }}>
          <p className="knox-drawer-section-label" style={{ padding: '6px 2px 6px' }}>3D UI Style</p>
          <div className="knox-drawer-ui-grid" role="radiogroup" aria-label="Choose 3D UI Style">
            {UI_STYLE_OPTIONS.map((opt) => {
              const active = uiStyle === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  className={`knox-drawer-ui-pill knox-ui-pill-${opt.id}${active ? ' active' : ''}`}
                  onClick={() => {
                    void patchSettings({ uiStyle: opt.id });
                    toast(`3D UI: ${opt.label}`);
                  }}
                >
                  <span className="knox-drawer-ui-badge" aria-hidden>{opt.badge}</span>
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>
        </section>

        <div className="knox-drawer-spacer" aria-hidden />
        <div className="knox-drawer-footer">{APP_TAGLINE}</div>
      </aside>
    </div>
  );
}
