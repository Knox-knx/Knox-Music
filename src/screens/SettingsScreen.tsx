import React, { useEffect, useRef, useState } from 'react';
import { useSettings, qualityBytesPerSong, type LiveWallpaperPreset } from '../settings/settingsStore';
import { usePlayer } from '../audio/playerStore';
import { getProviderManager } from '../providers/ProviderManager';
import { formatBytes } from '../core/utils';
import { KnoxSelect } from '../ui/primitives';
import { KnoxTopBar } from '../ui/editorial';
import { toast } from '../ui/toast';
import {
  saveCustomVideoWallpaperFile,
  saveCustomNormalWallpaperFile,
  clearCustomVideoWallpaper,
  clearCustomNormalWallpaper,
  clearCustomLiveWallpaper,
} from '../ui/LiveWallpaper';

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

function LiveWallpaperSettings() {
  const s = useSettings();
  const patch = useSettings((x) => x.patch);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const normalInputRef = useRef<HTMLInputElement | null>(null);

  // Live wallpaper option is ONLY shown in Glassmorphism UI
  if ((s.uiStyle || 'glassmorphism') !== 'glassmorphism') {
    return null;
  }

  const activeMode: 'video' | 'normal' =
    s.wallpaperMode === 'normal' ||
    s.liveWallpaperPreset === 'normal_default' ||
    s.liveWallpaperPreset === 'normal_custom'
      ? 'normal'
      : 'video';

  const activeVideoName =
    s.customVideoWallpaperName ||
    (s.customLiveWallpaperType === 'video' ? s.customLiveWallpaperName : '');
  const activeNormalName =
    s.customNormalWallpaperName ||
    (s.customLiveWallpaperType === 'image' ? s.customLiveWallpaperName : '');

  const onVideoFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await saveCustomVideoWallpaperFile(file);
      toast(`Video wallpaper set: ${file.name}`);
    } catch {
      toast('Could not save video wallpaper', 'error');
    } finally {
      e.target.value = '';
    }
  };

  const onNormalFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      await saveCustomNormalWallpaperFile(file);
      toast(`Normal wallpaper set: ${file.name}`);
    } catch {
      toast('Could not save normal wallpaper', 'error');
    } finally {
      e.target.value = '';
    }
  };

  return (
    <>
      <Row
        label="Glassmorphism Live Wallpaper"
        hint="Ultra-low battery GPU background. Auto-pauses when minimized or covered by Full Player."
        control={
          <Switch
            label="Glassmorphism Live Wallpaper"
            checked={s.liveWallpaperEnabled !== false}
            onChange={(v) => void patch({ liveWallpaperEnabled: v })}
          />
        }
      />
      {s.liveWallpaperEnabled !== false && (
        <>
          <Row
            label="Wallpaper Mode"
            hint="Switch between live Video Wallpaper and static Normal Wallpaper"
            control={
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  type="button"
                  className={`chip${activeMode === 'video' ? ' active' : ''}`}
                  onClick={() =>
                    void patch({
                      wallpaperMode: 'video',
                      liveWallpaperPreset: activeVideoName ? 'custom' : 'aurora_prism',
                    })
                  }
                >
                  ▶ Video Wallpaper
                </button>
                <button
                  type="button"
                  className={`chip${activeMode === 'normal' ? ' active' : ''}`}
                  onClick={() =>
                    void patch({
                      wallpaperMode: 'normal',
                      liveWallpaperPreset: activeNormalName ? 'normal_custom' : 'normal_default',
                    })
                  }
                >
                  🖼 Normal Wallpaper
                </button>
              </div>
            }
          />

          {activeMode === 'video' && (
            <Row
              label="Video Wallpaper Style"
              hint={
                s.liveWallpaperPreset === 'custom' && activeVideoName
                  ? `Active custom video: ${activeVideoName}`
                  : 'Choose a built-in live preset or your custom user video wallpaper'
              }
              control={
                <KnoxSelect
                  value={
                    s.liveWallpaperPreset === 'normal_default' ||
                    s.liveWallpaperPreset === 'normal_custom'
                      ? activeVideoName
                        ? 'custom'
                        : 'aurora_prism'
                      : (s.liveWallpaperPreset || 'aurora_prism')
                  }
                  options={[
                    { value: 'aurora_prism', label: 'Aurora Prism (Eco GPU)' },
                    { value: 'cyber_waves', label: 'Cyber Waves (Eco GPU)' },
                    { value: 'neon_nebula', label: 'Neon Nebula (Eco GPU)' },
                    { value: 'custom', label: 'Custom User Video Wallpaper' },
                  ]}
                  onChange={(val) =>
                    void patch({
                      wallpaperMode: 'video',
                      liveWallpaperPreset: val as LiveWallpaperPreset,
                    })
                  }
                  ariaLabel="Live Wallpaper Style"
                />
              }
            />
          )}

          {activeMode === 'normal' && (
            <Row
              label="Normal Wallpaper Style"
              hint={
                activeNormalName
                  ? `Active custom image: ${activeNormalName}`
                  : 'Use the default KNOX wallpaper or your own custom image wallpaper'
              }
              control={
                <KnoxSelect
                  value={
                    s.liveWallpaperPreset === 'normal_custom' ||
                    (activeNormalName && s.liveWallpaperPreset === 'custom')
                      ? 'normal_custom'
                      : 'normal_default'
                  }
                  options={[
                    { value: 'normal_default', label: 'Default KNOX Wallpaper' },
                    { value: 'normal_custom', label: 'Custom User Normal Wallpaper' },
                  ]}
                  onChange={(val) =>
                    void patch({
                      wallpaperMode: 'normal',
                      liveWallpaperPreset: val as LiveWallpaperPreset,
                    })
                  }
                  ariaLabel="Normal Wallpaper Style"
                />
              }
            />
          )}

          <Row
            label="Video Wallpaper (User Set Video)"
            hint={
              activeVideoName
                ? `Active video: ${activeVideoName}`
                : 'Upload an MP4, WebM, or MOV video loop from your device'
            }
            control={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  ref={videoInputRef}
                  type="file"
                  accept="video/mp4,video/webm,video/quicktime,video/*,.mp4,.webm,.mov,.m4v,.mkv"
                  style={{ display: 'none' }}
                  onChange={(e) => void onVideoFileSelected(e)}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => videoInputRef.current?.click()}
                >
                  {activeVideoName ? 'Change Video Wallpaper…' : 'Set Video Wallpaper…'}
                </button>
                {activeVideoName && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      void clearCustomVideoWallpaper();
                      toast('Restored default Aurora Prism video wallpaper');
                    }}
                  >
                    Reset Video
                  </button>
                )}
              </div>
            }
          />

          <Row
            label="Normal Wallpaper (User Set Image)"
            hint={
              activeNormalName
                ? `Active wallpaper: ${activeNormalName}`
                : 'Upload a JPG, PNG, WebP, or GIF image wallpaper from your device'
            }
            control={
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  ref={normalInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif,image/*,.jpg,.jpeg,.png,.webp,.gif"
                  style={{ display: 'none' }}
                  onChange={(e) => void onNormalFileSelected(e)}
                />
                <button
                  type="button"
                  className="btn"
                  onClick={() => normalInputRef.current?.click()}
                >
                  {activeNormalName ? 'Change Normal Wallpaper…' : 'Set Normal Wallpaper…'}
                </button>
                {activeNormalName && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      void clearCustomNormalWallpaper();
                      toast('Restored default normal wallpaper');
                    }}
                  >
                    Reset Wallpaper
                  </button>
                )}
                {(activeVideoName || activeNormalName || s.customLiveWallpaperUrl) && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      void clearCustomLiveWallpaper();
                      toast('Reset all custom wallpapers');
                    }}
                  >
                    Reset All
                  </button>
                )}
              </div>
            }
          />
        </>
      )}
    </>
  );
}

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
        <KnoxSelect
          value={String(maxBytes)}
          options={[
            { value: String(256 * 1024 * 1024), label: '256 MB' },
            { value: String(512 * 1024 * 1024), label: '512 MB' },
            { value: String(1024 * 1024 * 1024), label: '1 GB' },
            { value: String(2 * 1024 * 1024 * 1024), label: '2 GB' },
          ]}
          onChange={(val) => void patch({ maxSmartCacheBytes: Number(val) })}
          ariaLabel="Smart Cache maximum size"
        />} />
      <Row label="Keep cached audio for" hint="Least-recently-played entries are evicted first when full. Never evicts the playing track." control={
        <KnoxSelect
          value={String(ttlDays)}
          options={[
            { value: '7', label: '7 days' },
            { value: '30', label: '30 days' },
            { value: '90', label: '90 days' },
          ]}
          onChange={(val) => void patch({ smartCacheTtlDays: Number(val) })}
          ariaLabel="Smart Cache retention"
        />} />
      <Row label="Auto-clear after playback" hint="Remove cached audio once a song naturally finishes. Never touches Offline Downloads or your library." control={
        <KnoxSelect
          value={autoClear ?? 'immediate'}
          options={[
            { value: 'immediate', label: 'Immediately after song ends' },
            { value: '1h', label: 'After 1 hour' },
            { value: '6h', label: 'After 6 hours' },
            { value: '24h', label: 'After 24 hours' },
            { value: 'never', label: 'Never' },
          ]}
          onChange={(val) => void patch({ smartCacheAutoClear: val as typeof autoClear })}
          ariaLabel="Smart Cache auto-clear after playback"
        />} />
      <div style={{ padding: '4px 0 14px' }}>
        <button className="btn" onClick={() => void doClear()} disabled={cleaning}>Clear Smart Cache</button>
      </div>
    </>
  );
}

export function SettingsScreen({ go, onOpenMenu }: {
  go: (r: 'storage' | 'about' | 'providers' | 'permissions') => void;
  onOpenMenu?: () => void;
}) {
  const s = useSettings();
  const patch = useSettings((x) => x.patch);
  const [tab, setTab] = useState('Appearance');
  const tabs = ['Appearance', 'UI / UI', 'Playback', 'Downloads', 'Notifications', 'Network', 'Providers', 'Advanced'];

  return (
    <div>
      <KnoxTopBar
        title="Settings"
        caption="Everything stays on this device"
        onOpenMenu={onOpenMenu ?? (() => window.dispatchEvent(new CustomEvent('knox:open-menu')))}
        onOpenSettings={() => setTab('UI / UI')}
      />
      <div className="chips chips-scrollable" role="tablist" aria-label="Settings categories" style={{ marginBottom: 14 }}>
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`chip${tab === t ? ' active' : ''}`}
            onClick={() => setTab(t)}
          >{t}</button>
        ))}
      </div>

      {tab === 'Appearance' && (
        <div className="card" style={{ padding: '6px 18px' }}>
          <Row label="Interface Style (3D UI)" hint="Choose between 3D Glassmorphism, Spatial UI, Neomorphism, Claymorphism, Neubrutalism, and Pixel Art" control={
            <KnoxSelect
              value={s.uiStyle || 'glassmorphism'}
              options={[
                { value: 'glassmorphism', label: 'Glassmorphism (3D Liquid Prism)' },
                { value: 'spatial_ui', label: 'Spatial UI (3D Vision Aurora)' },
                { value: 'neomorphism', label: 'Neomorphism (3D Studio Tactile)' },
                { value: 'claymorphism', label: 'Claymorphism (3D Sand Clay)' },
                { value: 'neubrutalism', label: 'Neubrutalism (3D Bold & Pop)' },
                { value: 'pixel_art', label: 'Pixel Art (3D 8-Bit Voxel)' },
              ]}
              onChange={(val) => void patch({ uiStyle: val as typeof s.uiStyle })}
              ariaLabel="Interface Style"
            />} />
          <LiveWallpaperSettings />
        </div>
      )}

      {tab === 'UI / UI' && (
        <div className="knox-ui-style-grid">
          <div style={{ gridColumn: '1 / -1', padding: '4px 2px', fontSize: 13, color: 'var(--text-2)' }}>
            Choose the responsive 3D design language for every screen, button, card, and player in KNOX Music.
          </div>

          {(s.uiStyle || 'glassmorphism') === 'glassmorphism' && (
            <div className="card" style={{ gridColumn: '1 / -1', padding: '8px 18px', marginBottom: 6 }}>
              <LiveWallpaperSettings />
            </div>
          )}

          {/* 1. Glassmorphism 3D Card */}
          <div
            className={`knox-ui-style-card knox-style-preview-glass${(s.uiStyle || 'glassmorphism') === 'glassmorphism' ? ' active' : ''}`}
            onClick={() => {
              void patch({ uiStyle: 'glassmorphism' });
              toast('Interface switched to 3D Glassmorphism');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void patch({ uiStyle: 'glassmorphism' });
                toast('Interface switched to 3D Glassmorphism');
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 16, fontWeight: 750, color: 'var(--text-1)' }}>Glassmorphism (3D Liquid Prism)</div>
              {(s.uiStyle || 'glassmorphism') === 'glassmorphism' ? (
                <span className="knox-ui-badge selected">Active</span>
              ) : (
                <span className="knox-ui-badge select-btn">Select</span>
              )}
            </div>
            <div className="knox-3d-mini-stage glass-stage" aria-hidden>
              <div className="knox-3d-mini-art glass-art">◈</div>
              <div className="knox-3d-mini-bars">
                <span style={{ height: 10 }} /><span style={{ height: 18 }} /><span style={{ height: 24 }} /><span style={{ height: 14 }} /><span style={{ height: 20 }} />
              </div>
              <div className="knox-3d-mini-btn glass-btn">▶</div>
            </div>
            <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.45 }}>
              Levitating 3D crystal prism cards, specular rim reflections, neon cyan refraction halos, and battery-saving live wallpaper.
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className="knox-ui-tag">3D Liquid Glass</span>
              <span className="knox-ui-tag">Live Wallpaper</span>
              <span className="knox-ui-tag">Spatial Depth</span>
            </div>
          </div>

          {/* 2. Spatial UI 3D Card */}
          <div
            className={`knox-ui-style-card knox-style-preview-spatial${s.uiStyle === 'spatial_ui' ? ' active' : ''}`}
            onClick={() => {
              void patch({ uiStyle: 'spatial_ui' });
              toast('Interface switched to 3D Spatial UI');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void patch({ uiStyle: 'spatial_ui' });
                toast('Interface switched to 3D Spatial UI');
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 16, fontWeight: 750, color: 'var(--text-1)' }}>Spatial UI (3D Vision Aurora)</div>
              {s.uiStyle === 'spatial_ui' ? (
                <span className="knox-ui-badge selected">Active</span>
              ) : (
                <span className="knox-ui-badge select-btn">Select</span>
              )}
            </div>
            <div className="knox-3d-mini-stage spatial-stage" aria-hidden>
              <div className="knox-3d-mini-art spatial-art">✦</div>
              <div className="knox-3d-mini-bars">
                <span style={{ height: 12 }} /><span style={{ height: 22 }} /><span style={{ height: 26 }} /><span style={{ height: 18 }} /><span style={{ height: 14 }} />
              </div>
              <div className="knox-3d-mini-btn spatial-btn">▶</div>
            </div>
            <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.45 }}>
              Immersive 3D VisionOS spatial audio deck with cosmic aurora-indigo &amp; sonic-cyan lighting, floating holographic depth layers, and 3D orbital gyroscope rings.
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className="knox-ui-tag">3D Orbital Stage</span>
              <span className="knox-ui-tag">Aurora Violet/Cyan</span>
              <span className="knox-ui-tag">Vision Depth</span>
            </div>
          </div>

          {/* 3. Neomorphism 3D Card */}
          <div
            className={`knox-ui-style-card knox-style-preview-neomorph${s.uiStyle === 'neomorphism' ? ' active' : ''}`}
            onClick={() => {
              void patch({ uiStyle: 'neomorphism' });
              toast('Interface switched to 3D Neomorphism');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void patch({ uiStyle: 'neomorphism' });
                toast('Interface switched to 3D Neomorphism');
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 16, fontWeight: 750, color: 'var(--text-1)' }}>Neomorphism (3D Studio Tactile)</div>
              {s.uiStyle === 'neomorphism' ? (
                <span className="knox-ui-badge selected">Active</span>
              ) : (
                <span className="knox-ui-badge select-btn">Select</span>
              )}
            </div>
            <div className="knox-3d-mini-stage neomorph-stage" aria-hidden>
              <div className="knox-3d-mini-art neomorph-art">◎</div>
              <div className="knox-3d-mini-bars">
                <span style={{ height: 10 }} /><span style={{ height: 20 }} /><span style={{ height: 25 }} /><span style={{ height: 15 }} /><span style={{ height: 18 }} />
              </div>
              <div className="knox-3d-mini-btn neomorph-btn">▶</div>
            </div>
            <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.45 }}>
              Tactile 3D audiophile studio slate with soft dual-shadow extruded hardware keys, recessed acoustic speaker dial, and warm sonic coral-amber LEDs.
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className="knox-ui-tag">3D Extruded Slate</span>
              <span className="knox-ui-tag">Acoustic Dial</span>
              <span className="knox-ui-tag">Sonic Coral LED</span>
            </div>
          </div>

          {/* 4. Claymorphism 3D Card */}
          <div
            className={`knox-ui-style-card knox-style-preview-clay${s.uiStyle === 'claymorphism' ? ' active' : ''}`}
            onClick={() => {
              void patch({ uiStyle: 'claymorphism' });
              toast('Interface switched to 3D Claymorphism');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void patch({ uiStyle: 'claymorphism' });
                toast('Interface switched to 3D Claymorphism');
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 16, fontWeight: 750, color: 'var(--text-1)' }}>Claymorphism (3D Clay &amp; Vinyl)</div>
              {s.uiStyle === 'claymorphism' ? (
                <span className="knox-ui-badge selected">Active</span>
              ) : (
                <span className="knox-ui-badge select-btn">Select</span>
              )}
            </div>
            <div className="knox-3d-mini-stage clay-stage" aria-hidden>
              <div className="knox-3d-mini-art clay-art">◉</div>
              <div className="knox-3d-mini-bars">
                <span style={{ height: 12 }} /><span style={{ height: 22 }} /><span style={{ height: 16 }} /><span style={{ height: 24 }} /><span style={{ height: 14 }} />
              </div>
              <div className="knox-3d-mini-btn clay-btn">▶</div>
            </div>
            <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.45 }}>
              Warm sandstone aesthetic (#e4d8c8), inflated 3D puffy clay cushions, embossed dome buttons, sunken wells, and 3D vinyl turntable deck.
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className="knox-ui-tag">3D Puffy Clay</span>
              <span className="knox-ui-tag">Warm Sandstone</span>
              <span className="knox-ui-tag">3D Vinyl Turntable</span>
            </div>
          </div>

          {/* 5. Neubrutalism 3D Card */}
          <div
            className={`knox-ui-style-card knox-style-preview-brutal${s.uiStyle === 'neubrutalism' ? ' active' : ''}`}
            onClick={() => {
              void patch({ uiStyle: 'neubrutalism' });
              toast('Interface switched to 3D Neubrutalism');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void patch({ uiStyle: 'neubrutalism' });
                toast('Interface switched to 3D Neubrutalism');
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 16, fontWeight: 850, color: 'var(--text-1)' }}>Neubrutalism (3D Bold &amp; Pop)</div>
              {s.uiStyle === 'neubrutalism' ? (
                <span className="knox-ui-badge selected">Active</span>
              ) : (
                <span className="knox-ui-badge select-btn">Select</span>
              )}
            </div>
            <div className="knox-3d-mini-stage brutal-stage" aria-hidden>
              <div className="knox-3d-mini-art brutal-art">★</div>
              <div className="knox-3d-mini-bars">
                <span style={{ height: 14 }} /><span style={{ height: 24 }} /><span style={{ height: 18 }} /><span style={{ height: 22 }} /><span style={{ height: 12 }} />
              </div>
              <div className="knox-3d-mini-btn brutal-btn">▶</div>
            </div>
            <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.45 }}>
              Isometric 3D block extrusions, thick 3px ink outlines, hard 3D offset shadows, Canary Yellow &amp; Pop Pink layers, and mechanical keycap press.
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className="knox-ui-tag">3D Hard Blocks</span>
              <span className="knox-ui-tag">Mechanical Keycaps</span>
              <span className="knox-ui-tag">Canary Pop</span>
            </div>
          </div>

          {/* 6. Pixel Art 3D Card */}
          <div
            className={`knox-ui-style-card knox-style-preview-pixel${s.uiStyle === 'pixel_art' ? ' active' : ''}`}
            onClick={() => {
              void patch({ uiStyle: 'pixel_art' });
              toast('Interface switched to 3D Pixel Art');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                void patch({ uiStyle: 'pixel_art' });
                toast('Interface switched to 3D Pixel Art');
              }
            }}
            role="button"
            tabIndex={0}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <div style={{ fontSize: 16, fontWeight: 750, color: 'var(--text-1)', fontFamily: 'monospace' }}>Pixel Art (3D 8-Bit Voxel)</div>
              {s.uiStyle === 'pixel_art' ? (
                <span className="knox-ui-badge selected">Active</span>
              ) : (
                <span className="knox-ui-badge select-btn">Select</span>
              )}
            </div>
            <div className="knox-3d-mini-stage pixel-stage" aria-hidden>
              <div className="knox-3d-mini-art pixel-art">▣</div>
              <div className="knox-3d-mini-bars">
                <span style={{ height: 8 }} /><span style={{ height: 16 }} /><span style={{ height: 24 }} /><span style={{ height: 16 }} /><span style={{ height: 20 }} />
              </div>
              <div className="knox-3d-mini-btn pixel-btn">▶</div>
            </div>
            <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-2)', lineHeight: 1.45, fontFamily: 'monospace' }}>
              3D voxel stepped bevels, 16-bit arcade cabinet sound-test monitor, CRT phosphor green &amp; electric cyan glow, and microswitch push buttons.
            </p>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <span className="knox-ui-tag">3D Voxel Bevels</span>
              <span className="knox-ui-tag">CRT Cabinet</span>
              <span className="knox-ui-tag">8-Bit Chiptune</span>
            </div>
          </div>
        </div>
      )}

      {tab === 'Playback' && (
        <div className="card" style={{ padding: '6px 18px' }}>
          <Row label="Autoplay" hint="Continue to related tracks when the queue ends" control={<Switch label="Autoplay" checked={s.autoplay} onChange={(v) => void patch({ autoplay: v })} />} />
          <Row label="Real-Time Up Next (YouTube, Spotify, JioSaavn)" hint="Playing a song auto-generates a real-time station playlist and populates the Up Next queue" control={<Switch label="YouTube Up Next" checked={s.youtubeUpNext !== false} onChange={(v) => void patch({ youtubeUpNext: v })} />} />
          <Row label="Repeat" hint="Off stops at the end · All loops the queue · One repeats the song" control={
            <KnoxSelect
              value={s.repeatMode}
              options={[
                { value: 'OFF', label: 'Off' },
                { value: 'ALL', label: 'All' },
                { value: 'ONE', label: 'One' },
              ]}
              onChange={(val) => {
                const v = val as typeof s.repeatMode;
                void patch({ repeatMode: v });
                try { import('../audio/playerStore').then(({ usePlayer }) => usePlayer.getState().setRepeat(v)); } catch { /* best-effort */ }
              }}
              ariaLabel="Repeat mode"
            />} />
          <Row label="Remember playback position" control={<Switch label="Remember playback position" checked={s.rememberPosition} onChange={(v) => void patch({ rememberPosition: v })} />} />
          <OutputDeviceRow />
          <Row label="Resume previous song" control={<Switch label="Resume previous song" checked={s.resumePrevious} onChange={(v) => void patch({ resumePrevious: v })} />} />
          <Row label="Resume playback automatically" hint="Never autoplays unless you enable this" control={<Switch label="Resume playback automatically" checked={s.resumeAutoplay} onChange={(v) => void patch({ resumeAutoplay: v })} />} />
          <SmartCacheSettings />
        </div>
      )}

      {tab === 'Downloads' && (
        <div className="card" style={{ padding: '6px 18px' }}>
          <Row label="Wi-Fi only" hint="Download using mobile data is off" control={<Switch label="Wi-Fi only" checked={s.wifiOnly} onChange={(v) => void patch({ wifiOnly: v })} />} />
          <Row label="Audio quality" hint={`High ≈ ${formatBytes(qualityBytesPerSong('High'))} per song`} control={
            <KnoxSelect
              value={s.offlineQuality}
              options={(['Low', 'Normal', 'High', 'Best Available'] as const).map((q) => ({
                value: q,
                label: `${q} — ~${formatBytes(qualityBytesPerSong(q))}/song`,
              }))}
              onChange={(val) => void patch({ offlineQuality: val as typeof s.offlineQuality })}
              ariaLabel="Offline audio quality"
            />} />
          <Row label="Maximum storage" control={
            <KnoxSelect
              value={String(s.maxOfflineBytes)}
              options={[
                { value: String(500 * 1024 * 1024), label: '500 MB' },
                { value: String(1024 * 1024 * 1024), label: '1 GB' },
                { value: String(2 * 1024 * 1024 * 1024), label: '2 GB' },
                { value: String(5 * 1024 * 1024 * 1024), label: '5 GB' },
                { value: String(10 * 1024 * 1024 * 1024), label: '10 GB' },
                { value: '-1', label: 'Unlimited' },
              ]}
              onChange={(val) => void patch({ maxOfflineBytes: Number(val) })}
              ariaLabel="Maximum offline storage"
            />} />
          <Row label="Automatically save played songs" hint="OFF by default — KNOX never consumes storage unexpectedly" control={<Switch label="Automatically save played songs" checked={s.autoSavePlayed} onChange={(v) => void patch({ autoSavePlayed: v })} />} />
        </div>
      )}

      {tab === 'Notifications' && (
        <div className="card" style={{ padding: '6px 18px' }}>
          <Row label="Download complete" control={<Switch label="Download complete" checked={s.notifDownloadComplete} onChange={(v) => void patch({ notifDownloadComplete: v })} />} />
          <Row label="Download failed" control={<Switch label="Download failed" checked={s.notifDownloadFailed} onChange={(v) => void patch({ notifDownloadFailed: v })} />} />
          <Row label="Playback notifications" hint="OS media controls via Media Session API" control={<Switch label="Playback notifications" checked={s.notifPlayback} onChange={(v) => void patch({ notifPlayback: v })} />} />
          <div style={{ padding: '12px 0', fontSize: 13, color: 'var(--text-2)' }}>
            Lock-screen and headset controls work through the system media session — no extra
            permission needed for those. Manage every OS grant in one place:
          </div>
          <div style={{ padding: '0 0 14px' }}>
            <button className="btn" onClick={() => go('permissions')}>Open App permissions</button>
          </div>
        </div>
      )}

      {tab === 'Network' && (
        <div className="card" style={{ padding: '6px 18px' }}>
          <OfflineModeRow />
          <Row label="Max concurrent downloads" control={
            <KnoxSelect
              value={String(s.maxConcurrentDownloads)}
              options={[1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
              onChange={(val) => void patch({ maxConcurrentDownloads: Number(val) })}
              ariaLabel="Max concurrent downloads"
            />} />
          <Row label="Request timeout" control={
            <KnoxSelect
              value={String(s.requestTimeoutSec)}
              options={[10, 15, 30, 60].map((n) => ({ value: String(n), label: `${n} sec` }))}
              onChange={(val) => void patch({ requestTimeoutSec: Number(val) })}
              ariaLabel="Request timeout"
            />} />
        </div>
      )}

      {tab === 'Providers' && <ProvidersPanel />}
      {tab === 'Advanced' && <AdvancedPanel go={go} />}
    </div>
  );
}

