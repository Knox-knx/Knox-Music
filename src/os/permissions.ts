// Unified permission registry — every OS grant a music app needs, one audit
// surface (Settings → "App permissions").
//
// Request timing is just-in-time, never all-on-launch:
//   media/files   → the folder/file picker IS the grant (web); native media
//                   permission on Tauri Android via the bridge.
//   folders       → persisted directory grants (folderGrants.ts); re-prompt
//                   ONLY when the OS revoked a stored grant.
//   notifications → first track play, explainer first (playbackNotifications).
//   battery       → optional Settings action with explanation; playback works
//                   without it via the OS media session.
// Denials never block playback and never re-prompt by themselves — each row
// carries its own deep link / re-request action. Statuses: granted | denied
// | partial | prompt | unknown | unavailable (platform cannot offer it).

import { useScanner } from '../library/scanner';
import { listFolderGrants, folderAccessApiSupported } from '../library/folderGrants';
import {
  notificationPermission,
  notificationsSupported,
  refreshNativeNotificationState,
  isIOS,
  requestPlaybackNotificationPermission,
  openNotificationSettings,
} from './playbackNotifications';
import { queryNativePermissionStates, requestNativeBatteryExemption, isTauriAndroid } from './nativeMedia';
import { isTauri } from '../desktop/detector';
import { logger } from '../core/logger';
import { toast } from '../ui/toast';

export type PermissionStatus = 'granted' | 'denied' | 'partial' | 'prompt' | 'unknown' | 'unavailable';

export type PermissionId =
  | 'media'
  | 'folders'
  | 'partial-selection'
  | 'notifications'
  | 'battery'
  | 'background';

export interface PermissionRow {
  id: PermissionId;
  title: string;
  blurb: string;
  status: PermissionStatus;
  statusHint: string;
  /** Request/re-grant action (omit when the platform offers none). */
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
  /** Deep link to the relevant OS settings page. */
  settingsLabel?: string;
  onOpenSettings?: () => void | Promise<void>;
}

async function openAppSettingsFallback(): Promise<void> {
  try {
    const { openNativeAppSettings } = await import('./nativeMedia');
    await openNativeAppSettings();
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Open the OS Settings app → Apps → KNOX Music.', 'warn');
  }
}

/** Media/files grant state. Native answer wins on Tauri mobile; the web
 *  File-System picker state (scanner store) is the fallback. */
async function mediaStatus(): Promise<{ status: PermissionStatus; hint: string }> {
  try {
    const native = await queryNativePermissionStates();
    const m = native.media ?? native['media-audio'];
    if (m === 'granted' || m === 'denied' || m === 'partial') {
      return {
        status: m,
        hint:
          m === 'partial'
            ? 'Only some files were shared — manage the selection to add more.'
            : m === 'granted'
              ? 'The app can read audio files on this device.'
              : 'Music access is off — the library can only show already-added files.',
      };
    }
  } catch {
    /* bridge unavailable — fall through to web state */
  }
  try {
    const p = useScanner.getState().permission;
    if (p === 'granted') return { status: 'granted', hint: 'A music folder or files were shared with the app.' };
    if (p === 'denied') return { status: 'denied', hint: 'Music access was denied — only already-added files are visible.' };
  } catch {
    /* store not ready */
  }
  return { status: 'prompt', hint: 'Not asked yet — pick a folder to grant access.' };
}

/** Persisted folder grants: granted (≥1 live), prompt (none), stale (all
 *  revoked). Partial is reported separately (file-picks only). */
async function foldersStatus(): Promise<{ status: PermissionStatus; hint: string; live: number; stale: number }> {
  if (!folderAccessApiSupported()) {
    return { status: 'unavailable', hint: 'This browser cannot persist folder access — picks last for this session only.', live: 0, stale: 0 };
  }
  const grants = await listFolderGrants();
  const live = grants.filter((g) => g.liveness === 'live').length;
  const stale = grants.filter((g) => g.liveness === 'stale').length;
  if (live > 0) {
    return {
      status: 'granted',
      hint: `${live} folder${live === 1 ? '' : 's'} stay available across restarts — no re-prompt needed.`,
      live, stale,
    };
  }
  if (stale > 0) {
    return {
      status: 'prompt',
      hint: `${stale} saved folder${stale === 1 ? '' : 's'} lost OS access — re-confirm to restore.`,
      live, stale,
    };
  }
  return { status: 'prompt', hint: 'No folder saved yet — picks are asked for when you add music.', live, stale };
}

