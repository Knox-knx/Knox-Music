import React, { useEffect } from 'react';
import { useDownloads, downloadStateLabel } from '../downloads/DownloadManager';
import { formatBytes } from '../core/utils';
import { EmptyState, SectionTitle } from '../ui/primitives';

export function DownloadsScreen() {
  const items = useDownloads((s) => s.items);
  const load = useDownloads((s) => s.load);
  const pause = useDownloads((s) => s.pause);
  const resume = useDownloads((s) => s.resume);
  const cancel = useDownloads((s) => s.cancel);
  const retry = useDownloads((s) => s.retry);
  const remove = useDownloads((s) => s.remove);
  const clearCompleted = useDownloads((s) => s.clearCompleted);

  useEffect(() => { void load(); }, [load]);

  const active = items.filter((i) => i.state === 'DOWNLOADING' || i.state === 'QUEUED' || i.state === 'PAUSED');
  const done = items.filter((i) => i.state === 'COMPLETED');
  const failed = items.filter((i) => i.state === 'FAILED' || i.state === 'CANCELLED');

  if (items.length === 0) {
    return <EmptyState icon="↓" title="Nothing available offline yet" body="Save songs for offline listening from any song menu." />;
  }

  const row = (id: string, title: string, artist: string, extra: React.ReactNode, actions: React.ReactNode) => (
    <div key={id} className="card" style={{ padding: 14, marginBottom: 10 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'center' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700 }}>♪ {title}</div>
          <div style={{ color: 'var(--text-2)', fontSize: 12.5 }}>{artist}</div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>{actions}</div>
      </div>
      <div style={{ marginTop: 10 }}>{extra}</div>
    </div>
  );

  return (
    <div>
      <SectionTitle title="Downloads" right={<button className="btn" onClick={() => void clearCompleted()}>Clear completed</button>} />
      <h3>Downloading & Queued</h3>
      {active.length === 0 && <p style={{ color: 'var(--text-2)' }}>Nothing in progress.</p>}
      {active.map((d) => row(d.id, d.title, d.artist,
        <>
          <div className="progress"><div style={{ width: `${Math.round(d.progress * 100)}%` }} /></div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6 }}>
            {downloadStateLabel(d.state)} · {Math.round(d.progress * 100)}% {d.bytesTotal ? `· ${formatBytes(d.bytesReceived)} / ${formatBytes(d.bytesTotal)}` : `· ${formatBytes(d.bytesReceived)}`}
          </div>
        </>,
        <>
          {d.state === 'DOWNLOADING' && <button className="btn" onClick={() => void pause(d.id)}>Pause</button>}
          {d.state === 'PAUSED' && <button className="btn" onClick={() => void resume(d.id)}>Resume</button>}
          <button className="btn" onClick={() => void cancel(d.id)}>Cancel</button>
        </>,
      ))}
      <h3>Available Offline</h3>
      {done.length === 0 && <p style={{ color: 'var(--text-2)' }}>No offline songs yet.</p>}
      {done.map((d) => row(d.id, d.title, d.artist,
        <span style={{ color: 'var(--success, #34d399)', fontSize: 13 }}>✓ Offline</span>,
        <><button className="btn" onClick={() => void remove(d.id, false)}>Remove entry</button>
          <button className="btn" onClick={() => void remove(d.id, true)}>Remove offline copy</button></>,
      ))}
      {failed.length > 0 && (
        <>
          <h3>Needs attention</h3>
          {failed.map((d) => row(d.id, d.title, d.artist,
            <span style={{ color: 'var(--warning)', fontSize: 13 }}>⚠︎ {d.error || downloadStateLabel(d.state)}</span>,
            <><button className="btn" onClick={() => void retry(d.id)}>Retry</button>
              <button className="btn" onClick={() => void remove(d.id, false)}>Dismiss</button></>,
          ))}
        </>
      )}
    </div>
  );
}
