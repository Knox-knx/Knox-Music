import React, { useEffect, useRef } from 'react';
import { APP_NAME, APP_TAGLINE, APP_VERSION } from '../appVersion';
import type { Route } from './navigation';

export type DrawerItem = { id: Route; label: string; icon: string };

/**
 * Drawer menu items — data-driven list (Spec §9.1 step 4), not hardcoded to
 * exactly two rows. Insert future items (Help, Privacy, …) here.
 */
export const DRAWER_ITEMS: DrawerItem[] = [
  { id: 'settings', label: 'Settings', icon: '⚙︎' },
  { id: 'about', label: 'About', icon: 'ⓘ' },
];

/**
 * NavDrawer — left-side sidebar overlay (Spec §9).
 * Overlay only: opening/closing never touches route, scroll position, or the
 * player store, so the screen behind it is undisturbed (§9.3).
 */
export function NavDrawer({ open, onClose, go, items = DRAWER_ITEMS }: {
  open: boolean;
  onClose: () => void;
  go: (r: Route) => void;
  items?: DrawerItem[];
}) {
  const panelRef = useRef<HTMLElement>(null);
  const touchX = useRef<number | null>(null);

  // Escape closes; focus the first item on open for keyboard users.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey);
    const id = requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>('.knox-drawer-item')?.focus();
    });
    return () => {
      window.removeEventListener('keydown', onKey);
      cancelAnimationFrame(id);
    };
  }, [open, onClose]);

  // Fully unmounted while closed — never a lingering invisible click-blocker,
  // never a scroll/player reset on the screen behind it.
  if (!open) return null;

  return (
    <div className="knox-drawer-root" role="dialog" aria-modal="true" aria-label="Menu">
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
        <div className="knox-drawer-header">
          <span className="knox-drawer-mark" aria-hidden>
            <img src="/icons/icon-192.png" alt="" width={40} height={40} />
          </span>
        </div>
        <nav aria-label="Menu items">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              className="knox-drawer-item"
              onClick={() => { onClose(); go(item.id); }}
            >
              <span className="knox-drawer-ico" aria-hidden>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="knox-drawer-spacer" aria-hidden />
        <hr className="knox-drawer-divider" />
        <div className="knox-drawer-footer-line">
          <span className="knox-drawer-footer-name">{APP_NAME}</span>
          <span className="knox-drawer-footer-version">v{APP_VERSION}</span>
        </div>
        <hr className="knox-drawer-divider" />
        <div className="knox-drawer-footer-line stacked">
          <span className="knox-drawer-footer-name">{APP_NAME}</span>
          <span className="knox-drawer-footer-tagline">{APP_TAGLINE}</span>
        </div>
      </aside>
    </div>
  );
}
