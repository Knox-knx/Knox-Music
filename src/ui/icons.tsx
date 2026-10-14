import React from 'react';

// KNOX icon set — inline stroke SVGs (currentColor, 24 grid). Replaces every
// emoji/dingbat glyph in interactive UI so controls render identically on
// every Android WebView font (emoji fonts vary by vendor and break the
// monochrome glass aesthetic). Text glyphs that are NOT emoji (▶ ❚❚ ✕ ✓ ⋮
// · …) stay as text where they already render consistently.

export type IconName =
  | 'play' | 'pause' | 'next' | 'prev' | 'rewindDouble' | 'fastForwardDouble'
  | 'heart' | 'heartOutline' | 'plus' | 'list' | 'user' | 'pencil'
  | 'close' | 'check' | 'download' | 'external' | 'refresh'
  | 'search' | 'home' | 'house' | 'database' | 'musicNote' | 'radio' | 'disc' | 'quote'
  | 'settings' | 'bell' | 'bellOff' | 'wifi' | 'wifiOff'
  | 'volume' | 'volumeX' | 'speakerLow' | 'speakerHigh' | 'expand' | 'clock' | 'info' | 'spark'
  | 'dot' | 'warn' | 'filter' | 'shuffle' | 'repeat' | 'moon' | 'folder';

function paths(name: IconName): React.ReactNode {
  switch (name) {
    case 'play':
      return <path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />;
    case 'pause':
      return (
        <>
          <rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
          <rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none" />
        </>
      );
    case 'next':
      return (
        <>
          <path d="M5 5l8 7-8 7z" fill="currentColor" stroke="none" />
          <path d="M17 5v14" />
        </>
      );
    case 'prev':
      return (
        <>
          <path d="M19 5l-8 7 8 7z" fill="currentColor" stroke="none" />
          <path d="M7 5v14" />
        </>
      );
    case 'rewindDouble':
      return (
        <>
          <path d="M11 5l-8 7 8 7V5z" fill="currentColor" stroke="none" />
          <path d="M21 5l-8 7 8 7V5z" fill="currentColor" stroke="none" />
        </>
      );
    case 'fastForwardDouble':
      return (
        <>
          <path d="M3 5l8 7-8 7V5z" fill="currentColor" stroke="none" />
          <path d="M13 5l8 7-8 7V5z" fill="currentColor" stroke="none" />
        </>
      );
    case 'speakerLow':
      return (
        <>
          <path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor" stroke="none" />
          <path d="M15.5 9.5a3.5 3.5 0 0 1 0 5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </>
      );
    case 'speakerHigh':
      return (
        <>
          <path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor" stroke="none" />
          <path d="M15 9a4 4 0 0 1 0 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          <path d="M18.5 6.5a8 8 0 0 1 0 11" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </>
      );
    case 'heart':
      return <path d="M19.5 12.6 12 20l-7.5-7.4A5 5 0 1 1 12 6.3a5 5 0 1 1 7.5 6.3z" fill="currentColor" stroke="none" />;
    case 'heartOutline':
      return <path d="M19.5 12.6 12 20l-7.5-7.4A5 5 0 1 1 12 6.3a5 5 0 1 1 7.5 6.3z" />;
    case 'plus':
      return <path d="M12 5v14M5 12h14" />;
    case 'list':
      return (
        <>
          <path d="M8 6h13M8 12h13M8 18h13" />
          <circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" />
          <circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" />
          <circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" />
        </>
      );
    case 'user':
      return (
        <>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" />
        </>
      );
    case 'pencil':
      return <path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />;
    case 'close':
      return <path d="M18 6 6 18M6 6l12 12" />;
    case 'check':
      return <path d="M20 6 9 17l-5-5" />;
    case 'download':
      return (
        <>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="M7 10l5 5 5-5M12 15V3" />
        </>
      );
    case 'external':
      return (
        <>
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <path d="M15 3h6v6M10 14 21 3" />
        </>
      );
    case 'refresh':
      return (
        <>
          <path d="M23 4v6h-6M1 20v-6h6" />
          <path d="M3.5 9a9 9 0 0 1 14.9-3.4L23 10M1 14l4.6 4.4A9 9 0 0 0 20.5 15" />
        </>
      );
    case 'search':
      return (
        <>
          <circle cx="11" cy="11" r="7" />
          <path d="M21 21l-4.3-4.3" />
        </>
      );
    case 'home':
      return (
        <>
          <path d="M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M9 22V12h6v10" />
        </>
      );
    case 'house':
      return (
        <>
          <path d="M3 10l9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <path d="M9 22V12h6v10" />
        </>
      );
    case 'database':
      return (
        <>
          <ellipse cx="12" cy="5" rx="8" ry="3" />
          <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
          <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
        </>
      );
    case 'musicNote':
      return (
        <>
          <path d="M9 18V5l12-2v13" />
          <circle cx="6" cy="18" r="3" />
          <circle cx="18" cy="16" r="3" />
        </>
      );
    case 'radio':
      return (
        <>
          <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
          <path d="M7.8 16.2a6 6 0 0 1 0-8.5M16.2 7.8a6 6 0 0 1 0 8.5M4.9 19.1a10 10 0 0 1 0-14.2M19.1 4.9a10 10 0 0 1 0 14.2" />
        </>
      );
    case 'disc':
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="2.5" />
        </>
      );
    case 'quote':
      return <path d="M10 8c-3 1-5 3.5-5 7h5v-6H7.5A3.5 3.5 0 0 1 10 8zm9 0c-3 1-5 3.5-5 7h5v-6h-2.5A3.5 3.5 0 0 1 19 8z" fill="currentColor" stroke="none" />;
    case 'settings':
      return (
        <>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z" />
        </>
      );
    case 'bell':
      return (
        <>
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </>
      );
    case 'bellOff':
      return (
        <>
          <path d="M8.7 3A6 6 0 0 1 18 8c0 4 1 6 2 7H8l1-2.6" />
          <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          <path d="M2 2l20 20" />
        </>
      );
    case 'wifi':
      return (
        <>
          <path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M2 9a15 15 0 0 1 20 0" />
          <path d="M12 20h.01" />
        </>
      );
    case 'wifiOff':
      return (
        <>
          <path d="M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5.2-2.8M19 13a10 10 0 0 0-4.2-2.8" />
          <path d="M12 20h.01M2 2l20 20" />
        </>
      );
    case 'volume':
      return (
        <>
          <path d="M11 5 6 9H2v6h4l5 4z" />
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
        </>
      );
    case 'volumeX':
      return (
        <>
          <path d="M11 5 6 9H2v6h4l5 4z" />
          <path d="M23 9l-6 6M17 9l6 6" />
        </>
      );
    case 'expand':
      return <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3" />;
    case 'clock':
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3.5 2" />
        </>
      );
    case 'info':
      return (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 16v-4M12 8h.01" />
        </>
      );
    case 'spark':
      return <path d="M12 3l1.9 5.8 5.8 1.9-5.8 1.9L12 18.4l-1.9-5.8L4.3 10.7l5.8-1.9z" />;
    case 'dot':
      return (
        <>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />
        </>
      );
    case 'warn':
      return (
        <>
          <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
          <path d="M12 9v4M12 17h.01" />
        </>
      );
    case 'filter':
      return <path d="M22 3H2l8 9.5V19l4 2v-8.5z" />;
    case 'shuffle':
      return (
        <>
          <path d="M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5" />
        </>
      );
    case 'repeat':
      return (
        <>
          <path d="M17 1l4 4-4 4" />
          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
          <path d="M7 23l-4-4 4-4" />
          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
        </>
      );
    case 'moon':
      return <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />;
    case 'folder':
      return <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />;
  }
}

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      style={{ flexShrink: 0, display: 'inline-block', verticalAlign: '-3px' }}
    >
      {paths(name)}
    </svg>
  );
}

