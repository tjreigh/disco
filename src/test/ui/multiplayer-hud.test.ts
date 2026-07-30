// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from 'vitest';
import { MultiplayerHud } from '../../ui/multiplayer-hud.js';

beforeEach(() => {
  document.body.replaceChildren();
});

describe('MultiplayerHud', () => {
  test('renders countdown, opponent progress, reconnecting state, and result', () => {
    const hud = new MultiplayerHud();

    hud.render({
      phase: 'countdown',
      remainingMs: 2_400,
      opponent: null,
      result: null,
      compatibilityError: null,
    });
    expect(document.querySelector('.multiplayer-hud')?.textContent).toContain('STARTS IN 3');
    expect(document.querySelector('.multiplayer-hud')?.textContent).toContain('WAITING FOR OPPONENT');

    hud.render({
      phase: 'reconnecting',
      remainingMs: 45_000,
      opponent: {
        playerId: 'opponent',
        sequence: 3,
        score: 1_250,
        turnsPlayed: 5,
        finished: false,
      },
      result: null,
      compatibilityError: null,
    });
    expect(document.querySelector('.multiplayer-hud')?.textContent).toContain('RECONNECTING');
    expect(document.querySelector('.multiplayer-hud')?.textContent).toContain('OPPONENT 1,250');

    hud.render({
      phase: 'finished',
      remainingMs: 0,
      opponent: null,
      result: {
        outcome: 'win',
        localScore: 2_000,
        opponentScore: 1_250,
      },
      compatibilityError: null,
    });
    expect(document.querySelector('.multiplayer-hud__result')?.textContent)
      .toBe('YOU WIN · 2,000–1,250');
  });
});
