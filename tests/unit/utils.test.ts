import { describe, it, expect } from 'vitest';
import {
  formatMs, formatBytes, sanitizeFilename, isSafeUrl, stableId, clamp, greetingForHour,
} from '../../src/core/utils';
import { messageForProviderError, ProviderError } from '../../src/core/errors';

describe('formatters', () => {
  it('formatMs handles edge cases', () => {
    expect(formatMs(0)).toBe('0:00');
    expect(formatMs(61000)).toBe('1:01');
    expect(formatMs(3723000)).toBe('62:03');
    expect(formatMs(undefined)).toBe('0:00');
    expect(formatMs(-5)).toBe('0:00');
  });
  it('formatBytes scales units', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1536)).toContain('KB');
    expect(formatBytes(8 * 1024 * 1024)).toContain('MB');
  });
});

describe('security helpers', () => {
  it('sanitizeFilename blocks path traversal', () => {
    expect(sanitizeFilename('../../etc/passwd')).not.toContain('..');
    expect(sanitizeFilename('Song: "Best" / Ever?')).not.toMatch(/[/:*?"<>|]/);
    expect(sanitizeFilename('')).toBeTruthy();
  });
  it('isSafeUrl rejects javascript: and trusts https/blob images only', () => {
    expect(isSafeUrl('https://example.com/a.mp3')).toBe(true);
    expect(isSafeUrl('http://example.com/a.mp3')).toBe(true);
    expect(isSafeUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeUrl('file:///etc/passwd')).toBe(false);
    expect(isSafeUrl('data:text/html,<script>')).toBe(false);
  });
});

describe('misc', () => {
  it('stableId joins provider + track', () => {
    expect(stableId('sample', '1')).toBe('sample:1');
  });
  it('clamp bounds values', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-1, 0, 1)).toBe(0);
  });
  it('greetingForHour varies by time', () => {
    expect(greetingForHour(8)).toBe('Good morning');
    expect(greetingForHour(20)).toBe('Good evening');
  });
});

describe('provider error messages', () => {
  it('maps codes to honest user-facing copy', () => {
    expect(messageForProviderError(new ProviderError('TIMEOUT', 'x'))).toMatch(/taking too long/);
    expect(messageForProviderError(new ProviderError('RATE_LIMIT', 'x'))).toMatch(/limited/);
    expect(messageForProviderError(new ProviderError('NETWORK', 'x'))).toMatch(/offline/);
    expect(messageForProviderError(new Error('boom'))).toBe('Unable to load results.');
  });
});
