import { describe, it, expect } from 'vitest';
import { parseLrc, activeLyricIndex } from '../../src/library/lyrics';

describe('parseLrc', () => {
  it('parses synchronized lines', () => {
    const lines = parseLrc('[00:01.00] Hello\n[00:05.50] World\n');
    expect(lines).toHaveLength(2);
    expect(lines![0]).toEqual({ timeMs: 1000, text: 'Hello' });
    expect(lines![1]).toEqual({ timeMs: 5500, text: 'World' });
  });

  it('supports mm:ss.cc and mm:ss.mmm variants', () => {
    const lines = parseLrc('[01:02.34] A\n[01:02.345] B\n[2:03] C\n');
    expect(lines![0].timeMs).toBe(62340);
    expect(lines![1].timeMs).toBe(62345);
    expect(lines![2].timeMs).toBe(123000);
  });

  it('returns null for non-lyric content (never invents lyrics)', () => {
    expect(parseLrc('just some text\nno timestamps')).toBeNull();
    expect(parseLrc('')).toBeNull();
  });

  it('sorts out-of-order lines', () => {
    const lines = parseLrc('[00:10.00] B\n[00:01.00] A\n');
    expect(lines!.map((l) => l.text)).toEqual(['A', 'B']);
  });
});

describe('activeLyricIndex', () => {
  const lines = [
    { timeMs: 0, text: 'A' },
    { timeMs: 5000, text: 'B' },
    { timeMs: 10000, text: 'C' },
  ];
  it('tracks playback position', () => {
    expect(activeLyricIndex(lines, 0)).toBe(0);
    expect(activeLyricIndex(lines, 4999)).toBe(0);
    expect(activeLyricIndex(lines, 5000)).toBe(1);
    expect(activeLyricIndex(lines, 99999)).toBe(2);
  });
});
