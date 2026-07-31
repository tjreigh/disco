// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from 'vitest';
import type { MultiplayerSessionView } from '../../app/multiplayer-session-controller.js';
import type { LocalBoardSessionView } from '../../app/local-board-session.js';
import { SCORE_RACE_MODE } from '../../game/modes/score-race.js';
import { multiplayerModeIdentity } from '../../shared/multiplayer-contracts.js';
import { MultiplayerRoomOverlay } from '../../ui/multiplayer-room-overlay.js';

beforeEach(() => {
  document.body.replaceChildren();
  history.replaceState(null, '', '/');
});

function completedView(): MultiplayerSessionView {
  return {
    phase: 'finished',
    connection: 'disconnected',
    roomId: 'ROOM1234',
    playerId: 'local-player',
    mode: multiplayerModeIdentity(SCORE_RACE_MODE),
    localReady: false,
    opponentReady: false,
    matchId: 'match-1',
    startsAt: 0,
    deadline: 180_000,
    remainingMs: 0,
    opponent: null,
    result: {
      outcome: 'win',
      localScore: 2_000,
      opponentScore: 1_250,
    },
    compatibilityError: null,
    board: {} as LocalBoardSessionView,
  };
}

describe('MultiplayerRoomOverlay', () => {
  test('keeps an authoritative result visible when a transport error races afterward', () => {
    const overlay = new MultiplayerRoomOverlay();

    overlay.render(completedView(), 'invalid-state');

    const root = document.querySelector<HTMLElement>('.multiplayer-room')!;
    expect(root.dataset.state).toBe('result');
    expect(root.textContent).toContain('YOU WIN');
    expect(root.textContent).toContain('2,000 – 1,250');
    expect(root.textContent).not.toContain('ROOM ERROR');
    const rematch = root.querySelector<HTMLButtonElement>('.multiplayer-room__button--primary');
    expect(rematch?.hidden).toBe(false);
    expect(rematch?.textContent).toBe('PLAY AGAIN');
    expect(root.querySelector<HTMLButtonElement>('[data-multiplayer-action="copy"]')?.hidden)
      .toBe(true);
  });

  test('shows rematch readiness without replacing the completed result', () => {
    const overlay = new MultiplayerRoomOverlay();

    overlay.render({
      ...completedView(),
      localReady: true,
      opponentReady: false,
    }, null);

    const root = document.querySelector<HTMLElement>('.multiplayer-room')!;
    expect(root.dataset.state).toBe('result');
    expect(root.textContent).toContain('YOU WIN');
    expect(root.textContent).toContain('Waiting for your opponent');
    expect(root.querySelector<HTMLButtonElement>('.multiplayer-room__button--primary')?.textContent)
      .toBe('CANCEL REMATCH');

    overlay.render({
      ...completedView(),
      opponentReady: true,
    }, null);
    expect(root.textContent).toContain('Your opponent wants another round');
  });

  test('hides the room overlay while gameplay is live', () => {
    const overlay = new MultiplayerRoomOverlay();

    overlay.render({
      ...completedView(),
      phase: 'playing',
      connection: 'connected',
      remainingMs: 120_000,
      result: null,
    }, null);

    expect(document.querySelector<HTMLElement>('.multiplayer-room')!.hidden).toBe(true);
  });
});
