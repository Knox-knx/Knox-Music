import React, { useEffect, useState } from 'react';
import { useSettings, qualityBytesPerSong } from '../settings/settingsStore';
import { getProviderManager } from '../providers/ProviderManager';
import { formatBytes } from '../core/utils';
import { SectionTitle } from '../ui/primitives';
import { toast } from '../ui/toast';

function Row({ label, hint, control }: { label: string; hint?: string; control: React.ReactNode }) {
  return (
    <div className="setting-row">
      <div><div style={{ fontWeight: 650 }}>{label}</div>{hint && <div style={{ fontSize: 12, color: 'var(--text-2)' }}>{hint}</div>}</div>
      <div>{control}</div>
    </div>
  );
}

function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button role="switch" aria-checked={checked} aria-label={label} className="switch" onClick={() => onChange(!checked)} />;
}

/** Settings → Playback → Smart Cache. Automatic bounded playback cache,
 *  strictly separate from permanent Offline Downloads. "Clear Smart Cache"
 *  removes ONLY cached playback audio — never library, favorites,
 *  playlists, downloads, lyrics, artwork, or settings. */
function SmartCacheSettings() {
  const patch = useSettings((x) => x.patch);
  const enabled = useSettings((x) => x.smartCacheEnabled);
  const maxBytes = useSettings((x) => x.maxSmartCacheBytes);
  const ttlDays = useSettings((x) => x.smartCacheTtlDays);
  const autoClear = useSettings((x) => x.smartCacheAutoClear);
  const [stats, setStats] = useState<{ entries: number; bytes: number }>({ entries: 0, bytes: 0 });
  const [cleaning, setCleaning] = useState(false);

  const refresh = () => {
    void import('../cache/smartCache').then(({ smartCacheStats }) => {
      smartCacheStats().then(setStats).catch(() => undefined);
    }).catch(() => undefined);
  };
  useEffect(refresh, []);

  const doClear = async () => {
    setCleaning(true);
    try {
      const { clearSmartCache } = await import('../cache/smartCache');
      const n = await clearSmartCache();
      refresh();
      toast(n > 0 ? `Cleared Smart Cache (${n} entr${n === 1 ? 'y' : 'ies'})` : 'Smart Cache is already empty');
    } finally {
      setCleaning(false);
    }
  };

  return (
    <>
      <Row label="Smart Cache" hint="Automatically keeps validated playback audio for instant replay. Separate from Offline Downloads." control={
        <Switch label="Smart Cache" checked={enabled} onChange={(v) => void patch({ smartCacheEnabled: v })} />} />
      <Row label="Cache size" hint={`${stats.entries} entr${stats.entries === 1 ? 'y' : 'ies'} · ${formatBytes(stats.bytes)} stored`} control={
        <select value={maxBytes} onChange={(e) => void patch({ maxSmartCacheBytes: Number(e.target.value) })} aria-label="Smart Cache maximum size">
          <option value={256 * 1024 * 1024}>256 MB</option>
          <option value={512 * 1024 * 1024}>512 MB</option>
          <option value={1024 * 1024 * 1024}>1 GB</option>
          <option value={2 * 1024 * 1024 * 1024}>2 GB</option>
        </select>} />
      <Row label="Keep cached audio for" hint="Least-recently-played entries are evicted first when full. Never evicts the playing track." control={
        <select value={ttlDays} onChange={(e) => void patch({ smartCacheTtlDays: Number(e.target.value) })} aria-label="Smart Cache retention">
          <option value={7}>7 days</option>
          <option value={30}>30 days</option>
          <option value={90}>90 days</option>
        </select>} />
      <Row label="Auto-clear after playback" hint="Remove cached audio once a song naturally finishes. Never touches Offline Downloads or your library." control={
        <select value={autoClear ?? 'immediate'} onChange={(e) => void patch({ smartCacheAutoClear: e.target.value as typeof autoClear })} aria-label="Smart Cache auto-clear after playback">
          <option value="immediate">Immediately after song ends</option>
          <option value="1h">After 1 hour</option>
          <option value="6h">After 6 hours</option>
          <option value="24h">After 24 hours</option>
          <option value="never">Never</option>
        </select>} />
      <div style={{ padding: '4px 0 14px' }}>
        <button className="btn" onClick={() => void doClear()} disabled={cleaning}>Clear Smart Cache</button>
      </div>
    </>
  );
}

