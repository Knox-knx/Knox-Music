// Local-only logger. Never logs secrets, tokens, or file contents.

type Level = 'debug' | 'info' | 'warn' | 'error';

const REDACT = [/password/i, /token/i, /secret/i, /api[-_]?key/i, /auth/i];

function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    return REDACT.some((r) => r.test(value)) ? '[redacted]' : value.slice(0, 2000);
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT.some((r) => r.test(k)) ? '[redacted]' : v;
    }
    return out;
  }
  return value;
}

function emit(level: Level, scope: string, message: string, data?: unknown) {
  const line = `[knox:${scope}] ${message}`;
  const payload = data === undefined ? [] : [redact(data)];
  if (level === 'error') console.error(line, ...payload);
  else if (level === 'warn') console.warn(line, ...payload);
  else if (level === 'debug') console.debug(line, ...payload);
  else console.info(line, ...payload);
  try {
    const raw = localStorage.getItem('knox.logs');
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    arr.push(`${new Date().toISOString()} ${level} ${scope} ${message}`);
    localStorage.setItem('knox.logs', JSON.stringify(arr.slice(-300)));
  } catch { /* storage may be unavailable */ }
}

export const logger = {
  debug: (s: string, m: string, d?: unknown) => emit('debug', s, m, d),
  info: (s: string, m: string, d?: unknown) => emit('info', s, m, d),
  warn: (s: string, m: string, d?: unknown) => emit('warn', s, m, d),
  error: (s: string, m: string, d?: unknown) => emit('error', s, m, d),
};

export function getLocalLogs(): string[] {
  try { return JSON.parse(localStorage.getItem('knox.logs') || '[]') as string[]; }
  catch { return []; }
}
