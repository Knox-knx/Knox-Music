import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SongRow } from '../../src/ui/SongRow';
import { usePlayer } from '../../src/audio/playerStore';
import type { Song } from '../../src/core/types';

const baseSong: Song = {
  id: 'jamendo:1',
  providerId: 'jamendo',
  providerTrackId: '1',
  title: 'Mi Gente',
  artist: 'J Balvin & Willy William',
  album: 'Vibras',
  durationMs: 186000,
  sourceUrl: 'https://example.com/track/1',
  addedAt: 0,
};

function renderRow(song: Song = baseSong, props: Partial<Parameters<typeof SongRow>[0]> = {}) {
  return render(<SongRow song={song} {...props} />);
}

beforeEach(() => {
  usePlayer.setState({
    playSong: vi.fn(async () => undefined),
    addToQueue: vi.fn(),
    current: null,
    state: 'IDLE',
  } as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SongRow interaction regressions', () => {
  it('1. clicking the row content triggers playback', async () => {
    renderRow();
    await userEvent.click(screen.getByTestId('song-row-play'));
    expect(usePlayer.getState().playSong).toHaveBeenCalledTimes(1);
    expect(usePlayer.getState().playSong).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Mi Gente' }),
    );
  });

  it('2. clicking three-dot does NOT trigger playback', async () => {
    renderRow();
    await userEvent.click(screen.getByTestId('song-row-menu-button'));
    expect(usePlayer.getState().playSong).not.toHaveBeenCalled();
  });

  it('3. clicking three-dot opens the context menu', async () => {
    renderRow();
    await userEvent.click(screen.getByTestId('song-row-menu-button'));
    const menu = await screen.findByTestId('song-context-menu');
    expect(menu).toBeInTheDocument();
    expect(menu).toHaveAttribute('role', 'menu');
    // Portal: menu must live on document.body, above the glass container.
    expect(menu.parentElement).toBe(document.body);
    expect(screen.getByRole('menuitem', { name: /play next/i })).toBeInTheDocument();
  });

  it('4. clicking a menu item does not trigger row playback', async () => {
    renderRow();
    await userEvent.click(screen.getByTestId('song-row-menu-button'));
    const item = await screen.findByRole('menuitem', { name: /add to queue/i });
    await userEvent.click(item);
    // Only queue side-effect; playSong (row playback) stays silent.
    expect(usePlayer.getState().playSong).not.toHaveBeenCalled();
    expect(usePlayer.getState().addToQueue).toHaveBeenCalled();
  });

  it('5. Escape closes the context menu and refocuses the menu button', async () => {
    renderRow();
    await userEvent.click(screen.getByTestId('song-row-menu-button'));
    await screen.findByTestId('song-context-menu');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByTestId('song-context-menu')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('song-row-menu-button')).toHaveFocus();
  });

  it('6. clicking outside closes the context menu', async () => {
    render(
      <div>
        <div data-testid="outside">outside</div>
        <SongRow song={baseSong} />
      </div>,
    );
    await userEvent.click(screen.getByTestId('song-row-menu-button'));
    await screen.findByTestId('song-context-menu');
    fireEvent.mouseDown(screen.getByTestId('outside'));
    await waitFor(() => {
      expect(screen.queryByTestId('song-context-menu')).not.toBeInTheDocument();
    });
  });

  it('7. playing row gets a persistent playing state', async () => {
    usePlayer.setState({ current: { ...baseSong }, state: 'PLAYING' } as never);
    renderRow();
    const row = screen.getByTestId('song-row');
    expect(row).toHaveAttribute('data-playing', 'true');
    expect(row.className).toMatch(/current/);
  });

  it('8. playing row is NOT darkened excessively', async () => {
    usePlayer.setState({ current: { ...baseSong }, state: 'PLAYING' } as never);
    renderRow();
    const row = screen.getByTestId('song-row');
    const cs = getComputedStyle(row);
    // Never dim the whole row: opacity stays 1, no dimming filter.
    expect(cs.opacity === '' || cs.opacity === '1').toBe(true);
    expect(cs.filter === '' || cs.filter === 'none').toBe(true);
    // Background must be the accent glow, never near-black.
    const bg = cs.background || cs.backgroundImage || '';
    expect(bg).not.toMatch(/rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)/);
  });

  it('9. decorative glass layers never intercept pointer events', async () => {
    renderRow();
    const btn = screen.getByTestId('song-row-menu-button');
    const play = screen.getByTestId('song-row-play');
    // Interactivity contract: controls accept pointer events directly.
    expect(getComputedStyle(btn).pointerEvents).not.toBe('none');
    expect(getComputedStyle(play).pointerEvents).not.toBe('none');
    // The portal menu escapes the backdrop-filter container: it mounts on
    // document.body (never inside the row) with the above-container class
    // and an explicit viewport position, so it stays clickable.
    await userEvent.click(btn);
    const menu = await screen.findByTestId('song-context-menu');
    expect(menu.parentElement).toBe(document.body);
    expect(menu).toHaveClass('song-context-menu');
    expect(menu.style.left).not.toBe('');
    expect(menu.style.top).not.toBe('');
    expect(getComputedStyle(menu).pointerEvents).not.toBe('none');
  });

  it('10. keyboard can focus the three-dot button', async () => {
    renderRow();
    const btn = screen.getByTestId('song-row-menu-button');
    btn.focus();
    expect(btn).toHaveFocus();
    expect(btn).toHaveAttribute('aria-label', 'More options for Mi Gente');
  });

  it('11. Enter/Space on the three-dot button opens the menu', async () => {
    renderRow();
    const btn = screen.getByTestId('song-row-menu-button');
    btn.focus();
    fireEvent.keyDown(btn, { key: 'Enter' });
    await screen.findByTestId('song-context-menu');
    expect(screen.getByTestId('song-context-menu')).toBeInTheDocument();
  });
});
