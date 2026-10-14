// Playback failure diagnostics (TEMP TESTING).
//
// Verbose console output for real-device debugging, including the
// single-line KNOX_PLAYBACK_DIAGNOSTIC (§25). All URLs are scrubbed to
// scheme + host only (no path/query/hash — signed URLs stay secret).
// Never logs tokens, cookies, or full URLs.

import type { Song } from '../core/types';

/** Pipeline stages for KNOX_PLAYBACK_DIAGNOSTIC (§25). */
export type DiagnosticStage =
  | 'PROVIDER'
  | 'AIRBEATS_SEARCH'
  | 'AIRBEATS_MAPPING'
  | 'GET_STREAM'
  | 'CACHE_LOOKUP'
  | 'CACHE_VALIDATION'
  | 'CACHE_READ'
  | 'CACHE_WRITE'
  | 'AUDIO_ASSIGN'
  | 'MEDIA_LOAD'
  | 'PLAY'
  | 'CLOCK'
  | 'CLEANUP';

export interface PlaybackDiagnostic {
  provider: string;
  track: string;
  cache: 'HIT' | 'MISS' | 'INVALID' | 'DISABLED' | 'BYPASS' | '-';
  source: 'CACHE' | 'PROVIDER' | 'OFFLINE' | 'RADIO' | '-';
  source_protocol: string;
  source_host: string;
  container: string;
  media_ready: string;
  play_called: boolean;
  play_resolved: boolean;
  play_rejected: string;
  current_time_before: string;
  current_time_after: string;
  clock_advancing: string;
  last_media_event: string;
  audio_error: string;
  stage: DiagnosticStage | string;
}

function scrubHost(url: string): { protocol: string; host: string } {
  if (!url) return { protocol: '-', host: '-' };
  try {
    const u = new URL(url, 'http://localhost');
    if (u.protocol === 'blob:' || u.protocol === 'data:') {
      return { protocol: u.protocol.replace(':', ''), host: '<local>' };
    }
    return { protocol: u.protocol.replace(':', ''), host: u.host || '-' };
  } catch {
    return { protocol: '<unparseable>', host: '-' };
  }
}

/** Build the single-line §25 diagnostic (scrubbed — safe to paste). */
export function buildPlaybackDiagnostic(input: {
  song: Song;
  cache?: PlaybackDiagnostic['cache'];
  source?: PlaybackDiagnostic['source'];
  sourceUrl?: string;
  container?: string | null;
  mediaReady?: string | null;
  playCalled?: boolean;
  playResolved?: boolean;
  playRejected?: unknown;
  timeBefore?: number | null;
  timeAfter?: number | null;
  clockAdvancing?: boolean | null;
  lastMediaEvent?: string | null;
  audioError?: string | null;
  stage: PlaybackDiagnostic['stage'];
}): PlaybackDiagnostic {
  const { protocol, host } = scrubHost(input.sourceUrl ?? '');
  const err = (e: unknown): string =>
    e === undefined || e === null || e === '' ? '-' : String(e).slice(0, 160);
  const ms = (t: number | null | undefined): string =>
    t === undefined || t === null ? '-' : String(Math.round(t));
  return {
    provider: input.song.providerId,
    track: `${input.song.title} — ${input.song.artist}`.slice(0, 120),
    cache: input.cache ?? '-',
    source: input.source ?? '-',
    source_protocol: protocol,
    source_host: host,
    container: input.container ?? '-',
    media_ready: input.mediaReady ?? '-',
    play_called: input.playCalled ?? false,
    play_resolved: input.playResolved ?? false,
    play_rejected: err(input.playRejected),
    current_time_before: ms(input.timeBefore),
    current_time_after: ms(input.timeAfter),
    clock_advancing:
      input.clockAdvancing === undefined || input.clockAdvancing === null
        ? '-'
        : String(input.clockAdvancing),
    last_media_event: input.lastMediaEvent ?? '-',
    audio_error: input.audioError ?? '-',
    stage: input.stage,
  };
}

/** Render as the pastable single line. */
export function formatPlaybackDiagnostic(d: PlaybackDiagnostic): string {
  return (
    `KNOX_PLAYBACK_DIAGNOSTIC provider=${d.provider} track="${d.track}" ` +
    `cache=${d.cache} source=${d.source} source_protocol=${d.source_protocol} ` +
    `source_host=${d.source_host} container=${d.container} media_ready=${d.media_ready} ` +
    `play_called=${d.play_called} play_resolved=${d.play_resolved} ` +
    `play_rejected=${d.play_rejected} current_time_before=${d.current_time_before} ` +
    `current_time_after=${d.current_time_after} clock_advancing=${d.clock_advancing} ` +
    `last_media_event=${d.last_media_event} audio_error=${d.audio_error} stage=${d.stage}`
  );
}

let lastDiagnostic: PlaybackDiagnostic | null = null;

