import React, { useEffect, useState } from 'react';
import { storageManager } from '../storage/storageManager';
import { formatBytes } from '../core/utils';
import { useSettings } from '../settings/settingsStore';
import { SectionTitle } from '../ui/primitives';
import { toast } from '../ui/toast';

export function StorageScreen() {
  const [usage, setUsage] = useState({ offline: 0, cache: 0, artwork: 0, database: 0, total: 0 });
  const maxOfflineBytes = useSettings((s) => s.maxOfflineBytes);
  const patch = useSettings((s) => s.patch);

  const refresh = () => { storageManager.usage().then(setUsage).catch(() => undefined); };
  useEffect(refresh, []);

  const bar = (value: number, max: number) => (
    <div className="progress" style={{ marginTop: 6 }}><div style={{ width: `${max > 0 ? Math.min(100, (value / max) * 100) : 0}%` }} /></div>
  );

  return (
    <div>
      <SectionTitle title="Storage" sub="Temporary cache and your offline library are stored separately" />
      <div className="settings-grid">
        <div className="card" style={{ padding: 18 }}>
          <h3 style={{ marginTop: 0 }}>KNOX Storage</h3>
          {([
            ['Offline Music', usage.offline],
            ['Temporary Cache', usage.cache],
            ['Artwork', usage.artwork],
            ['Database', usage.database],
          ] as [string, number][]).map(([label, v]) => (
            <div key={label} style={{ padding: '8px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13.5 }}>
                <span>{label}</span><strong>{formatBytes(v)}</strong>
              </div>
              {bar(v, Math.max(usage.total, 1))}
            </div>
          ))}
          <hr style={{ borderColor: 'var(--border)' }} />
          <div style={{ display: 'flex', justifyContent: 'space-between' }}><span>Total</span><strong>{formatBytes(usage.total)}</strong></div>
          <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
            <button className="btn" onClick={() => { void storageManager.clearCache().then((n) => { toast(`Cleared ${n} cache entries`); refresh(); }); }}>
              Clear temporary cache</button>
            <button className="btn" onClick={() => {
              if (window.confirm('Remove ALL offline music? Favorites are kept but files are deleted.')) {
                void storageManager.removeAllOffline().then(() => { toast('Offline music removed'); refresh(); });
              }
            }}>Remove offline music</button>
          </div>
        </div>
        <div className="card" style={{ padding: 18 }}>
          <h3 style={{ marginTop: 0 }}>Limits & cleanup</h3>
          <label className="lbl">Maximum offline storage</label>
          <select value={maxOfflineBytes} onChange={(e) => void patch({ maxOfflineBytes: Number(e.target.value) })} aria-label="Maximum offline storage">
            <option value={500 * 1024 * 1024}>500 MB</option>
            <option value={1024 * 1024 * 1024}>1 GB</option>
            <option value={2 * 1024 * 1024 * 1024}>2 GB</option>
            <option value={5 * 1024 * 1024 * 1024}>5 GB</option>
            <option value={10 * 1024 * 1024 * 1024}>10 GB</option>
            <option value={-1}>Unlimited</option>
          </select>
          <p style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
            When the limit is reached you&apos;ll see “Offline storage limit reached” with options to manage storage —
            your saved songs are never silently deleted.
          </p>
        </div>
      </div>
    </div>
  );
}
