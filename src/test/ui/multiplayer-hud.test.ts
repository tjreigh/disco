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
      localScore: 50,
      opponent: null,
      result: null,
      compatibilityError: null,
      pingMs: null,
      connectionStale: false,
    });
    expect(document.querySelector('.multiplayer-hud__timer-label')?.textContent).toBe('STARTS IN');
    expect(document.querySelector('.multiplayer-hud__timer')?.textContent).toBe('3');
    expect(document.querySelector('.multiplayer-hud__local-value')?.textContent).toBe('50');
    expect(document.querySelector('.multiplayer-hud__opponent-value')?.textContent).toBe('WAITING');

    hud.render({
      phase: 'reconnecting',
      remainingMs: 45_000,
      localScore: 2_000,
      opponent: {
        playerId: 'opponent',
        sequence: 3,
        score: 1_250,
        turnsPlayed: 5,
        finished: false,
      },
      result: null,
      compatibilityError: null,
      pingMs: null,
      connectionStale: false,
    });
    expect(document.querySelector('.multiplayer-hud')?.textContent).toContain('REJOINING');
    expect(document.querySelector('.multiplayer-hud__opponent-value')?.textContent).toBe('1,250');

    hud.render({
      phase: 'finished',
      remainingMs: 0,
      localScore: 2_000,
      opponent: null,
      result: {
        outcome: 'win',
        localScore: 2_000,
        opponentScore: 1_250,
        forfeitedBy: null,
      },
      compatibilityError: null,
      pingMs: null,
      connectionStale: false,
    });
    expect(document.querySelector('.multiplayer-hud__result')?.textContent)
      .toBe('YOU WIN · 2,000–1,250');
  });
});
