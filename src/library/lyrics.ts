import type { LyricLine } from '../core/types';

/** Parse .lrc synchronized lyrics. Returns null when content is not valid LRC. */
export function parseLrc(text: string): LyricLine[] | null {
  const lines: LyricLine[] = [];
  const re = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\](.*)/;
  for (const raw of text.split(/\r?\n/)) {
    const m = re.exec(raw.trim());
    if (!m) continue;
    const min = Number(m[1]);
    const sec = Number(m[2]);
    let ms = 0;
    if (m[3]) {
      const frac = m[3];
      ms = frac.length === 3 ? Number(frac) : Number(frac) * (frac.length === 2 ? 10 : 100);
    }
    const timeMs = (min * 60 + sec) * 1000 + ms;
    const line = m[4].trim();
    if (!line) continue;
    lines.push({ timeMs, text: line });
  }
  if (lines.length === 0) return null;
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

export function activeLyricIndex(lines: LyricLine[], positionMs: number): number {
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].timeMs <= positionMs) idx = i;
    else break;
  }
  return idx;
}