function OfflineModeRow() {
  const offlineMode = usePlayer((s) => s.offlineMode);
  const setOfflineMode = usePlayer((s) => s.setOfflineMode);
  return (
    <Row
      label="Offline mode"
      hint="Local music only — search and playback skip online sources. Status stays visible in each header indicator."
      control={
        <Switch
          label="Offline mode"
          checked={offlineMode}
          onChange={(v) => {
            setOfflineMode(v);
            toast(v ? '⊘ Offline mode — local music only' : 'Online mode');
          }}
        />
      }
    />
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
    return null;
  }
  return (
    <div className="setting-row">
      <div><div style={{ fontWeight: 650 }}>Audio output</div>
        <div style={{ fontSize: 12, color: 'var(--text-2)' }}>Respects OS routing; pick a device when available</div></div>
      <KnoxSelect
        value={outputDeviceId}
        options={[
          { value: 'default', label: 'System default' },
          ...devices.map((d) => ({ value: d.deviceId, label: d.label })),
        ]}
        ariaLabel="Audio output device"
        onChange={(id) => {
          import('../audio/AudioEngine').then(({ getAudioEngine }) => {
            getAudioEngine().setOutputDevice(id).then(
              () => { void patch({ outputDeviceId: id }); toast('Audio output changed'); },
              () => toast('Could not switch output', 'warn'),
            );
          });
        }}
      />
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
              Search {p.capabilities.supportsSearch ? 'Yes' : '—'} · Streaming {p.capabilities.supportsStreaming ? 'Yes' : '—'} ·
              Offline {p.capabilities.supportsOffline ? 'Yes, per-track license' : 'Not supported'}
              {p.id === 'youtube' && ' — in-app server (search, playback & permanent offline)'}
              {p.id === 'youtube-music' && ' — in-app server on 127.0.0.1 (no key, no login)'}
              {p.id === 'spotify' && ' — in-app server (catalog search, URL/URI & playback)'}
              {p.id === 'jiosaavn' && ' — in-app server (catalog search, 320kbps AAC & playback)'}
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
    toast('Backup exported (metadata only, no audio)');
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
      toast('Backup restored');
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
