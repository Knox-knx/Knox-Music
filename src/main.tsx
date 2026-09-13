import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles/global.css';
import { ErrorBoundary } from './ui/ErrorBoundary';
import { bootDesktop, shutdownDesktop, onBootPhase, type BootPhase } from './desktop/lifecycle';
import { logger } from './core/logger';

const PHASE_LABEL: Record<BootPhase, string> = {
  host: 'Starting KNOX Music…',
  api: 'Starting local API…',
  core: 'Loading your library…',
  sidecars: 'Checking optional services…',
  ready: 'Ready',
  degraded: 'Some online sources are unavailable. KNOX Music is running in degraded mode.',
};

// Splash checklist mirrors bootDesktop phases (host → api → core → sidecars →
// ready/degraded). Ticks are approximate progress, never a false promise:
// the UI becomes interactive only after bootDesktop settles.
const BOOT_STEPS = [
  'Local storage',
  'KNOX Core',
  'Local API',
  'YouTube Music discovery',
  'Search engine',
  'Audio engine',
];

const BOOT_TICKS: Record<BootPhase, number> = {
  host: 0,
  api: 1,
  core: 3,
  sidecars: 5,
  ready: 6,
  degraded: 6,
};

function splashHtml(phase: BootPhase): string {
  const ticks = BOOT_TICKS[phase];
  const steps = BOOT_STEPS.map((s, i) =>
    `<div style="display:flex;align-items:center;gap:8px;font-size:13px;` +
    `opacity:${i < ticks ? '0.95' : '0.45'}">` +
    `<span style="width:18px;text-align:center;color:${i < ticks ? '#4ade80' : 'inherit'}">` +
    `${i < ticks ? '✓' : '○'}</span><span>${s}</span></div>`,
  ).join('');
  const label = PHASE_LABEL[phase];
  const warn = phase === 'degraded'
    ? `<div style="font-size:12px;color:#fbbf24;max-width:340px;text-align:center">${label}</div>`
    : `<div id="knox-boot-label" style="font-size:13px;opacity:0.75">${label}</div>`;
  return (
    `<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;` +
    `height:100vh;background:#17130f;color:#f5f0e8;font-family:Georgia,serif;gap:14px">` +
    `<img src="/icons/icon-192.png" alt="KNOX Music logo" width="128" height="128" ` +
    `style="width:128px;height:128px;object-fit:contain;background:#f5f0e8;border-radius:30px;padding:2px;` +
    `border:1px solid #332b22;display:block" />` +
    `<div style="font-size:22px;font-weight:700;letter-spacing:0.04em">KNOX Music</div>` +
    `<div style="font-size:12px;opacity:0.6">Initializing local engine…</div>` +
    `<div style="display:flex;flex-direction:column;gap:6px">${steps}</div>` +
    `${warn}</div>`
  );
}

function renderSplash(phase: BootPhase): void {
  const root = document.getElementById('root');
  if (!root) return;
  // Never show a broken UI while the backend is unavailable — a lightweight
  // boot state instead. Inline styles: global.css may not have loaded yet.
  root.innerHTML = splashHtml(phase);
}

function updateSplash(phase: BootPhase): void {
  // Re-render ticks (cheap, pre-React) so the checklist advances with phases.
  const root = document.getElementById('root');
  if (root && root.innerHTML.includes('Initializing local engine')) {
    root.innerHTML = splashHtml(phase);
    return;
  }
  const label = document.getElementById('knox-boot-label');
  if (label) label.textContent = PHASE_LABEL[phase];
}

// Deterministic desktop startup (§18): the device is the server — no remote
// backend, no manual steps. bootDesktop connects the host, inits KNOX Core,
// reconciles sidecars, and never throws (worst case: degraded but usable).
renderSplash('host');
const offPhase = onBootPhase(updateSplash);

// Idempotent shutdown (§19): stop downloads → flush → stop sidecars → exit.
let shutdownOnce = false;
function shutdown(): void {
  if (shutdownOnce) return;
  shutdownOnce = true;
  void shutdownDesktop().catch(() => undefined);
}
window.addEventListener('beforeunload', shutdown);
window.addEventListener('pagehide', shutdown);

void bootDesktop()
  .catch((e) => logger.error('init', 'desktop boot failed (isolated)', String(e)))
  .finally(() => {
    offPhase();
    ReactDOM.createRoot(document.getElementById('root')!).render(
      <React.StrictMode>
        <ErrorBoundary area="root">
          <App />
        </ErrorBoundary>
      </React.StrictMode>,
    );
  });
