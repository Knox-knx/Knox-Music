import React, { useState } from 'react';
import { useSettings } from '../settings/settingsStore';
import { APP_VERSION } from '../appVersion';

const STEPS = [
  { icon: '⌕', title: 'Search', body: 'Find music from supported providers — or just your own local library.' },
  { icon: '▶', title: 'Play', body: 'Enjoy a powerful player with queue, sleep timer and offline support.' },
  { icon: '↓', title: 'Offline', body: 'Save supported music locally for offline listening. Your files stay yours.' },
  { icon: '◈', title: 'Private', body: 'Your library stays on your device. No account, no cloud, no tracking.' },
];

export function OnboardingScreen({ onDone }: { onDone: (mode: 'local' | 'online' | 'both') => void }) {
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState<'local' | 'online' | 'both'>('both');
  const patch = useSettings((s) => s.patch);

  const finish = () => {
    void patch({ onboarded: true });
    onDone(mode);
  };

  return (
    <div className="onboarding">
      <div className="onboarding-card glass">
        {step === 0 && (
          <>
            <img src="/icons/icon-192.png" alt="KNOX Music logo — black headphones with a white star in front of a vinyl record" width={112} height={112} className="knox-app-logo" style={{ width: 112, height: 112, borderRadius: 26, padding: 0, border: '1px solid var(--divider)' }} />
            <h1>KNOX Music</h1>
            <p style={{ color: 'var(--text-2)' }}>Your music. Your device. Your control.</p>
            <button className="btn btn-primary" onClick={() => setStep(1)}>Get Started</button>
          </>
        )}
        {step === 1 && (
          <>
            <h2>How do you want to use KNOX?</h2>
            {(['local', 'online', 'both'] as const).map((m) => (
              <label key={m} style={{ display: 'flex', gap: 10, alignItems: 'center', padding: 10, cursor: 'pointer' }}>
                <input type="radio" name="mode" checked={mode === m} onChange={() => setMode(m)} />
                {m === 'local' ? 'Local music' : m === 'online' ? 'Search online music' : 'Both'}
              </label>
            ))}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 12 }}>
              <button className="btn" onClick={() => setStep(0)}>Back</button>
              <button className="btn btn-primary" onClick={() => setStep(2)}>Continue</button>
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <div style={{ fontSize: 52 }} aria-hidden>{STEPS[Math.min(3, step - 2 + 0)].icon}</div>
            <OnboardingPager index={0} />
            <h2>Offline Music</h2>
            <p style={{ color: 'var(--text-2)' }}>Save supported songs for offline listening?</p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button className="btn" onClick={finish}>Configure Later</button>
              <button className="btn btn-primary" onClick={finish}>Configure Now</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function OnboardingPager({ index }: { index: number }) {
  void index;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, margin: '16px 0' }}>
      {STEPS.map((s) => (
        <div key={s.title} className="card" style={{ padding: 10 }}>
          <div style={{ fontSize: 24 }} aria-hidden>{s.icon}</div>
          <div style={{ fontWeight: 700, fontSize: 12 }}>{s.title}</div>
          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>{s.body}</div>
        </div>
      ))}
    </div>
  );
}

export function AboutScreen() {
  return (
    <div style={{ maxWidth: 640 }}>
      <div className="brand" style={{ paddingLeft: 0 }}>
        <div className="brand-mark" aria-hidden>
          <img src="/icons/icon-192.png" alt="" width={36} height={36} />
        </div>
        <div><div className="brand-name">KNOX MUSIC</div><div className="brand-sub">VERSION {APP_VERSION}</div></div>
      </div>
      <p>A local-first music experience. Your music, your device, your control.</p>
      <div className="card" style={{ padding: 18 }}>
        <h3>Open Source (MIT)</h3>
        <ul style={{ fontSize: 13.5, color: 'var(--text-2)' }}>
          <li>React + Vite + TypeScript + Dexie (IndexedDB)</li>
          <li>Demo catalog: SoundHelix sample tracks (for testing)</li>
          <li>Optional online sources: Jamendo, Internet Archive, FreeToUse, AirBeats, Radio Browser, YouTube Music discovery</li>
          <li>Licenses, privacy notes and third-party attributions live in <code>docs/</code></li>
        </ul>
      </div>

      <div className="card" style={{ padding: 18, marginTop: 12 }}>
        <h3>Credits</h3>
        <p style={{ fontSize: 13.5, color: 'var(--text-2)', margin: '0 0 10px' }}>
          Designed &amp; built by <strong>Louis</strong> — KNOX Music is a local-first,
          privacy-respecting music app. No account, no cloud, no tracking: your
          library stays on your device.
        </p>
        <ul style={{ fontSize: 13.5, color: 'var(--text-2)', display: 'grid', gap: 6, margin: 0, paddingLeft: 18 }}>
          <li>Telegram: <a href="https://t.me/LouisPy" target="_blank" rel="noreferrer">@LouisPy</a></li>
          <li>Discord: <code>louisjava</code></li>
          <li>X / Twitter: <a href="https://x.com/inc9z" target="_blank" rel="noreferrer">@inc9z</a></li>
          <li>GitHub: <a href="https://github.com/knox-knx" target="_blank" rel="noreferrer">@knox-knx</a></li>
          <li>Email: <a href="mailto:dev.louis.support@gmail.com">dev.louis.support@gmail.com</a></li>
        </ul>
      </div>

      <div className="card" style={{ padding: 18, marginTop: 12 }}>
        <h3>Donation</h3>
        <p style={{ fontSize: 13.5, color: 'var(--text-2)', margin: '0 0 10px' }}>
          KNOX Music is free and open source. If you&apos;d like to support
          development, donations are welcome — please get in touch first so we
          can arrange a method that works for you.
        </p>
        <ul style={{ fontSize: 13.5, color: 'var(--text-2)', display: 'grid', gap: 6, margin: 0, paddingLeft: 18 }}>
          <li>Email: <a href="mailto:dev.louis.support@gmail.com">dev.louis.support@gmail.com</a></li>
          <li>Telegram: <a href="https://t.me/LouisPy" target="_blank" rel="noreferrer">@LouisPy</a></li>
        </ul>
      </div>

      <div className="card" style={{ padding: 18, marginTop: 12 }}>
        <h3>Veritas Amoris (Truth of Love)</h3>
        <p style={{ fontSize: 13.5, color: 'var(--text-2)', margin: '0 0 10px' }}>
          A religion of truth and love.
        </p>
        <ul style={{ fontSize: 13.5, color: 'var(--text-2)', display: 'grid', gap: 6, margin: 0, paddingLeft: 18 }}>
          <li>Founder: <strong>Louis</strong></li>
          <li>GOD of RELIGION: <strong>Love, Truth &amp; Honesty</strong></li>
        </ul>
      </div>
    </div>
  );
}