/** Latest diagnostic snapshot (devtools/tests). */
export function getLastPlaybackDiagnostic(): PlaybackDiagnostic | null {
  return lastDiagnostic;
}

function scrub(url: string): string | null {
  if (!url) return null;
  try {
    const u = new URL(url, 'http://localhost');
    if (u.protocol === 'blob:' || u.protocol === 'data:') return `${u.protocol}//<local>`;
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<unparseable>';
  }
}

export interface FailureContext {
  stage:
    | 'resolve'
    | 'preflight'
    | 'temp-prepare'
    | 'temp-download'
    | 'engine-assign'
    | 'engine-play'
    | 'clock'
    | 'element-error'
    | 'local-play';
  attempt?: number;
  generation?: number;
  sourceKind?: string | null;
  sessionId?: string | null;
  mimeType?: string | null;
  container?: string | null;
  extension?: string | null;
  bytes?: number | null;
  validationReason?: string | null;
  engineState?: unknown;
  mediaError?: string | null;
  eventTrail?: string;
  hint?: string;
}

/**
 * Verbose, scrubbed failure dump. Always console.error (visible in
 * `cargo tauri dev` terminal + DevTools), plus logger.error for the file.
 */
export function printPlaybackFailure(song: Song, error: unknown, ctx: FailureContext): void {
  const raw = error instanceof Error ? error.message : String(error ?? 'unknown');
  const lines = [
    `━━━━ KNOX PLAYBACK FAILURE [${ctx.stage}] ━━━━`,
    `track      : ${song.title} — ${song.artist}`,
    `id         : ${song.id}`,
    `provider   : ${song.providerId} / ${song.providerTrackId}`,
    `snapshot   : streamUrl=${scrub(song.streamUrl ?? '') ?? 'none'} sourceUrl=${scrub(song.sourceUrl ?? '') ?? 'none'}`,
    `generation : ${ctx.generation ?? '-'}`,
    `attempt    : ${ctx.attempt ?? '-'}`,
    `sourceKind : ${ctx.sourceKind ?? '-'}`,
    `session    : ${ctx.sessionId?.slice(0, 8) ?? '-'}`,
    `mime       : ${ctx.mimeType ?? '-'} container=${ctx.container ?? '-'} ext=${ctx.extension ?? '-'} bytes=${ctx.bytes ?? '-'}`,
    `validation : ${ctx.validationReason ?? '-'}`,
    `mediaError : ${ctx.mediaError ?? '-'}`,
    `trail      : ${ctx.eventTrail ?? '-'}`,
    `raw error  : ${raw.slice(0, 400)}`,
    ctx.hint ? `hint       : ${ctx.hint}` : '',
    `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`,
  ].filter(Boolean);
  try {
    console.error(lines.join('\n'));
  } catch { /* console may be unavailable */ }
  try {
    const diag = buildPlaybackDiagnostic({
      song,
      sourceUrl: song.streamUrl,
      playRejected: raw,
      audioError: ctx.mediaError,
      lastMediaEvent: (ctx.eventTrail ?? '').split('>').filter(Boolean).pop() ?? '-',
      stage: mapStage(ctx.stage),
    });
    lastDiagnostic = diag;
    try {
      console.error(formatPlaybackDiagnostic(diag));
    } catch { /* ignore */ }
  } catch { /* diagnostics never break playback */ }
  try {
    void import('../core/logger').then(({ logger }) => {
      logger.error('player-temp-test', `FAIL [${ctx.stage}] ${song.providerId}:${song.providerTrackId}`, {
        stage: ctx.stage,
        provider: song.providerId,
        generation: ctx.generation ?? null,
        sourceKind: ctx.sourceKind ?? null,
        validation: ctx.validationReason ?? null,
        mediaError: ctx.mediaError ?? null,
        trail: ctx.eventTrail ?? null,
        raw: raw.slice(0, 300),
      });
    }).catch(() => undefined);
  } catch { /* logger never breaks playback */ }
}

/** Map internal failure stages onto the §25 diagnostic stage vocabulary. */
function mapStage(stage: FailureContext['stage']): DiagnosticStage | string {
  switch (stage) {
    case 'resolve':
      return 'GET_STREAM';
    case 'preflight':
      return 'GET_STREAM';
    case 'local-play':
      return 'PLAY';
    case 'clock':
      return 'CLOCK';
    case 'engine-assign':
      return 'AUDIO_ASSIGN';
    case 'engine-play':
      return 'PLAY';
    default:
      return 'PLAY';
  }
}

/** One-line stage marker (console.info, scrubbed). */
export function printPlaybackStage(stage: string, song: Song, extra?: Record<string, unknown>): void {
  try {
    console.info(
      `[knox:player-temp-test] ${stage} provider=${song.providerId} track=${song.providerTrackId} ` +
        Object.entries(extra ?? {})
          .map(([k, v]) => `${k}=${String(v)}`)
          .join(' '),
    );
  } catch { /* ignore */ }
}
