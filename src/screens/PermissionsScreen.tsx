// App permissions — one audit surface for every OS grant (§1.5).
// Each row shows live state (Granted / Denied / Partial / Not asked) with a
// direct action or deep link to fix it — no hunting through OS settings.
// The "Automatic behaviors" section documents always-on handling that needs
// no permission (audio focus, headset auto-pause, background session).

import React, { useCallback, useEffect, useState } from 'react';
import type { Route } from '../ui/navigation';
import { SectionTitle, Skeleton } from '../ui/primitives';
import { queryPermissionRows, type PermissionRow, type PermissionStatus } from '../os/permissions';
import {
  listFolderGrants,
  reRequestGrant,
  forgetGrant,
  type FolderGrantStatus,
} from '../library/folderGrants';

const STATUS_STYLE: Record<PermissionStatus, { label: string; color: string; border: string }> = {
  granted: { label: 'Granted', color: 'var(--match-exact)', border: 'var(--match-exact)' },
  denied: { label: 'Denied', color: 'var(--danger)', border: 'var(--danger)' },
  partial: { label: 'Partial', color: 'var(--warning)', border: 'var(--warning)' },
  prompt: { label: 'Not asked', color: 'var(--text-2)', border: 'var(--border)' },
  unknown: { label: 'Unknown', color: 'var(--text-3)', border: 'var(--border)' },
  unavailable: { label: 'N/A', color: 'var(--text-3)', border: 'var(--border)' },
};

function StatusChip({ status }: { status: PermissionStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      className="cap-chip"
      role="status"
      aria-label={`Permission state: ${s.label}`}
      style={{ color: s.color, borderColor: s.border }}
    >
      {s.label}
    </span>
  );
}

function PermissionCard({ row, onChanged }: { row: PermissionRow; onChanged: () => void }) {
  return (
    <div className="setting-row" style={{ alignItems: 'flex-start' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 650 }}>{row.title}</span>
          <StatusChip status={row.status} />
        </div>
        <div style={{ fontSize: 12.5, color: 'var(--text-2)', marginTop: 2 }}>{row.blurb}</div>
        <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 2 }}>{row.statusHint}</div>
        {(row.onAction || row.onOpenSettings) && (
          <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
            {row.onAction && row.actionLabel && (
              <button
                className="btn"
                style={{ padding: '6px 14px', fontSize: 12.5 }}
                onClick={() => {
                  void Promise.resolve(row.onAction!()).then(() => onChanged()).catch(() => onChanged());
                }}
              >
                {row.actionLabel}
              </button>
            )}
            {row.onOpenSettings && row.settingsLabel && (
              <button
                className="btn"
                style={{ padding: '6px 14px', fontSize: 12.5 }}
                onClick={() => {
                  void Promise.resolve(row.onOpenSettings!()).then(() => onChanged()).catch(() => onChanged());
                }}
              >
                {row.settingsLabel} ↗
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function PermissionsScreen({ go }: { go: (r: Route) => void }) {
  const [rows, setRows] = useState<PermissionRow[] | null>(null);
  const [grants, setGrants] = useState<FolderGrantStatus[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const [r, g] = await Promise.all([queryPermissionRows(), listFolderGrants()]);
      setRows(r);
      setGrants(g);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div>
      <SectionTitle
        title="App permissions"
        sub="Every OS grant in one place — fix a denial without hunting through system settings"
        right={
          <button className="btn" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh permission states">
            {refreshing ? 'Checking…' : '↻ Recheck'}
          </button>
        }
      />
      {!rows && <Skeleton count={5} />}
      {rows && (
        <div className="card" style={{ padding: '6px 18px' }} role="list" aria-label="App permissions">
          {rows.map((row) => (
            <PermissionCard key={row.id} row={row} onChanged={() => void refresh()} />
          ))}
        </div>
      )}

      <h3 className="section-title" style={{ fontSize: 19 }}>Saved folders</h3>
      <div className="card" style={{ padding: '6px 18px' }}>
        {!grants && <Skeleton count={2} />}
        {grants && grants.length === 0 && (
          <p style={{ fontSize: 13, color: 'var(--text-2)' }}>
            No folders saved yet. Pick one via Library → “Scan device” or “Add folder” and it stays
            available across restarts — you’ll only ever be re-asked if the OS revokes it.
          </p>
        )}
        {grants && grants.map((g) => (
          <div key={g.id} className="setting-row">
            <div>
              <div style={{ fontWeight: 650 }}>▤ {g.name}</div>
              <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
                {g.liveness === 'live' ? 'Available — no re-prompt needed.' : 'OS access lost — re-confirm to restore.'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              {g.liveness !== 'live' && (
                <button
                  className="btn" style={{ padding: '6px 14px', fontSize: 12.5 }}
                  onClick={() => void reRequestGrant(g.id).then(() => refresh())}
                >
                  Re-confirm
                </button>
              )}
              <button
                className="btn" style={{ padding: '6px 14px', fontSize: 12.5 }}
                onClick={() => void forgetGrant(g.id).then(() => refresh())}
                aria-label={`Forget folder ${g.name}`}
              >
                Forget
              </button>
            </div>
          </div>
        ))}
      </div>

      <h3 className="section-title" style={{ fontSize: 19 }}>Automatic behaviors</h3>
      <div className="card" style={{ padding: '6px 18px' }}>
        <div className="setting-row">
          <div>
            <div style={{ fontWeight: 650 }}>Call &amp; interruption handling <span className="cap-chip offline-ok">Always on</span></div>
            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
              Incoming calls pause playback; it resumes automatically only after a transient loss when you never paused manually. Another music app taking over stops us without a fight.
            </div>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <div style={{ fontWeight: 650 }}>Headphone / Bluetooth disconnect <span className="cap-chip offline-ok">Always on</span></div>
            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
              Removing headphones or disconnecting a speaker auto-pauses — audio never keeps blasting through the phone speaker.
            </div>
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <button className="btn" onClick={() => go('settings')}>← Back to Settings</button>
      </div>
    </div>
  );
}
