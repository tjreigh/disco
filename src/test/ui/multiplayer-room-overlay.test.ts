// @vitest-environment happy-dom

import { beforeEach, describe, expect, test } from 'vitest';
import type { MultiplayerSessionView } from '../../app/multiplayer-session-controller.js';
import type { LocalBoardSessionView } from '../../app/local-board-session.js';
import { SCORE_RACE_MODE } from '../../game/modes/score-race.js';
import { multiplayerModeIdentity } from '../../shared/multiplayer-contracts.js';
import { MultiplayerRoomOverlay } from '../../ui/multiplayer-room-overlay.js';
import type { RoomOverlayView } from '../../ui/multiplayer-room-overlay.js';

function overlayView(session: MultiplayerSessionView, pausedByLocal = false): RoomOverlayView {
  return { ...session, pausedByLocal };
}

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
    paused: false,
    pausedBy: null,
  };
}

describe('MultiplayerRoomOverlay', () => {
  test('keeps an authoritative result visible when a transport error races afterward', () => {
    const overlay = new MultiplayerRoomOverlay();

    overlay.render(overlayView(completedView()), 'invalid-state');

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

    overlay.render(overlayView({
      ...completedView(),
      localReady: true,
      opponentReady: false,
    }), null);

    const root = document.querySelector<HTMLElement>('.multiplayer-room')!;
    expect(root.dataset.state).toBe('result');
    expect(root.textContent).toContain('YOU WIN');
    expect(root.textContent).toContain('Waiting for your opponent');
    expect(root.querySelector<HTMLButtonElement>('.multiplayer-room__button--primary')?.textContent)
      .toBe('CANCEL REMATCH');

    overlay.render(overlayView({
      ...completedView(),
      opponentReady: true,
    }), null);
    expect(root.textContent).toContain('Your opponent wants another round');
  });

  test('hides the room overlay while gameplay is live', () => {
    const overlay = new MultiplayerRoomOverlay();

    overlay.render(overlayView({
      ...completedView(),
      phase: 'playing',
      connection: 'connected',
      result: null,
    }), null);

    expect(document.querySelector<HTMLElement>('.multiplayer-room')!.hidden).toBe(true);
  });

  test('shows a passive paused banner only to the player who did not pause', () => {
    const overlay = new MultiplayerRoomOverlay();
    const playing: MultiplayerSessionView = {
      ...completedView(),
      phase: 'playing',
      connection: 'connected',
      result: null,
      paused: true,
      pausedBy: 'opponent-player',
    };

    overlay.render(overlayView(playing, false), null);
    const root = document.querySelector<HTMLElement>('.multiplayer-room')!;
    expect(root.hidden).toBe(false);
    expect(root.dataset.state).toBe('paused');
    expect(root.textContent).toContain('PAUSED');
    expect(root.textContent).toContain('opponent paused the match');

    overlay.render(overlayView({ ...playing, pausedBy: 'local-player' }, true), null);
    expect(root.hidden).toBe(true);
  });

  // Regression: these four failures used to render identical text ("This
  // match uses an incompatible Disco multiplayer version."), which hid a
  // real wire-protocol parser bug behind a misleading version-skew message.
  test('shows different text for each compatibility failure category', () => {
    const overlay = new MultiplayerRoomOverlay();
    const base = overlayView({ ...completedView(), phase: 'lobby' as const, result: null });

    overlay.render({ ...base, compatibilityError: 'protocol-mismatch' }, null);
    const protocolText = document.querySelector('.multiplayer-room__message')!.textContent;
    expect(protocolText).toContain('out of date');

    overlay.render({ ...base, compatibilityError: 'invalid-message' }, null);
    const invalidText = document.querySelector('.multiplayer-room__message')!.textContent;
    expect(invalidText).toContain('couldn’t understand');
    expect(invalidText).toContain('console');

    overlay.render({ ...base, compatibilityError: 'rules-mismatch' }, null);
    const rulesText = document.querySelector('.multiplayer-room__message')!.textContent;

    expect(protocolText).not.toBe(invalidText);
    expect(protocolText).not.toBe(rulesText);
    expect(invalidText).not.toBe(rulesText);
  });
});
