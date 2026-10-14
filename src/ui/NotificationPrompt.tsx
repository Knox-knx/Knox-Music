// Playback notification UX — explainer-first prompt + persistent banner.
//
// Explainer: shown once per install on first playback, BEFORE any OS dialog.
// [Allow] fires Notification.requestPermission() inside the tap gesture;
// [Not now] records the deferral — the OS is never asked automatically.
// Banner: when permission is denied, playback keeps working and this
// dismissible banner links to settings instead of re-prompting.

import React, { useEffect, useState } from 'react';
import { usePlayer } from '../audio/playerStore';
import {
  usePlaybackNotice,
  notificationPermission,
  refreshNativeNotificationState,
  requestPlaybackNotificationPermission,
  deferPlaybackNotificationPermission,
  openNotificationSettings,
} from '../os/playbackNotifications';
import { isTauriAndroid } from '../os/nativeMedia';
import { toast } from './toast';
import { Icon } from './icons';

export function NotificationExplainer() {
  const open = usePlaybackNotice((s) => s.explainerOpen);
  if (!open) return null;
  return (
    <div className="now-playing" role="dialog" aria-modal="true" aria-label="Allow playback notifications">
      <div className="now-playing-card glass" style={{ textAlign: 'left', maxWidth: 440 }} onClick={(e) => e.stopPropagation()}>
        <div style={{ color: 'var(--accent-gold)' }} aria-hidden><Icon name="bell" size={30} /></div>
        <h2 style={{ margin: '10px 0 6px', fontSize: 19 }}>Control playback from anywhere?</h2>
        <p style={{ color: 'var(--text-2)', fontSize: 13.5, margin: '0 0 6px' }}>
          Allow notifications to control playback from your lock screen and other apps.
        </p>
        <p style={{ color: 'var(--text-3)', fontSize: 12, margin: '0 0 16px' }}>
          Music keeps playing either way — this only enables alerts and system controls.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="btn" onClick={() => deferPlaybackNotificationPermission()}>
            Not now
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              void requestPlaybackNotificationPermission().then((p) => {
                if (p === 'denied') toast('Notifications blocked — you can enable them later in App permissions.', 'warn');
              });
            }}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}

export function NotificationDeniedBanner({ onOpenPermissions }: { onOpenPermissions: () => void }) {
  const dismissed = usePlaybackNotice((s) => s.bannerDismissed);
  const dismiss = usePlaybackNotice((s) => s.dismissBanner);
  const current = usePlayer((s) => s.current);
  const [nativeDenied, setNativeDenied] = useState(false);
  // Android native state is observed asynchronously (no Web Notifications
  // API in the WebView) — refresh while something is playing.
  useEffect(() => {
    if (!current || !isTauriAndroid()) return;
    let live = true;
    void refreshNativeNotificationState()
      .then((s) => { if (live) setNativeDenied(s === 'denied'); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [current]);
  // Only relevant while there is something to control — and only when the
  // OS actually reports a denial (not prompt, not unsupported).
  if (!current || dismissed) return null;
  let denied = nativeDenied;
  try {
    denied = denied || notificationPermission() === 'denied';
  } catch {
    /* keep native verdict */
  }
  if (!denied) return null;
  return (
    <div
      role="status"
      style={{
        display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
        margin: '8px 26px 0', padding: '10px 14px', borderRadius: 14, fontSize: 13,
        background: 'var(--glass-bg)', border: '1px solid var(--glass-border)',
      }}
    >
      <span aria-hidden><Icon name="bellOff" size={15} /></span>
      <span style={{ flex: 1, minWidth: 200 }}>
        Turn on notifications to control playback without opening the app.
      </span>
      <button
        className="btn" style={{ padding: '6px 14px', fontSize: 12.5 }}
        onClick={() => {
          void openNotificationSettings().then((guidance) => {
            if (guidance) toast(guidance, 'warn');
          });
        }}
      >
        Open settings
      </button>
      <button
        className="btn" style={{ padding: '6px 14px', fontSize: 12.5 }}
        onClick={onOpenPermissions}
      >
        App permissions
      </button>
      <button
        className="icon-btn" style={{ width: 28, height: 28, fontSize: 13 }}
        onClick={dismiss} aria-label="Dismiss notification banner"
      >
        <Icon name="close" size={13} />
      </button>
    </div>
  );
}
