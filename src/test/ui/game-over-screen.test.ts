// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import { GameOverScreen } from '../../ui/game-over-screen.js';

describe('GameOverScreen', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  test('shows the score, records, and explicit end-of-game actions', () => {
    const screen = new GameOverScreen();
    const onNewGame = vi.fn();
    const onHome = vi.fn();
    screen.onRequestNewGame = onNewGame;
    screen.onRequestHome = onHome;

    screen.open({
      score: 12345,
      stats: {
        highScore: 20000,
        longestStreak: 6,
        averageScore: 4321,
        gamesPlayed: 3,
        totalScore: 12963,
      },
      isStackMode: false,
      bestRunRecord: 7,
      previousHighScore: 10000,
      previousBestRecord: 5,
      reason: 'board-full',
    });

    const overlay = document.querySelector<HTMLElement>('.game-over-screen')!;
    const newGame = Array.from(overlay.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'NEW GAME')!;
    const home = Array.from(overlay.querySelectorAll<HTMLButtonElement>('button'))
      .find(button => button.textContent === 'HOME')!;

    expect(overlay.classList).toContain('game-over-screen--open');
    expect(overlay.getAttribute('aria-hidden')).toBe('false');
    expect(overlay.textContent).toContain('Score 12,345');
    expect(overlay.textContent).toContain('NEW HIGH SCORE');
    expect(overlay.textContent).toContain('NEW BEST CHAIN');
    expect(overlay.textContent).toContain('2,345 above your previous best');
    expect(overlay.textContent).toContain('The board filled with no legal moves left.');
    expect(overlay.textContent).toContain('Best chain this game: 7');
    expect(overlay.textContent).toContain('High 20,000 · Longest chain 6');
    expect(overlay.textContent).toContain('Average 4,321 over 3 games');
    expect(document.activeElement).toBe(newGame);

    newGame.click();
    home.click();
    expect(onNewGame).toHaveBeenCalledTimes(1);
    expect(onHome).toHaveBeenCalledTimes(1);
  });

  test('uses the Stack record label and keeps keyboard focus inside the dialog', () => {
    const screen = new GameOverScreen();
    screen.open({
      score: 10,
      stats: { highScore: 10, longestStreak: 4, averageScore: 10, gamesPlayed: 1, totalScore: 10 },
      isStackMode: true,
      bestRunRecord: 4,
      previousHighScore: 10,
      previousBestRecord: 4,
      reason: 'push-overflow',
    });

    const overlay = document.querySelector<HTMLElement>('.game-over-screen')!;
    const buttons = overlay.querySelectorAll<HTMLButtonElement>('button');
    const newGame = buttons[0]!;
    const home = buttons[1]!;
    expect(overlay.textContent).toContain('Best stack 4');
    expect(overlay.textContent).toContain('The level push overflowed the board.');
    expect(overlay.querySelector<HTMLElement>('.game-over-highlights')!.hidden).toBe(true);

    home.focus();
    home.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(newGame);

    newGame.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(home);

    screen.close();
    expect(overlay.classList).not.toContain('game-over-screen--open');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).not.toBe(home);
  });
});
