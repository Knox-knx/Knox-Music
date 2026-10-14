// Audio focus & route interruptions — web-honest OS behavior.
//
// What the web platform actually reports:
//   - Transient loss (phone call, voice assistant, another app's short
//     sound): the OS pauses our <audio> element. The element 'pause' event
//     arrives WITHOUT any store pause path running first —
//     engine.consumeUserPause() tells the two apart.
//   - Permanent loss (another music app takes focus): same 'pause', but the
//     page stays visible and outputs don't change — we stop (stay paused)
//     and let the media-session sync publish the paused card. No auto-resume.
//   - Headset/Bluetooth unplug: `devicechange` shrinks the audiooutput list
//     while playing → auto-pause + toast (never keep blasting through the
//     phone speaker).
//
// Resume rule (spec §1.4): resume automatically ONLY after a transient loss
// (page was hidden — the call case) AND only if the user hadn't manually
// paused. A device-removal pause or a visible-page pause never auto-resumes.
// Ducking is not available to web audio, so transient loss pauses instead
// of ducking — documented, not faked.

import { usePlayer } from '../audio/playerStore';
import { getAudioEngine } from '../audio/AudioEngine';
import { logger } from '../core/logger';
import { toast } from '../ui/toast';
import { isTauriAndroid } from './nativeMedia';

let initialized = false;
/** Set on transient (hidden-page) interruption; cleared on any manual action. */
let transientInterrupted = false;
/** Last known audiooutput count for unplug detection. */
let lastOutputCount: number | null = null;

async function countAudioOutputs(): Promise<number | null> {
  try {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return null;
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audiooutput').length;
  } catch {
    return null;
  }
}

let continuityAttemptsWhileHidden = 0;
const MAX_CONTINUITY_ATTEMPTS = 2;

function clearTransient(): void {
  transientInterrupted = false;
  continuityAttemptsWhileHidden = 0;
}

let lastContinuityAttemptAt = 0;
const CONTINUITY_COOLDOWN_MS = 2000;

/**
 * Background continuity: an unattended hidden-page pause is usually the
 * app being backgrounded (keep playing), not a call (pause, resume on
 * return). Attempt a few immediate element resumes while still hidden —
 * success means uninterrupted background audio; repeated rejection (focus
 * genuinely held elsewhere) falls through to the existing resume-on-return
 * path. Bounded and silent: never flips engine state, never toasts.
 */
async function tryBackgroundContinuity(): Promise<void> {
  const nowMs = Date.now();
  if (nowMs - lastContinuityAttemptAt > 4000) {
    continuityAttemptsWhileHidden = 0;
  }
  if (nowMs - lastContinuityAttemptAt < CONTINUITY_COOLDOWN_MS) {
    logger.info('audio', 'background continuity in cooldown — skipping rapid retry');
    return;
  }
  lastContinuityAttemptAt = nowMs;

  if (continuityAttemptsWhileHidden >= MAX_CONTINUITY_ATTEMPTS) {
    logger.info('audio', 'background continuity max retries reached while hidden — waiting for foreground resume');
    return;
  }
  continuityAttemptsWhileHidden += 1;

  let trackId: string | null = null;
  try {
    trackId = usePlayer.getState().current?.id ?? null;
  } catch {
    return;
  }
  if (!trackId) return;
  for (let i = 0; i < 2; i += 1) {
    try {
      if (!document.hidden) return;
    } catch {
      return;
    }
    try {
      await getAudioEngine().resumeElement();
    } catch {
      // Rejected (focus genuinely held elsewhere): wait a beat, retry once,
      // then fall through to resume-on-return.
      await new Promise((r) => setTimeout(r, 700));
      continue;
    }
    // Resumed — but only keep it if the user didn't move on mid-attempt
    // (headset skip/pause while hidden). A changed track means the resume
    // belongs to a stale element state: pause back, let the new track own it.
    let now: { current?: { id?: string } | null; state?: string } | null = null;
    try {
      now = usePlayer.getState();
    } catch {
      now = null;
    }
    if (now && now.current?.id !== trackId) {
      try {
        getAudioEngine().noteUserPause();
        getAudioEngine().pause();
      } catch {
        /* best-effort */
      }
      return;
    }
    logger.info('audio', 'background continuity resume succeeded — audio continues while hidden');
    transientInterrupted = false;
    return;
  }
  logger.info('audio', 'background resume refused — keeping resume-on-return fallback');
}

