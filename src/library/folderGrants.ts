// Persisted folder access — the web equivalent of Android SAF persisted URI
// grants and iOS/macOS security-scoped bookmarks.
//
// When the user picks a folder via "Add folder" / "Scan device", the File
// System Access directory handle is stored in IndexedDB (handles are
// structured-cloneable). On restart, each grant is re-queried WITHOUT
// prompting (`queryPermission`): a still-granted folder is usable silently,
// a revoked one is marked stale and ONLY then does the UI offer a
// re-prompt button. Re-prompting for a folder the user already granted is
// a bug — this module is what prevents it.
//
// File-picker selections ("Add files") are NOT persistable by design — the
// browser grants one-shot access. A library built only from file picks is
// therefore reported as *partial* access (see permissions.ts), distinct
// from a full denial.

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { logger } from '../core/logger';

/** Minimal structural view of a File System Access directory handle. */
export interface DirectoryGrantHandle {
  kind: 'directory';
  name: string;
  queryPermission?: (opts?: { mode?: string }) => Promise<PermissionState>;
  requestPermission?: (opts?: { mode?: string }) => Promise<PermissionState>;
}

export interface FolderGrant {
  /** Stable key: `name` + first-seen timestamp (handles carry no id). */
  id: string;
  name: string;
  addedAt: number;
  lastSeenAt: number;
  handle: DirectoryGrantHandle;
}

export type GrantLiveness = 'live' | 'stale' | 'unavailable';

export interface FolderGrantStatus extends FolderGrant {
  liveness: GrantLiveness;
}

const DB_NAME = 'knox-folder-grants';
const VERSION = 1;

interface GrantDB extends DBSchema {
  grants: { key: string; value: FolderGrant };
}

let dbPromise: Promise<IDBPDatabase<GrantDB>> | null = null;

function db(): Promise<IDBPDatabase<GrantDB>> {
  if (!dbPromise) {
    dbPromise = openDB<GrantDB>(DB_NAME, VERSION, {
      upgrade(d) {
        if (!d.objectStoreNames.contains('grants')) {
          d.createObjectStore('grants', { keyPath: 'id' });
        }
      },
    });
  }
  return dbPromise;
}

export function folderAccessApiSupported(): boolean {
  try {
    return typeof window !== 'undefined' && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
  } catch {
    return false;
  }
}

/** Persist a freshly-picked directory grant. Never throws. */
export async function saveDirectoryGrant(handle: DirectoryGrantHandle, label?: string): Promise<void> {
  try {
    const name = label || handle.name || 'Music folder';
    const id = `${name}::${Date.now()}`;
    const row: FolderGrant = { id, name, addedAt: Date.now(), lastSeenAt: Date.now(), handle };
    await (await db()).put('grants', row);
    logger.info('permissions', `folder grant saved (${name})`);
  } catch (e) {
    logger.warn('permissions', 'could not persist folder grant', String(e));
  }
}

/** All stored grants with live permission state (no prompts issued). */
export async function listFolderGrants(): Promise<FolderGrantStatus[]> {
  try {
    const rows = await (await db()).getAll('grants');
    const out: FolderGrantStatus[] = [];
    for (const row of rows) {
      let liveness: GrantLiveness = 'unavailable';
      try {
        const q = await row.handle?.queryPermission?.({ mode: 'read' });
        liveness = q === 'granted' ? 'live' : q === 'denied' ? 'stale' : 'stale';
      } catch {
        liveness = 'unavailable';
      }
      out.push({ ...row, liveness });
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * Boot restore: touch lastSeenAt on live grants, drop rows whose handle no
 * longer deserializes. Returns live grants. Never prompts, never throws.
 */
export async function restoreFolderGrants(): Promise<FolderGrant[]> {
  try {
    const grants = await listFolderGrants();
    const live = grants.filter((g) => g.liveness === 'live');
    const d = await db();
    await Promise.allSettled(
      live.map((g) => d.put('grants', { ...g, lastSeenAt: Date.now() })),
    );
    return live;
  } catch {
    return [];
  }
}

/** Re-request a stale grant (user gesture). Returns the new state. */
export async function reRequestGrant(id: string): Promise<GrantLiveness> {
  try {
    const row = await (await db()).get('grants', id);
    if (!row?.handle?.requestPermission) return 'unavailable';
    const out = await row.handle.requestPermission({ mode: 'read' });
    if (out === 'granted') {
      await (await db()).put('grants', { ...row, lastSeenAt: Date.now() });
      return 'live';
    }
    return 'stale';
  } catch {
    return 'unavailable';
  }
}

/** Forget one grant (user-initiated). Never throws. */
export async function forgetGrant(id: string): Promise<void> {
  try {
    await (await db()).delete('grants', id);
  } catch {
    /* ignore */
  }
}