export function SettingsScreen({ go }: { go: (r: 'storage' | 'about' | 'providers') => void }) {
  const s = useSettings();
  const patch = useSettings((x) => x.patch);
  const [tab, setTab] = useState('Appearance');
  const tabs = ['Appearance', 'Playback', 'Search', 'Downloads', 'Library', 'Lyrics', 'Notifications', 'Privacy', 'Network', 'Providers', 'Advanced'];

  return (
    <div>
      <SectionTitle title="Settings" sub="Everything stays on this device" />
      <div className="chips" style={{ marginBottom: 14 }}>
        {tabs.map((t) => <button key={t} className={`chip${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>{t}</button>)}
      </div>

      {tab === 'Appearance' && (
        <div className="card" style={{ padding: '6px 18px' }}>
          <Row label="Theme" control={
            <select value={s.theme} onChange={(e) => void patch({ theme: e.target.value as typeof s.theme })} aria-label="Theme">
              <option value="dark">Dark</option><option value="light">Light</option><option value="system">System</option>
            </select>} />
          <Row label="Accent color" control={
            <select value={s.accent} onChange={(e) => void patch({ accent: e.target.value as typeof s.accent })} aria-label="Accent color">
              <option value="default">Default</option><option value="dynamic">Dynamic (from artwork)</option><option value="custom">Custom</option>
            </select>} />
          {s.accent === 'custom' && (
            <Row label="Custom accent" control={<input type="color" value={s.customAccent} onChange={(e) => void patch({ customAccent: e.target.value })} aria-label="Custom accent" />} />
          )}
          <Row label="Animations" control={<Switch label="Animations" checked={s.animations} onChange={(v) => void patch({ animations: v })} />} />
          <Row label="Blur effects" control={<Switch label="Blur effects" checked={s.blur} onChange={(v) => void patch({ blur: v })} />} />
          <Row label="Compact mode" control={<Switch label="Compact mode" checked={s.compact} onChange={(v) => void patch({ compact: v })} />} />
        </div>
      )}

      {tab === 'Playback' && (
        <div className="card" style={{ padding: '6px 18px' }}>
          <Row label="Autoplay" hint="Continue to related tracks when the queue ends" control={<Switch label="Autoplay" checked={s.autoplay} onChange={(v) => void patch({ autoplay: v })} />} />
          <Row label="Repeat" hint="Off stops at the end · All loops the queue · One repeats the song" control={
            <select value={s.repeatMode} onChange={(e) => {
              const v = e.target.value as typeof s.repeatMode;
              void patch({ repeatMode: v });
              try { import('../audio/playerStore').then(({ usePlayer }) => usePlayer.getState().setRepeat(v)); } catch { /* best-effort */ }
            }} aria-label="Repeat mode">
              <option value="OFF">Off</option><option value="ALL">All</option><option value="ONE">One</option>
            </select>} />
          <Row label="Gapless playback" hint="Supported by the HTML audio engine where the format allows" control={<Switch label="Gapless playback" checked={s.gapless} onChange={(v) => void patch({ gapless: v })} />} />
          <Row label="Crossfade" control={<Switch label="Crossfade" checked={s.crossfade} onChange={(v) => void patch({ crossfade: v })} />} />
          <Row label="Crossfade duration" control={
            <select value={s.crossfadeSec} onChange={(e) => void patch({ crossfadeSec: Number(e.target.value) })} aria-label="Crossfade duration">
              {[3, 5, 8, 12].map((n) => <option key={n} value={n}>{n} sec</option>)}
            </select>} />
          <Row label="Remember playback position" control={<Switch label="Remember playback position" checked={s.rememberPosition} onChange={(v) => void patch({ rememberPosition: v })} />} />
          <Row label="Normalize volume" hint="Honest flag stored with your library; applied where the engine supports it" control={<Switch label="Normalize volume" checked={s.normalize} onChange={(v) => void patch({ normalize: v })} />} />
          <OutputDeviceRow />
          <Row label="Resume previous song" control={<Switch label="Resume previous song" checked={s.resumePrevious} onChange={(v) => void patch({ resumePrevious: v })} />} />
          <Row label="Resume playback automatically" hint="Never autoplays unless you enable this" control={<Switch label="Resume playback automatically" checked={s.resumeAutoplay} onChange={(v) => void patch({ resumeAutoplay: v })} />} />
          <SmartCacheSettings />
          <div style={{ padding: '12px 0', fontSize: 13, color: 'var(--text-2)' }}>
            Equalizer: not available on the web audio engine — no fake sliders are shown. System-wide EQ (OS / Bluetooth device) still applies.
          </div>
        </div>
      )}

      {tab === 'Search' && (
        <div className="card" style={{ padding: '6px 18px' }}>
          <div style={{ padding: '12px 0', fontSize: 12.5, color: 'var(--text-2)' }}>
            Search covers your enabled music providers only (Jamendo, Internet Archive, FreeToUse, AirBeats, YouTube Music discovery). Web Discovery is disconnected in this stable release.
          </div>
        </div>
      )}

      {tab === 'Downloads' && (
        <div className="card" style={{ padding: '6px 18px' }}>
          <Row label="Wi-Fi only" hint="Download using mobile data is off" control={<Switch label="Wi-Fi only" checked={s.wifiOnly} onChange={(v) => void patch({ wifiOnly: v })} />} />
          <Row label="Audio quality" hint={`High ≈ ${formatBytes(qualityBytesPerSong('High'))} per song`} control={
            <select value={s.offlineQuality} onChange={(e) => void patch({ offlineQuality: e.target.value as typeof s.offlineQuality })} aria-label="Offline audio quality">
              {(['Low', 'Normal', 'High', 'Best Available'] as const).map((q) => <option key={q} value={q}>{q} — ~{formatBytes(qualityBytesPerSong(q))}/song</option>)}
            </select>} />
          <Row label="Maximum storage" control={
            <select value={s.maxOfflineBytes} onChange={(e) => void patch({ maxOfflineBytes: Number(e.target.value) })} aria-label="Maximum offline storage">
              <option value={500 * 1024 * 1024}>500 MB</option>
              <option value={1024 * 1024 * 1024}>1 GB</option>
              <option value={2 * 1024 * 1024 * 1024}>2 GB</option>
              <option value={5 * 1024 * 1024 * 1024}>5 GB</option>
              <option value={10 * 1024 * 1024 * 1024}>10 GB</option>
              <option value={-1}>Unlimited</option>
            </select>} />
          <Row label="Automatic cleanup" hint="Remove expired temporary cache; never deletes your offline songs or favorites" control={<Switch label="Automatic cleanup" checked={s.autoCleanup} onChange={(v) => void patch({ autoCleanup: v })} />} />
          <Row label="Automatically save played songs" hint="OFF by default — KNOX never consumes storage unexpectedly" control={<Switch label="Automatically save played songs" checked={s.autoSavePlayed} onChange={(v) => void patch({ autoSavePlayed: v })} />} />
        </div>
      )}

      {tab === 'Library' && (
        <div className="card" style={{ padding: '6px 18px' }}>
          <Row label="Launch on startup" control={<Switch label="Launch on startup" checked={s.launchOnStartup} onChange={(v) => void patch({ launchOnStartup: v })} />} />
          <div style={{ padding: '12px 0', fontSize: 13, color: 'var(--text-2)' }}>
            Library scanning is incremental (size + modified time) — the app never rescans everything on startup.
          </div>
        </div>
      )}

      {tab === 'Lyrics' && (
        <div className="card" style={{ padding: '6px 18px' }}>
          <div style={{ padding: '12px 0', fontSize: 13.5 }}>
            Lyrics appear only when legally available from the provider or from a local <code>.lrc</code> file you import.
            KNOX never invents lyrics. Import a sidecar file from the Now Playing → Lyrics tab.
          </div>
        </div>
      )}

      {tab === 'Notifications' && (
        <div className="card" style={{ padding: '6px 18px' }}>
          <Row label="Download complete" control={<Switch label="Download complete" checked={s.notifDownloadComplete} onChange={(v) => void patch({ notifDownloadComplete: v })} />} />
          <Row label="Download failed" control={<Switch label="Download failed" checked={s.notifDownloadFailed} onChange={(v) => void patch({ notifDownloadFailed: v })} />} />
          <Row label="Playback notifications" hint="OS media controls via Media Session API" control={<Switch label="Playback notifications" checked={s.notifPlayback} onChange={(v) => void patch({ notifPlayback: v })} />} />
        </div>
      )}

      {tab === 'Privacy' && (
        <div className="card" style={{ padding: 18 }}>
          <p style={{ fontSize: 13.5 }}>No account. No KNOX cloud. No uploads of history, playlists or files. When you search, the query text is sent to the enabled providers so they can return results — nothing else.</p>
          <ul style={{ fontSize: 13, color: 'var(--text-2)' }}>
            <li>Search queries → enabled music providers (required to get results)</li>
            <li>Streaming → audio CDN of the chosen provider</li>
            <li>Everything else stays in this browser&apos;s local database</li>
          </ul>
        </div>
      )}

      {tab === 'Network' && (
        <div className="card" style={{ padding: '6px 18px' }}>
          <Row label="Max concurrent downloads" control={
            <select value={s.maxConcurrentDownloads} onChange={(e) => void patch({ maxConcurrentDownloads: Number(e.target.value) })} aria-label="Max concurrent downloads">
              {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>} />
          <Row label="Request timeout" control={
            <select value={s.requestTimeoutSec} onChange={(e) => void patch({ requestTimeoutSec: Number(e.target.value) })} aria-label="Request timeout">
              {[10, 15, 30, 60].map((n) => <option key={n} value={n}>{n} sec</option>)}
            </select>} />
        </div>
      )}

      {tab === 'Providers' && <ProvidersPanel />}
      {tab === 'Advanced' && <AdvancedPanel go={go} />}
    </div>
  );
}

function OutputDeviceRow() {
  const outputDeviceId = useSettings((s) => s.outputDeviceId);
  const patch = useSettings((s) => s.patch);
  const [devices, setDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    import('../audio/AudioEngine').then(({ getAudioEngine }) => {
      const engine = getAudioEngine();
      const ok = engine.supportsOutputSelection();
      setSupported(ok);
      if (ok) engine.listOutputDevices().then(setDevices).catch(() => undefined);
    });
  }, []);
  if (!supported) {
    return (
      <div style={{ padding: '12px 0', fontSize: 13, color: 'var(--text-2)' }}>
        Audio output follows the operating system mixer. Per-device selection isn&apos;t exposed by this browser — no fake device list is shown.
      </div>
    );
  }
  return (
    <div className="setting-row">
      <div><div style={{ fontWeight: 650 }}>Audio output</div>
        <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Respects OS routing; pick a device when available</div></div>
      <select value={outputDeviceId} aria-label="Audio output device"
        onChange={(e) => {
          const id = e.target.value;
          import('../audio/AudioEngine').then(({ getAudioEngine }) => {
            getAudioEngine().setOutputDevice(id).then(
              () => { void patch({ outputDeviceId: id }); toast('Audio output changed'); },
              () => toast('Could not switch output', 'warn'),
            );
          });
        }}>
        <option value="default">System default</option>
        {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label}</option>)}
      </select>
    </div>
  );
}

export function ProvidersPanel() {  const providersEnabled = useSettings((s) => s.providersEnabled);
  const patch = useSettings((s) => s.patch);
  const [, force] = useState(0);
  useEffect(() => { force((n) => n + 1); }, [providersEnabled]);
  const [sidecarStatus, setSidecarStatus] = useState<'unknown' | 'ok' | 'down'>('unknown');
  const [sidecarDetail, setSidecarDetail] = useState<string | null>(null);
  const pm = getProviderManager();
  const list = pm.list();
  const healthOf = (id: string) => pm.healthManager().get(id);
  const setServiceEnabled = (id: string, on: boolean) => {
    void patch({ providersEnabled: { ...providersEnabled, [id]: on } }).then(() => force((n) => n + 1));
  };
  return (
    <div className="card" style={{ padding: '6px 18px' }}>
      {list.map((p) => {
        const h = healthOf(p.id);
        return (
        <div key={p.id} className="setting-row">
          <div>
            <div style={{ fontWeight: 700 }}>
              {p.name} {providersEnabled[p.id] !== false ? '●' : '○'}
              <span style={{ fontWeight: 400, fontSize: 11.5, color: h.available ? 'var(--match-exact)' : 'var(--warning)', marginLeft: 8 }}>
                {h.available ? 'healthy' : `unavailable${h.lastError ? ` — ${h.lastError}` : ''}`}
                {h.available && h.lastLatencyMs !== null ? ` · ${h.lastLatencyMs}ms` : ''}
              </span>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
              Search {p.capabilities.supportsSearch ? '✓' : '—'} · Streaming {p.capabilities.supportsStreaming ? '✓' : '—'} ·
              Offline {p.capabilities.supportsOffline ? '✓ per-track license' : 'Not supported'}
              {!p.capabilities.supportsStreaming && p.capabilities.supportsSearch && (
                <span className="cap-chip preview" style={{ marginLeft: 6 }} title="Search and metadata only — playback, download, and offline are not available from this source">Discovery only</span>
              )}
              {p.id === 'jamendo' && ' — public client_id built in; override via .env'}
              {(p.id === 'internet-archive' || p.id === 'freetouse') && ' — no key needed'}
              {p.id === 'youtube-music' && ' — discovery-only local service on 127.0.0.1 (no key, no login)'}
            </div>
            {p.id === 'youtube-music' && (
              <div style={{ marginTop: 6, display: 'flex', gap: 8, alignItems: 'center' }}>
                <button
                  className="btn" style={{ padding: '4px 12px', fontSize: 12 }}
                  onClick={() => {
                    setSidecarStatus('unknown');
                    void (async () => {
                      // Desktop shell: ask the host (owns the process + port).
                      // Browser: probe the sidecar URL directly.
                      try {
                        const { isTauri } = await import('../desktop/detector');
                        if (isTauri()) {
                          const { getSidecarStatus } = await import('../desktop/host');
                          const st = await getSidecarStatus();
                          if (st) {
                            setSidecarStatus(st.state === 'ready' ? 'ok' : 'down');
                            setSidecarDetail(st.state === 'ready' ? null : `host reports: ${st.state}${st.lastError ? ` — ${st.lastError}` : ''}`);
                            return;
                          }
                        }
                      } catch { /* fall through to direct probe */ }
                      void import('../providers/youtubeMusic/provider').then(({ YouTubeMusicProvider }) =>
                        new YouTubeMusicProvider().checkHealth().then((ok) => {
                          setSidecarStatus(ok ? 'ok' : 'down');
                          setSidecarDetail(null);
                        }),
                      );
                    })();
                  }}
                >Check service</button>
                {sidecarStatus !== 'unknown' && (
                  <span style={{ fontSize: 12, color: sidecarStatus === 'ok' ? 'var(--match-exact)' : 'var(--warning)' }} role="status">
                    {sidecarStatus === 'ok' ? 'YouTube Music available' : (sidecarDetail ?? 'YouTube Music unavailable — start services/youtubemusic or keep the provider disabled')}
                  </span>
                )}
              </div>
            )}
          </div>
          <button role="switch" aria-checked={providersEnabled[p.id] !== false} aria-label={`Enable ${p.name}`}
            className="switch"
            onClick={() => {
              const next = { ...providersEnabled, [p.id]: !(providersEnabled[p.id] !== false) };
              getProviderManager().setEnabled(p.id, next[p.id]);
              void patch({ providersEnabled: next });
            }} />
        </div>
        );
      })}
      <div className="nav-label" style={{ marginTop: 8 }}>Radio &amp; Lyrics services</div>
      <div className="setting-row">
        <div>
          <div style={{ fontWeight: 700 }}>Radio Browser {providersEnabled['radio-browser'] !== false ? '●' : '○'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Live stations · stream-only, never offline — no key needed</div>
        </div>
        <button role="switch" aria-checked={providersEnabled['radio-browser'] !== false} aria-label="Enable Radio Browser"
          className="switch"
          onClick={() => setServiceEnabled('radio-browser', !(providersEnabled['radio-browser'] !== false))} />
      </div>
      <div className="setting-row">
        <div>
          <div style={{ fontWeight: 700 }}>LRCLIB Lyrics {providersEnabled['lrclib'] !== false ? '●' : '○'}</div>
          <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Synced + plain lyrics, cached locally for 30 days — no key needed</div>
        </div>
        <button role="switch" aria-checked={providersEnabled['lrclib'] !== false} aria-label="Enable LRCLIB Lyrics"
          className="switch"
          onClick={() => setServiceEnabled('lrclib', !(providersEnabled['lrclib'] !== false))} />
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-2)' }}>
        Offline buttons are hidden/disabled for sources that don&apos;t permit local storage — never a broken download button.
      </p>
    </div>
  );
}

function DesktopPanel() {
  const [info, setInfo] = useState<{ mode: string; dataDir: string | null; apiOk: boolean | null }>({
    mode: 'browser', dataDir: null, apiOk: null,
  });
  useEffect(() => {
    void (async () => {
      try {
        const { runtimeMode } = await import('../desktop/detector');
        const mode = runtimeMode();
        if (mode === 'browser') {
          setInfo({ mode, dataDir: null, apiOk: null });
          return;
        }
        const { getApiConfig } = await import('../desktop/host');
        const cfg = await getApiConfig();
        let apiOk: boolean | null = null;
        try {
          const { fetchHealth } = await import('../desktop/localApi');
          const h = await fetchHealth();
          apiOk = h?.ok === true;
        } catch {
          apiOk = false;
        }
        setInfo({ mode, dataDir: cfg?.dataDir ?? null, apiOk });
      } catch {
        /* diagnostics never break settings */
      }
    })();
  }, []);
  const openFolder = () => {
    void (async () => {
      try {
        const { openDataDir } = await import('../desktop/host');
        const ok = await openDataDir();
        if (!ok) toast('Could not open the data folder', 'warn');
      } catch {
        toast('Could not open the data folder', 'warn');
      }
    })();
  };
  return (
    <div className="card" style={{ padding: 18 }}>
      <h3 style={{ marginTop: 0 }}>Desktop &amp; data</h3>
      {info.mode === 'browser' ? (
        <p style={{ fontSize: 13, color: 'var(--text-2)' }}>
          Browser mode — everything stays in this browser&apos;s local database. Install the KNOX Music
          desktop app and your library lives in its own data folder (database · artwork · lyrics ·
          cache · offline · playlists · logs · backups).
        </p>
      ) : (
        <div style={{ display: 'grid', gap: 8, fontSize: 13 }}>
          <div>Local API: {info.apiOk === null ? 'checking…' : info.apiOk ? 'running (127.0.0.1 only)' : 'unreachable — retrying'}</div>
          {info.dataDir && (
            <div style={{ color: 'var(--text-2)', overflowWrap: 'anywhere' }}>Data folder: {info.dataDir}</div>
          )}
          <div><button className="btn" onClick={openFolder}>Open data folder</button></div>
        </div>
      )}
    </div>
  );
}

function AdvancedPanel({ go }: { go: (r: 'storage' | 'about' | 'providers') => void }) {
  const exportAll = async () => {
    const { getDb } = await import('../data/db');
    const db = getDb();
    const data = {
      app: 'knox-music', version: 1, date: new Date().toISOString(),
      songs: await db.songs.toArray().then((rows) => rows.map((r) => ({ ...r, streamUrl: undefined, artworkLocal: undefined }))),
      playlists: await db.playlists.toArray(),
      favorites: await db.favorites.toArray(),
      history: await db.history.toArray(),
      settings: await db.settings.toArray(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `knox-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    toast('✓ Backup exported (metadata only, no audio)');
  };

  const importBackup = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as { app?: string; songs?: unknown[]; playlists?: { id: string; name: string; trackIds: string[] }[]; favorites?: { songId: string }[] };
      if (parsed.app !== 'knox-music') throw new Error('Not a KNOX backup');
      if (!window.confirm('Restore backup? Existing data is kept; entries are merged.')) return;
      const { getDb } = await import('../data/db');
      const db = getDb();
      if (parsed.songs) await db.songs.bulkPut(parsed.songs as never[]);
      if (parsed.playlists) await db.playlists.bulkPut(parsed.playlists as never[]);
      if (parsed.favorites) await db.favorites.bulkPut(parsed.favorites.map((f) => ({ ...f, addedAt: Date.now() })) as never[]);
      toast('✓ Backup restored');
    } catch { toast('Invalid backup file', 'error'); }
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <DesktopPanel />
      <div className="card" style={{ padding: 18 }}>
        <h3 style={{ marginTop: 0 }}>Import / Export</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => void exportAll()}>Create backup (JSON)</button>
          <label className="btn" style={{ cursor: 'pointer' }}>Restore backup
            <input type="file" accept="application/json" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void importBackup(f); }} />
          </label>
          <button className="btn" onClick={() => go('storage')}>Manage storage</button>
          <button className="btn" onClick={() => go('about')}>About</button>
        </div>
        <p style={{ fontSize: 12.5, color: 'var(--text-2)' }}>Backups contain metadata/configuration only — never duplicated audio. Copyrighted audio is never exported.</p>
      </div>
      <div className="card" style={{ padding: 18 }}>
        <h3 style={{ marginTop: 0 }}>Keyboard shortcuts</h3>
        <ul style={{ fontSize: 13, color: 'var(--text-2)', columns: 2 }}>
          <li>Space — Play/Pause</li><li>Ctrl+K — Search</li><li>Ctrl+N — New playlist</li>
          <li>← / → — Previous/Next</li><li>↑ / ↓ — Volume</li><li>M — Mute</li>
        </ul>
      </div>
    </div>
  );
}