// Legacy single-char glyphs (emoji, dingbats, misc symbols) mapped to the
// icon set so every existing `icon="…"` / `glyph="…"` call site renders an
// SVG with zero API changes. Unknown strings fall back to text.
const GLYPH_MAP: Record<string, IconName> = {
  '♪': 'musicNote',
  '♫': 'musicNote',
  '◉': 'dot',
  '♥': 'heart',
  '♡': 'heartOutline',
  '☺': 'user',
  '✎': 'pencil',
  '☰': 'list',
  '⛶': 'expand',
  '⚙': 'settings',
  '⚙︎': 'settings',
  '❝': 'quote',
  '⊙': 'disc',
  '✓': 'check',
  '✕': 'close',
  '✦': 'spark',
  '⚡': 'spark',
  '🔥': 'spark',
  '🕐': 'clock',
  '📡': 'radio',
  '🔔': 'bell',
  '🔕': 'bellOff',
  '📴': 'wifiOff',
  '📶': 'wifi',
  '🔊': 'volume',
  '🔇': 'volumeX',
  '↓': 'download',
  '↻': 'refresh',
  '↗': 'external',
  'ⓘ': 'info',
  '▶': 'play',
  '❚❚': 'pause',
  '⚠': 'warn',
  '⚠︎': 'warn',
  '⛛': 'filter',
  '🔈': 'volume',
  '⇄': 'shuffle',
  '⏮': 'prev',
  '⏭': 'next',
  '⏾': 'moon',
  '▤': 'folder',
  '▷': 'play',
  '⊘': 'wifiOff',
  '⌂': 'house',
  '⌕': 'search',
  '◷': 'clock',
  '≡': 'list',
  '＋': 'plus',
  '🗄': 'database',
  'ℹ': 'info',
};

export function Glyph({ char, size = 16 }: { char: string; size?: number }) {
  const name = GLYPH_MAP[char];
  if (!name) return <span aria-hidden>{char}</span>;
  return <Icon name={name} size={size} />;
}