async function onEngineState(s: string): Promise<void> {
  if (s !== 'PAUSED') return;
  const st = usePlayer.getState();
  // Only genuine playback is an interruption candidate: a current track must
  // exist. Store-initiated pauses (toggle, sleep timer, stop, and every
  // track-switch teardown) arm the user-pause flag first, so they never
  // reach classification below.
  if (!st.current) return;
  let userPause = false;
  try {
    userPause = getAudioEngine().consumeUserPause();
  } catch {
    userPause = false;
  }
  if (userPause) {
    clearTransient();
    return;
  }
  // External pause while we believed we were playing.
  const hidden = (() => {
    try {
      return document.hidden;
    } catch {
      return false;
    }
  })();
  if (hidden) {
    // Backgrounded app (home/recent/switch) looks identical to a call at
    // the element level, but the desired outcome differs: keep playing.
    // The foreground service + unpaused WebView keep the process alive; if
    // the element still got paused, fight it immediately with a few bounded
    // resume attempts while hidden. A real call holds audio focus, so
    // play() rejects and we fall back to resume-on-return below.
    transientInterrupted = true;
    logger.info('audio', 'transient interruption (page hidden) — will resume on return if still paused');
    void tryBackgroundContinuity();
    return;
  }
  // Visible-page external pause: another app took focus (permanent loss)
  // or the route vanished. Stay paused, publish the paused card via the
  // normal store/media-session sync — never hold a dead session, never
  // auto-resume into another app's audio.
  clearTransient();
}

function onVisibility(): void {
  let hidden = true;
  try {
    hidden = document.hidden;
  } catch {
    return;
  }
  if (!hidden) {
    continuityAttemptsWhileHidden = 0;
    transientInterrupted = false;
  }
  if (hidden || !transientInterrupted) return;
  const st = usePlayer.getState();
  // Resume only the interrupted track, only if it is still paused (the user
  // may have pressed play already, or skipped — then there is nothing to do).
  if (st.current && st.state === 'PAUSED') {
    transientInterrupted = false;
    logger.info('audio', 'resuming after transient interruption');
    void st.play().catch(() => undefined);
  } else {
    transientInterrupted = false;
  }
}

async function onDevicesChanged(): Promise<void> {
  const st = usePlayer.getState();
  const now = await countAudioOutputs();
  if (now === null) return;
  const prev = lastOutputCount;
  lastOutputCount = now;
  if (prev === null || now >= prev) return;
  // An output disappeared mid-playback: headphones unplugged or BT speaker
  // disconnected. Auto-pause — staying paused (no auto-resume on reconnect).
  if ((st.state === 'PLAYING' || st.state === 'BUFFERING') && st.current) {
    try {
      getAudioEngine().noteUserPause(); // our own corrective pause, not an interruption
      getAudioEngine().pause();
    } catch {
      /* best-effort */
    }
    clearTransient();
    toast('Paused — audio device disconnected', 'warn');
    logger.info('audio', `output device removed (${prev} → ${now}) — auto-paused`);
  }
}

/** Explicitly reset continuity counters (e.g. on manual transport or activity resume). */
export function resetContinuityCounters(): void {
  continuityAttemptsWhileHidden = 0;
  transientInterrupted = false;
}

/**
 * Install interruption handling once (idempotent). Safe in tests and SSR
 * (all platform APIs guarded). Call from App boot.
 */
export function initAudioInterruptions(): void {
  if (initialized) return;
  initialized = true;
  try {
    getAudioEngine().onState((s) => {
      void onEngineState(s);
    });
  } catch {
    /* engine unavailable */
  }
  try {
    document.addEventListener('visibilitychange', onVisibility);
  } catch {
    /* ignore */
  }
  try {
    window.addEventListener('knox:activity-resumed', () => {
      resetContinuityCounters();
      logger.info('audio', 'knox:activity-resumed received — continuity counters reset');
    });
  } catch {
    /* ignore */
  }
  if (!isTauriAndroid()) {
    try {
      navigator.mediaDevices?.addEventListener?.('devicechange', () => {
        void onDevicesChanged();
      });
    } catch {
      /* device monitoring unsupported */
    }
  }
  void countAudioOutputs().then((n) => {
    lastOutputCount = n;
  });
  // Any manual transport action cancels a pending transient resume.
  try {
    usePlayer.subscribe((s) => {
      if (s.state === 'PLAYING') {
        clearTransient();
        continuityAttemptsWhileHidden = 0;
      }
    });
  } catch {
    /* subscribe unavailable */
  }
}

/** For tests: reset module state. */
export function __resetInterruptions(): void {
  initialized = false;
  transientInterrupted = false;
  lastOutputCount = null;
}
