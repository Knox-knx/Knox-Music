// Mini-player tests (§8 MINI PLAYER 11–17): title/artist opens FullPlayer,
// controls never do, keyboard access is native button semantics.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { usePlayer } from '../../src/audio/playerStore';
import { MiniPlayer, PlayerBar } from '../../src/ui/player';
import type { Song } from '../../src/core/types';

function mkSong(): Song {
  return {
    id: 'jamendo:soch1', providerId: 'jamendo', providerTrackId: 'soch1',
    title: 'Soch', artist: 'Harry Sandhu', album: 'Album',
    durationMs: 180000, addedAt: 0,
  } as Song;
}

beforeEach(() => {
  usePlayer.setState({
    current: mkSong(), state: 'PLAYING', positionMs: 30000, durationMs: 180000,
    volume: 0.9, muted: false, playerMode: 'track', currentStation: null,
    queue: [mkSong()], index: 0, shuffle: false, repeat: 'OFF',
  } as never);
});

describe('MiniPlayer metadata opens FullPlayer (11, 12, 16, 17)', () => {
  it('11/12. clicking the title/artist area opens FullPlayer', () => {
    const onExpand = vi.fn();
    render(<MiniPlayer onExpand={onExpand} />);
    fireEvent.click(screen.getByTestId('mini-player-metadata'));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('metadata is a real button with an accessible name (keyboard: Enter/Space free)', () => {
    const onExpand = vi.fn();
    render(<MiniPlayer onExpand={onExpand} />);
    const meta = screen.getByTestId('mini-player-metadata');
    expect(meta.tagName).toBe('BUTTON');
    expect(meta).toHaveAccessibleName(/open now playing: soch/i);
  });

  it('16/17. keyboard activation opens FullPlayer (native button semantics)', () => {
    const onExpand = vi.fn();
    render(<MiniPlayer onExpand={onExpand} />);
    const meta = screen.getByTestId('mini-player-metadata') as HTMLButtonElement;
    meta.focus();
    expect(document.activeElement).toBe(meta);
    // Native buttons fire click on Enter/Space — simulate the platform step.
    fireEvent.click(meta);
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('13. clicking the play button does NOT open FullPlayer', () => {
    const onExpand = vi.fn();
    render(<MiniPlayer onExpand={onExpand} />);
    fireEvent.click(screen.getByRole('button', { name: /pause/i }));
    expect(onExpand).not.toHaveBeenCalled();
  });
});

describe('PlayerBar metadata opens FullPlayer; controls do not (14, 15)', () => {
  it('clicking title/artist opens FullPlayer', () => {
    const onExpand = vi.fn();
    render(<PlayerBar onExpand={onExpand} onOpenQueue={vi.fn()} />);
    fireEvent.click(screen.getByTestId('player-bar-metadata'));
    expect(onExpand).toHaveBeenCalledTimes(1);
  });

  it('14. next/previous do NOT open FullPlayer', () => {
    const onExpand = vi.fn();
    const next = vi.spyOn(usePlayer.getState(), 'next').mockResolvedValue(undefined);
    const prev = vi.spyOn(usePlayer.getState(), 'prev').mockResolvedValue(undefined);
    try {
      render(<PlayerBar onExpand={onExpand} onOpenQueue={vi.fn()} />);
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
      expect(onExpand).not.toHaveBeenCalled();
    } finally {
      next.mockRestore();
      prev.mockRestore();
    }
  });

  it('15. volume + queue controls do NOT open FullPlayer', () => {
    const onExpand = vi.fn();
    const onOpenQueue = vi.fn();
    render(<PlayerBar onExpand={onExpand} onOpenQueue={onOpenQueue} />);
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '0.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open queue' }));
    expect(onExpand).not.toHaveBeenCalled();
    expect(onOpenQueue).toHaveBeenCalledTimes(1);
  });
});
