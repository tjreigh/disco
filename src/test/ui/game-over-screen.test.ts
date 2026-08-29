// @vitest-environment happy-dom

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  GAME_OVER_RUN_STATS_EXPANDED_KEY,
  GameOverScreen,
} from '../../ui/game-over-screen.js';

describe('GameOverScreen', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    window.localStorage.removeItem(GAME_OVER_RUN_STATS_EXPANDED_KEY);
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
        totalPlayTimeMs: 0,
        totalDiscsDropped: 0,
        totalDiscsBroken: 0,
      },
      isStackMode: false,
      bestRunRecord: 7,
      previousHighScore: 10000,
      previousBestRecord: 5,
      playTimeMs: 120_000,
      discsDropped: 30,
      discsBroken: 12,
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
    expect(overlay.textContent).toContain('Best chain this game: 7 waves');
    expect(overlay.querySelector('[data-record="high"]')?.textContent).toBe('20,000');
    expect(overlay.querySelector('[data-record="best-label"]')?.textContent).toBe('BEST CHAIN');
    expect(overlay.querySelector('[data-record="best"]')?.textContent).toBe('6 waves');
    expect(overlay.querySelector('[data-record="average"]')?.textContent).toBe('4,321');
    const averageDelta = overlay.querySelector<HTMLElement>('[data-record="average-delta"]')!;
    // Pre-game average = round((12,963 - 12,345) / 2) = 309; 4,321 - 309 = +4,012.
    expect(averageDelta.hidden).toBe(false);
    expect(averageDelta.textContent).toBe('▲ 4,012');
    expect(averageDelta.className).toContain('game-over-record__delta--up');
    expect(overlay.querySelector('[data-record="games"]')?.textContent).toBe('over 3 games');
    expect(overlay.textContent).toContain('ADVANCED RUN STATS');
    expect(overlay.textContent).toContain('TIME · DISCS · PER-MINUTE RATES');
    expect(overlay.textContent).toContain('TIME2m');
    expect(overlay.textContent).toContain('DROPPED30');
    expect(overlay.textContent).toContain('BROKEN12');
    expect(overlay.textContent).toContain('SCORE / MIN6,172.5');
    expect(overlay.textContent).toContain('DROPS / MIN15');
    expect(overlay.textContent).toContain('BROKEN / MIN6');
    const runStatsToggle = overlay.querySelector<HTMLButtonElement>('.game-over-run-stats__toggle')!;
    const runStatsDetails = overlay.querySelector<HTMLElement>('.game-over-run-stats__details')!;
    expect(runStatsToggle.getAttribute('aria-expanded')).toBe('false');
    expect(runStatsDetails.hidden).toBe(true);
    runStatsToggle.click();
    expect(runStatsToggle.getAttribute('aria-expanded')).toBe('true');
    expect(runStatsDetails.hidden).toBe(false);
    expect(window.localStorage.getItem(GAME_OVER_RUN_STATS_EXPANDED_KEY)).toBe('1');
    expect(document.activeElement).toBe(newGame);

    newGame.click();
    home.click();
    expect(onNewGame).toHaveBeenCalledTimes(1);
    expect(onHome).toHaveBeenCalledTimes(1);
  });

  test('uses the Stack best-turn label and keeps keyboard focus inside the dialog', () => {
    const screen = new GameOverScreen();
    screen.open({
      score: 10,
      stats: {
        highScore: 10, longestStreak: 4, averageScore: 10, gamesPlayed: 1, totalScore: 10,
        totalPlayTimeMs: 0, totalDiscsDropped: 0, totalDiscsBroken: 0,
      },
      isStackMode: true,
      bestRunRecord: 4,
      previousHighScore: 10,
      previousBestRecord: 4,
      playTimeMs: 30_000,
      discsDropped: 1,
      discsBroken: 4,
      reason: 'push-overflow',
    });

    const overlay = document.querySelector<HTMLElement>('.game-over-screen')!;
    const buttons = Array.from(overlay.querySelectorAll<HTMLButtonElement>('button'));
    const newGame = buttons.find(button => button.textContent === 'NEW GAME')!;
    const home = buttons.find(button => button.textContent === 'HOME')!;
    const runStatsToggle = overlay.querySelector<HTMLButtonElement>('.game-over-run-stats__toggle')!;
    expect(overlay.textContent).toContain('Most cleared in one turn: 4');
    expect(overlay.querySelector('[data-record="best-label"]')?.textContent).toBe('BEST TURN');
    expect(overlay.querySelector('[data-record="best"]')?.textContent).toBe('4 cleared');
    expect(overlay.querySelector<HTMLElement>('[data-record="average-delta"]')!.hidden).toBe(true);
    expect(overlay.querySelector('[data-record="games"]')?.textContent).toBe('Your first recorded game');
    expect(overlay.textContent).toContain('The level push overflowed the board.');
    expect(overlay.querySelector<HTMLElement>('.game-over-highlights')!.hidden).toBe(true);

    home.focus();
    home.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(runStatsToggle);

    runStatsToggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(home);

    screen.close();
    expect(overlay.classList).not.toContain('game-over-screen--open');
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
    expect(document.activeElement).not.toBe(home);
  });

  test('restores an expanded run-stats preference in a later dialog instance', () => {
    window.localStorage.setItem(GAME_OVER_RUN_STATS_EXPANDED_KEY, '1');
    const screen = new GameOverScreen();

    const toggle = document.querySelector<HTMLButtonElement>('.game-over-run-stats__toggle')!;
    const details = document.querySelector<HTMLElement>('.game-over-run-stats__details')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(details.hidden).toBe(false);

    toggle.click();
    expect(window.localStorage.getItem(GAME_OVER_RUN_STATS_EXPANDED_KEY)).toBe('0');
    expect(details.hidden).toBe(true);
    screen.close();
  });

  test('makes Rewind the primary game-over action when the run can be rescued', () => {
    const screen = new GameOverScreen();
    const onRewind = vi.fn();
    screen.onRequestRewind = onRewind;
    screen.open({
      score: 99,
      stats: {
        highScore: 99, longestStreak: 1, averageScore: 99, gamesPlayed: 1, totalScore: 99,
        totalPlayTimeMs: 0, totalDiscsDropped: 0, totalDiscsBroken: 0,
      },
      isStackMode: false,
      bestRunRecord: 1,
      previousHighScore: 0,
      previousBestRecord: 0,
      playTimeMs: 0,
      discsDropped: 0,
      discsBroken: 0,
      canRewind: true,
    });

    const rewind = Array.from(document.querySelectorAll<HTMLButtonElement>('.game-over-button'))
      .find(button => button.textContent === 'REWIND')!;
    expect(rewind.hidden).toBe(false);
    expect(document.activeElement).toBe(rewind);
    expect(document.querySelector('[data-run-stat="score-rate"]')?.textContent).toBe('—');
    rewind.click();
    expect(onRewind).toHaveBeenCalledTimes(1);
  });

  test('marks a game that dragged the running average down', () => {
    const screen = new GameOverScreen();
    screen.open({
      score: 100,
      stats: {
        highScore: 5000, longestStreak: 2, averageScore: 900, gamesPlayed: 4,
        totalScore: 3600, totalPlayTimeMs: 0, totalDiscsDropped: 0, totalDiscsBroken: 0,
      },
      isStackMode: false,
      bestRunRecord: 1,
      previousHighScore: 5000,
      previousBestRecord: 2,
      playTimeMs: 0,
      discsDropped: 0,
      discsBroken: 0,
    });

    const delta = document.querySelector<HTMLElement>('[data-record="average-delta"]')!;
    // Pre-game average = round((3,600 - 100) / 3) = 1,167; 900 - 1,167 = -267.
    expect(delta.hidden).toBe(false);
    expect(delta.textContent).toBe('▼ 267');
    expect(delta.className).toContain('game-over-record__delta--down');
    expect(delta.getAttribute('aria-label')).toBe('Average fell 267 from 1,167');
    expect(document.querySelector('[data-record="games"]')?.textContent).toBe('over 4 games');
  });

  test('shows the imbalance reason and the Ration ratio and balanced run stats', () => {
    const screen = new GameOverScreen();
    screen.open({
      score: 1000,
      stats: {
        highScore: 1000, longestStreak: 3, averageScore: 1000, gamesPlayed: 1, totalScore: 1000,
        totalPlayTimeMs: 0, totalDiscsDropped: 0, totalDiscsBroken: 0,
      },
      isStackMode: false,
      bestRunRecord: 1,
      previousHighScore: 1000,
      previousBestRecord: 3,
      playTimeMs: 60_000,
      discsDropped: 30,
      discsBroken: 24,
      reason: 'imbalance',
      ration: { balancedLevels: 3 },
    });

    const overlay = document.querySelector<HTMLElement>('.game-over-screen')!;
    expect(overlay.textContent).toContain('Clears fell out of balance too many levels.');
    const ratioRow = overlay.querySelector('[data-run-stat="ratio"]')!.parentElement!;
    const balancedRow = overlay.querySelector('[data-run-stat="balanced"]')!.parentElement!;
    expect(ratioRow.hidden).toBe(false);
    expect(balancedRow.hidden).toBe(false);
    expect(overlay.querySelector('[data-run-stat="ratio"]')?.textContent).toBe('0.80');
    expect(overlay.querySelector('[data-run-stat="balanced"]')?.textContent).toBe('3');

    screen.open({
      score: 1000,
      stats: {
        highScore: 1000, longestStreak: 3, averageScore: 1000, gamesPlayed: 1, totalScore: 1000,
        totalPlayTimeMs: 0, totalDiscsDropped: 0, totalDiscsBroken: 0,
      },
      isStackMode: false,
      bestRunRecord: 1,
      previousHighScore: 1000,
      previousBestRecord: 3,
      playTimeMs: 60_000,
      discsDropped: 30,
      discsBroken: 24,
    });
    expect(ratioRow.hidden).toBe(true);
    expect(balancedRow.hidden).toBe(true);
  });
});
