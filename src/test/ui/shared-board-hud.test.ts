// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from 'vitest';
import { SharedBoardHud } from '../../ui/shared-board-hud.js';

beforeEach(() => {
  document.body.replaceChildren();
});

describe('SharedBoardHud', () => {
  test('renders the mode label, turn indicator, and scores', () => {
    const hud = new SharedBoardHud();

    hud.render({
      phase: 'playing',
      remainingMs: 12_400,
      localScore: 30,
      opponentScore: 10,
      isMyTurn: true,
      result: null,
      compatibilityError: null,
    });

    expect(document.querySelector('.multiplayer-hud__mode-label')?.textContent).toBe('DISCO DUEL');
    expect(document.querySelector('.multiplayer-hud__status')?.textContent).toBe('LIVE');
    expect(document.querySelector('.multiplayer-hud__local-value')?.textContent).toBe('30');
    expect(document.querySelector('.multiplayer-hud__opponent-value')?.textContent).toBe('10');
    expect(document.querySelector('.multiplayer-hud__turn-value')?.textContent).toBe('YOUR TURN');
    expect(document.querySelector('.multiplayer-hud__timer-label')?.textContent).toBe('TIME LEFT');
    expect(document.querySelector('.multiplayer-hud__timer')?.textContent).toBe('0:13');
    expect(document.querySelector('.multiplayer-hud')?.getAttribute('data-my-turn')).toBe('true');
  });

  // Regression: the opponent's turn timer used to be invisible entirely.
  // It must render identically for both players once remainingMs is present.
  test('shows the turn indicator and a live timer during the opponent\'s turn', () => {
    const hud = new SharedBoardHud();

    hud.render({
      phase: 'playing',
      remainingMs: 8_000,
      localScore: 30,
      opponentScore: 10,
      isMyTurn: false,
      result: null,
      compatibilityError: null,
    });

    expect(document.querySelector('.multiplayer-hud__turn-value')?.textContent).toBe("OPPONENT'S TURN");
    expect(document.querySelector('.multiplayer-hud__timer')?.textContent).toBe('0:08');
    expect(document.querySelector('.multiplayer-hud')?.getAttribute('data-my-turn')).toBe('false');
  });

  test('renders lobby/countdown/compatibility-error status text', () => {
    const hud = new SharedBoardHud();

    hud.render({
      phase: 'lobby',
      remainingMs: null,
      localScore: 0,
      opponentScore: 0,
      isMyTurn: false,
      result: null,
      compatibilityError: null,
    });
    expect(document.querySelector('.multiplayer-hud__status')?.textContent).toBe('LOBBY');
    expect(document.querySelector('.multiplayer-hud__turn-value')?.textContent).toBe('—');

    hud.render({
      phase: 'countdown',
      remainingMs: 2_400,
      localScore: 0,
      opponentScore: 0,
      isMyTurn: false,
      result: null,
      compatibilityError: null,
    });
    expect(document.querySelector('.multiplayer-hud__timer-label')?.textContent).toBe('STARTS IN');
    expect(document.querySelector('.multiplayer-hud__timer')?.textContent).toBe('3');

    hud.render({
      phase: 'playing',
      remainingMs: 5_000,
      localScore: 0,
      opponentScore: 0,
      isMyTurn: true,
      result: null,
      compatibilityError: 'rules-mismatch',
    });
    expect(document.querySelector('.multiplayer-hud__status')?.textContent).toBe('RULES VERSION MISMATCH');
  });

  test('renders and hides the result banner', () => {
    const hud = new SharedBoardHud();

    hud.render({
      phase: 'finished',
      remainingMs: 0,
      localScore: 400,
      opponentScore: 300,
      isMyTurn: false,
      result: { outcome: 'win', localScore: 400, opponentScore: 300, forfeitedBy: null },
      compatibilityError: null,
    });
    expect(document.querySelector('.multiplayer-hud__result')?.textContent).toBe('YOU WIN · 400–300');
    expect((document.querySelector('.multiplayer-hud__result') as HTMLElement).hidden).toBe(false);
    expect(document.querySelector('.multiplayer-hud')?.getAttribute('data-result')).toBe('true');

    hud.render({
      phase: 'playing',
      remainingMs: 1_000,
      localScore: 0,
      opponentScore: 0,
      isMyTurn: true,
      result: null,
      compatibilityError: null,
    });
    expect((document.querySelector('.multiplayer-hud__result') as HTMLElement).hidden).toBe(true);
    expect(document.querySelector('.multiplayer-hud')?.getAttribute('data-result')).toBe('false');
  });

  test('uses a custom mode label and destroys cleanly', () => {
    const hud = new SharedBoardHud('CUSTOM MODE');
    expect(document.querySelector('.multiplayer-hud__mode-label')?.textContent).toBe('CUSTOM MODE');
    hud.destroy();
    expect(document.querySelector('.multiplayer-hud')).toBeNull();
  });
});