/**
 * Query every row. Never throws — an unresolvable row reports 'unknown'
 * with an honest hint, never a fake grant.
 */
export async function queryPermissionRows(): Promise<PermissionRow[]> {
  const tauri = isTauri();
  const [media, folders] = await Promise.all([mediaStatus(), foldersStatus()]);

  // Partial (limited) media selection: only the native layer can observe
  // Android 14+ limited access. Elsewhere it is honestly 'unavailable'.
  let partial: PermissionRow;
  try {
    const native = await queryNativePermissionStates();
    if (native['partial-selection'] === 'partial' || native['partial-selection'] === 'granted') {
      partial = {
        id: 'partial-selection',
        title: 'Limited media selection',
        blurb: 'Android can share only selected audio files instead of the whole library.',
        status: native['partial-selection'],
        statusHint:
          native['partial-selection'] === 'partial'
            ? 'You’ve only shared some files — manage the selection to add more.'
            : 'Full media access is granted.',
        actionLabel: 'Manage selection',
        onAction: () => { window.dispatchEvent(new CustomEvent('knox:scan-device')); },
        settingsLabel: 'App settings',
        onOpenSettings: () => void openAppSettingsFallback(),
      };
    } else if (tauri) {
      partial = {
        id: 'partial-selection', title: 'Limited media selection',
        blurb: 'Android can share only selected audio files instead of the whole library.',
        status: 'unknown', statusHint: 'The host did not report a selection state.',
        settingsLabel: 'App settings', onOpenSettings: () => void openAppSettingsFallback(),
      };
    } else {
      partial = {
        id: 'partial-selection', title: 'Limited media selection',
        blurb: 'Android can share only selected audio files instead of the whole library.',
        status: 'unavailable',
        statusHint: 'Not applicable on web — every folder/file pick is already an explicit, limited share.',
      };
    }
  } catch {
    partial = {
      id: 'partial-selection', title: 'Limited media selection',
      blurb: 'Android can share only selected audio files instead of the whole library.',
      status: 'unknown', statusHint: 'Could not reach the host permission service.',
      settingsLabel: 'App settings', onOpenSettings: () => void openAppSettingsFallback(),
    };
  }

  // Notifications. Android native path first: the lock-screen/shade card
  // IS a notification there, so the row reports the real POST_NOTIFICATIONS
  // state (the Web Notifications API doesn't exist in the WebView).
  let notifications: PermissionRow;
  if (isTauriAndroid()) {
    const s = await refreshNativeNotificationState().catch(() => 'default' as const);
    const openSettings = () => { void openNotificationSettings().then((g) => { if (g) toast(g, 'warn'); }); };
    if (s === 'granted') {
      notifications = {
        id: 'notifications', title: 'Notifications',
        blurb: 'Lock-screen, shade and headset controls via the system now-playing card, plus download alerts.',
        status: 'granted', statusHint: 'System playback controls and alerts are allowed.',
        settingsLabel: 'App settings', onOpenSettings: openSettings,
      };
    } else if (s === 'denied') {
      notifications = {
        id: 'notifications', title: 'Notifications',
        blurb: 'Playback works fully without this — the lock-screen/shade card and alerts are the only loss.',
        status: 'denied', statusHint: 'Blocked. Playback is unaffected; system controls and alerts are off.',
        actionLabel: 'Ask again',
        onAction: () => { void requestPlaybackNotificationPermission(); },
        settingsLabel: 'Turn on in settings', onOpenSettings: openSettings,
      };
    } else {
      notifications = {
        id: 'notifications', title: 'Notifications',
        blurb: 'Asked once, on first playback, with an explanation first — never at launch.',
        status: 'prompt', statusHint: 'Not asked yet.',
        actionLabel: 'Ask now',
        onAction: () => { void requestPlaybackNotificationPermission(); },
      };
    }
  } else if (!notificationsSupported()) {
    notifications = {
      id: 'notifications', title: 'Notifications',
      blurb: 'Alert-style notifications only (e.g. “Download complete”). Transport controls need no permission.',
      status: 'unavailable', statusHint: 'This build cannot post notifications.',
    };
  } else {
    const p = notificationPermission();
    if (p === 'granted') {
      notifications = {
        id: 'notifications', title: 'Notifications',
        blurb: 'Alert-style notifications only (e.g. “Download complete”). Transport controls need no permission.',
        status: 'granted', statusHint: 'Download and status alerts are allowed.',
        settingsLabel: 'App settings', onOpenSettings: () => { void openNotificationSettings().then((g) => { if (g) toast(g, 'warn'); }); },
      };
    } else if (p === 'denied') {
      notifications = {
        id: 'notifications', title: 'Notifications',
        blurb: 'Playback works fully without this — alerts are the only loss.',
        status: 'denied', statusHint: 'Blocked. Playback is unaffected; alerts are off.',
        settingsLabel: 'Turn on in settings', onOpenSettings: () => { void openNotificationSettings().then((g) => { if (g) toast(g, 'warn'); }); },
      };
    } else {
      notifications = {
        id: 'notifications', title: 'Notifications',
        blurb: 'Asked once, on first playback, with an explanation first — never at launch.',
        status: 'prompt', statusHint: 'Not asked yet.',
        actionLabel: 'Ask now',
        onAction: () => { void requestPlaybackNotificationPermission(); },
      };
    }
  }
  if (isIOS() && notifications.status !== 'granted') {
    notifications.blurb += ' On iOS, lock-screen and Control Center controls work without this permission.';
  }

  // Battery exemption (Android-only request; optional, playback works without).
  let battery: PermissionRow;
  if (!tauri) {
    battery = {
      id: 'battery', title: 'Background playback protection',
      blurb: 'Optional. Prevents the system from stopping playback with the screen off. The media session keeps playback alive without it on most devices.',
      status: 'unavailable', statusHint: 'Browsers offer no battery-exemption grant.',
    };
  } else {
    let nativeState: string | undefined;
    try {
      nativeState = (await queryNativePermissionStates()).battery;
    } catch {
      nativeState = undefined;
    }
    if (nativeState === 'granted') {
      battery = {
        id: 'battery', title: 'Background playback protection',
        blurb: 'The system will not stop playback with the screen off.',
        status: 'granted', statusHint: 'Exemption granted.',
        settingsLabel: 'Battery settings', onOpenSettings: () => void openAppSettingsFallback(),
      };
    } else {
      battery = {
        id: 'battery', title: 'Background playback protection',
        blurb: 'Optional — playback still works via the media session, but the OS may pause it to save power.',
        status: nativeState === 'denied' ? 'denied' : 'prompt',
        statusHint: nativeState === 'denied' ? 'Exemption refused — playback may pause in background.' : 'Not requested. Requesting is optional.',
        actionLabel: 'Request exemption',
        onAction: () => {
          void (async () => {
            try {
              const ok = await requestNativeBatteryExemption();
              toast(ok ? 'Battery exemption requested' : 'Exemption request did not start', ok ? undefined : 'warn');
            } catch (e) {
              toast(e instanceof Error ? e.message : 'Exemption is not available on this build.', 'warn');
            }
          })();
        },
        settingsLabel: 'Battery settings', onOpenSettings: () => void openAppSettingsFallback(),
      };
    }
  }

  // Background audio mode.
  let background: PermissionRow;
  if (!tauri) {
    let session = false;
    try {
      session = typeof navigator !== 'undefined' && 'mediaSession' in navigator;
    } catch {
      session = false;
    }
    background = {
      id: 'background', title: 'Background audio',
      blurb: 'Playback continues when the tab is hidden or the screen locks, driven by the OS media session.',
      status: session ? 'granted' : 'unavailable',
      statusHint: session ? 'Active — the media session keeps audio alive in background.' : 'Media Session API is unavailable in this browser.',
    };
  } else if (isTauriAndroid()) {
    // Live native health: the bridge must be reachable AND the foreground
    // service must have received a snapshot recently. Anything else names
    // the concrete failure so "music stops in background" is diagnosable
    // from this screen instead of a guess.
    let status: { label: PermissionStatus; hint: string };
    try {
      const { queryNativeMediaStatus } = await import('./nativeMedia');
      const st = await queryNativeMediaStatus();
      const ago = typeof st?.lastSyncAgoMs === 'number' ? st.lastSyncAgoMs : -1;
      const fresh = ago >= 0 && ago < 30000;
      if (st && st.bridge === 'ok' && st.serviceRunning === true && fresh) {
        status = {
          label: 'granted',
          hint: `Background service running — last update ${Math.round(ago / 1000)}s ago (${st.syncCount ?? 0} updates).`,
        };
      } else if (st && st.bridge === 'ok' && st.serviceRunning === true) {
        status = {
          label: 'prompt',
          hint: 'Service is installed but has no recent playback — play a track, then recheck.',
        };
      } else if (st && st.bridge === 'ok') {
        status = {
          label: 'denied',
          hint: `Playback service is not running${st.lastError ? ` (${st.lastError.slice(0, 120)})` : ''}. Grant the battery exemption below so the OS cannot kill it.`,
        };
      } else {
        status = {
          label: 'unknown',
          hint: 'Could not reach the native media bridge — play a track, then recheck. If this persists, reinstall the latest APK.',
        };
      }
    } catch {
      status = { label: 'unknown', hint: 'Could not reach the native media bridge.' };
    }
    background = {
      id: 'background', title: 'Background audio',
      blurb: 'Foreground playback service + lock-screen controls keep music playing when you leave the app.',
      status: status.label, statusHint: status.hint,
      actionLabel: 'Request exemption',
      onAction: () => {
        void (async () => {
          try {
            const { requestNativeBatteryExemption } = await import('./nativeMedia');
            const ok = await requestNativeBatteryExemption();
            toast(ok ? 'Battery exemption requested' : 'Exemption request did not start', ok ? undefined : 'warn');
          } catch (e) {
            toast(e instanceof Error ? e.message : 'Exemption is not available on this build.', 'warn');
          }
        })();
      },
      settingsLabel: 'App settings', onOpenSettings: () => void openAppSettingsFallback(),
    };
  } else {
    let nativeState: string | undefined;
    try {
      nativeState = (await queryNativePermissionStates()).background;
    } catch {
      nativeState = undefined;
    }
    background = {
      id: 'background', title: 'Background audio',
      blurb: 'Android mediaPlayback service type + iOS audio background mode keep playback alive when backgrounded.',
      status: nativeState === 'granted' ? 'granted' : 'unknown',
      statusHint: nativeState === 'granted' ? 'Background audio mode is active.' : 'The host did not confirm background-audio mode.',
      settingsLabel: 'App settings', onOpenSettings: () => void openAppSettingsFallback(),
    };
  }

  return [
    {
      id: 'media', title: 'Music & audio files',
      blurb: 'Read audio files on this device (Android 13+: audio only · older: storage · iOS: media library).',
      status: media.status, statusHint: media.hint,
      actionLabel: media.status === 'granted' ? 'Add more music' : 'Choose music folder',
      onAction: () => { window.dispatchEvent(new CustomEvent('knox:scan-device')); },
      settingsLabel: 'App settings', onOpenSettings: () => void openAppSettingsFallback(),
    },
    {
      id: 'folders', title: 'Saved folders',
      blurb: 'Folders you picked stay accessible across restarts — re-prompting only happens if the OS revokes one.',
      status: folders.status, statusHint: folders.hint,
      ...(folders.stale > 0
        ? { actionLabel: 'Re-confirm folders', onAction: () => { window.dispatchEvent(new CustomEvent('knox:scan-device')); } }
        : {}),
      settingsLabel: 'App settings', onOpenSettings: () => void openAppSettingsFallback(),
    },
    partial,
    notifications,
    battery,
    background,
  ];
}

/** One-line summary for badges: denied count + whether action is needed. */
export async function permissionSummary(): Promise<{ denied: number; prompt: number; total: number }> {
  try {
    const rows = await queryPermissionRows();
    const actionable = rows.filter((r) => r.status !== 'unavailable' && r.status !== 'unknown');
    return {
      denied: actionable.filter((r) => r.status === 'denied').length,
      prompt: actionable.filter((r) => r.status === 'prompt').length,
      total: actionable.length,
    };
  } catch {
    logger.warn('permissions', 'summary query failed');
    return { denied: 0, prompt: 0, total: 0 };
  }
}
