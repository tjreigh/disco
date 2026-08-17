// @vitest-environment happy-dom

import { describe, expect, test } from 'vitest';
import { SharedBoardSessionController } from '../../app/shared-board-session-controller.js';
import { SHARED_DUEL_MODE } from '../../game/modes/index.js';
import {
  multiplayerModeIdentity,
  MULTIPLAYER_PROTOCOL_VERSION,
} from '../../shared/multiplayer-contracts.js';
import type {
  MultiplayerModeIdentity,
  MultiplayerServerMessage,
  WireBoard,
  WireDisc,
} from '../../shared/multiplayer-contracts.js';
import { FakeMultiplayerTransport } from '../fakes/multiplayer-transport.js';

class FakeClock {
  value = 0;
  now(): number {
    return this.value;
  }
}

type WithoutServerEnvelope<T> = T extends MultiplayerServerMessage
  ? Omit<T, 'protocolVersion' | 'roomId' | 'mode'>
  : never;
type ServerPayload = WithoutServerEnvelope<MultiplayerServerMessage>;

const mode: MultiplayerModeIdentity = multiplayerModeIdentity(SHARED_DUEL_MODE);

function serverMessage(message: ServerPayload): MultiplayerServerMessage {
  return {
    protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
    roomId: 'ROOM1',
    mode,
    ...message,
  } as MultiplayerServerMessage;
}

function emptyBoard(): WireBoard {
  return Array.from({ length: 7 }, () => Array.from({ length: 7 }, () => null));
}

const discA: WireDisc = { id: 101, value: 3, kind: 'numbered' };
const discB: WireDisc = { id: 102, value: 7, kind: 'numbered' };
const discC: WireDisc = { id: 103, value: 2, kind: 'numbered' };

function startCountdown(transport: FakeMultiplayerTransport, startsAt = 0): void {
  transport.receive(serverMessage({
    type: 'match-countdown',
    matchId: 'match-1',
    startsAt,
    deadline: startsAt,
    seed: 1,
  }));
}

function createSession(): {
  clock: FakeClock;
  transport: FakeMultiplayerTransport;
  controller: SharedBoardSessionController;
} {
  const clock = new FakeClock();
  const transport = new FakeMultiplayerTransport();
  const controller = new SharedBoardSessionController({
    roomId: 'ROOM1',
    playerId: 'local-player',
    mode: SHARED_DUEL_MODE,
    clock,
    transport,
  });
  return { clock, transport, controller };
}

describe('SharedBoardSessionController', () => {
  test('exposes opponent presence, connection, and ready state from room-state', () => {
    const { transport, controller } = createSession();
    expect(controller.view.opponentJoined).toBe(false);
    expect(controller.view.opponentConnected).toBe(false);

    transport.receive(serverMessage({
      type: 'room-state',
      localReady: true,
      opponentReady: false,
      opponentJoined: true,
      opponentConnected: true,
    }));

    expect(controller.view.localReady).toBe(true);
    expect(controller.view.opponentReady).toBe(false);
    expect(controller.view.opponentJoined).toBe(true);
    expect(controller.view.opponentConnected).toBe(true);
  });

  test('remainingMs counts down through countdown and into a turn deadline', () => {
    const { clock, transport, controller } = createSession();
    expect(controller.view.remainingMs).toBeNull();

    transport.receive(serverMessage({
      type: 'match-countdown',
      matchId: 'match-1',
      startsAt: 1_000,
      deadline: 1_000,
      seed: 1,
    }));
    expect(controller.view.phase).toBe('countdown');
    expect(controller.view.remainingMs).toBe(1_000);

    clock.value = 400;
    expect(controller.view.remainingMs).toBe(600);

    clock.value = 1_000;
    controller.tick();
    expect(controller.view.phase).toBe('playing');

    transport.receive(serverMessage({
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'local-player',
      turnDeadline: 16_000,
      board: emptyBoard(),
      currentDisc: discA,
      nextDisc: discB,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 7,
      revision: 0,
    }));
    expect(controller.view.remainingMs).toBe(15_000);
    clock.value = 5_000;
    expect(controller.view.remainingMs).toBe(11_000);
  });

  // Regression: the opponent's countdown used to be zeroed out
  // (turnDeadline: isMyTurn ? message.turnDeadline : 0), hiding it entirely.
  test('shows a live remainingMs during the opponent\'s turn too', () => {
    const { clock, transport, controller } = createSession();
    startCountdown(transport);
    transport.receive(serverMessage({
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'opponent-player',
      turnDeadline: 16_000,
      board: emptyBoard(),
      currentDisc: discA,
      nextDisc: discB,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 7,
      revision: 0,
    }));
    expect(controller.view.isMyTurn).toBe(false);
    clock.value = 1_000;
    expect(controller.view.remainingMs).toBe(15_000);
  });

  // Regression: currentDisc/nextDisc/level/turnsPerLevel/turnsRemaining used
  // to not exist on the view at all — the game controller faked a disc with
  // value 0. Confirm these now flow through turn-assigned and turn-played.
  test('threads real disc/level/turn-budget data from turn-assigned and turn-played', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    transport.receive(serverMessage({
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'local-player',
      turnDeadline: 16_000,
      board: emptyBoard(),
      currentDisc: discA,
      nextDisc: discB,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 7,
      revision: 0,
    }));
    expect(controller.view.currentDisc).toEqual(discA);
    expect(controller.view.nextDisc).toEqual(discB);
    expect(controller.view.level).toBe(1);
    expect(controller.view.turnsPerLevel).toBe(7);
    expect(controller.view.turnsRemaining).toBe(7);

    transport.receive(serverMessage({
      type: 'turn-played',
      matchId: 'match-1',
      board: emptyBoard(),
      turnResult: {
        playerId: 'local-player',
        column: 3,
        triggerScoreDelta: 10,
        opponentScoreDelta: 0,
        stackSize: 1,
        steps: [],
        gameOver: false,
      },
      nextPlayerId: 'opponent-player',
      currentDisc: discC,
      nextDisc: discA,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 6,
      revision: 1,
    }));
    expect(controller.view.currentDisc).toEqual(discC);
    expect(controller.view.nextDisc).toEqual(discA);
    expect(controller.view.turnsRemaining).toBe(6);
    expect(controller.view.isMyTurn).toBe(false);
  });

  // Regression guard for the dead ternary in #handleTurnAssigned
  // (`lifecycle.kind === 'countdown' ? lifecycle.match : lifecycle.match`) —
  // the match context must still carry through unchanged.
  test('preserves match context across the countdown-to-playing transition', () => {
    const { clock, transport, controller } = createSession();
    transport.receive(serverMessage({
      type: 'match-countdown',
      matchId: 'match-9',
      startsAt: 500,
      deadline: 500,
      seed: 7,
    }));
    clock.value = 500;
    controller.tick();
    transport.receive(serverMessage({
      type: 'turn-assigned',
      matchId: 'match-9',
      playerId: 'local-player',
      turnDeadline: 16_000,
      board: emptyBoard(),
      currentDisc: discA,
      nextDisc: discB,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 7,
      revision: 0,
    }));
    expect(controller.view.matchId).toBe('match-9');
    expect(controller.view.startsAt).toBe(500);
  });

  // Regression: turn-played's steps used to be discarded entirely, so
  // cascades never animated — the board just snapped to the post-turn state.
  test('consumePendingTurnResult surfaces the pre-turn board and steps exactly once', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    transport.receive(serverMessage({
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'local-player',
      turnDeadline: 16_000,
      board: emptyBoard(),
      currentDisc: discA,
      nextDisc: discB,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 7,
      revision: 0,
    }));
    expect(controller.consumePendingTurnResult()).toBeNull();

    const boardBefore = controller.view.board;
    const postTurnBoard = emptyBoard();
    postTurnBoard[6]![3] = discC;
    const steps = [{
      kind: 'drop' as const,
      disc: discC,
      entryPos: { row: -1, col: 3 },
      landPos: { row: 6, col: 3 },
    }];
    transport.receive(serverMessage({
      type: 'turn-played',
      matchId: 'match-1',
      board: postTurnBoard,
      turnResult: {
        playerId: 'local-player',
        column: 3,
        triggerScoreDelta: 0,
        opponentScoreDelta: 0,
        stackSize: 0,
        steps,
        gameOver: false,
      },
      nextPlayerId: 'opponent-player',
      currentDisc: discC,
      nextDisc: discA,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 6,
      revision: 1,
    }));

    // The view's board is already the post-turn authoritative state...
    expect(controller.view.board).toEqual(postTurnBoard);
    // ...but the pending result still carries the pre-turn board to animate from.
    const pending = controller.consumePendingTurnResult();
    expect(pending?.boardBefore).toEqual(boardBefore);
    expect(pending?.steps).toEqual(steps);
    expect(pending?.triggerPlayerId).toBe('local-player');
    expect(controller.consumePendingTurnResult()).toBeNull();
  });

  // Regression: a turn-assigned arriving right behind turn-played (same
  // broadcast) used to replace the lifecycle wholesale, discarding any
  // not-yet-consumed pendingTurnResult before the game controller's next
  // frame could pick it up.
  test('preserves an unconsumed pendingTurnResult across a turn-assigned', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    transport.receive(serverMessage({
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'local-player',
      turnDeadline: 16_000,
      board: emptyBoard(),
      currentDisc: discA,
      nextDisc: discB,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 7,
      revision: 0,
    }));
    transport.receive(serverMessage({
      type: 'turn-played',
      matchId: 'match-1',
      board: emptyBoard(),
      turnResult: {
        playerId: 'local-player',
        column: 3,
        triggerScoreDelta: 0,
        opponentScoreDelta: 0,
        stackSize: 0,
        steps: [],
        gameOver: false,
      },
      nextPlayerId: 'opponent-player',
      currentDisc: discC,
      nextDisc: discA,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 6,
      revision: 1,
    }));
    transport.receive(serverMessage({
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'opponent-player',
      turnDeadline: 16_000,
      board: emptyBoard(),
      currentDisc: discA,
      nextDisc: discB,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 6,
      revision: 1,
    }));
    expect(controller.consumePendingTurnResult()).not.toBeNull();
  });

  test('moveCursor only sends when the clamped column actually changes', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    transport.receive(serverMessage({
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'local-player',
      turnDeadline: 16_000,
      board: emptyBoard(),
      currentDisc: discA,
      nextDisc: discB,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 7,
      revision: 0,
    }));
    expect(controller.view.columnCursor).toBe(3);

    const sentBefore = transport.sent.length;
    controller.moveCursor(3);
    expect(transport.sent.length).toBe(sentBefore); // no-op, unchanged

    controller.moveCursor(5);
    expect(transport.sent.at(-1)).toMatchObject({
      type: 'move-cursor', matchId: 'match-1', column: 5,
    });
    const sentAfterFirstMove = transport.sent.length;

    controller.moveCursor(9); // clamps to 6, still a real change
    expect(transport.sent.at(-1)).toMatchObject({ type: 'move-cursor', column: 6 });
    expect(transport.sent.length).toBe(sentAfterFirstMove + 1);

    controller.moveCursor(20); // clamps to 6 again — no-op
    expect(transport.sent.length).toBe(sentAfterFirstMove + 1);
  });

  // Regression: the opponent's live cursor used to have no wire
  // representation at all — the ghost preview couldn't exist.
  test('tracks the opponent cursor from opponent-cursor messages and resets it each new turn', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    transport.receive(serverMessage({
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'opponent-player',
      turnDeadline: 16_000,
      board: emptyBoard(),
      currentDisc: discA,
      nextDisc: discB,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 7,
      revision: 0,
    }));
    expect(controller.view.opponentColumnCursor).toBeNull();

    transport.receive(serverMessage({
      type: 'opponent-cursor',
      matchId: 'match-1',
      playerId: 'opponent-player',
      column: 4,
    }));
    expect(controller.view.opponentColumnCursor).toBe(4);

    transport.receive(serverMessage({
      type: 'opponent-cursor',
      matchId: 'match-1',
      playerId: 'opponent-player',
      column: 2,
    }));
    expect(controller.view.opponentColumnCursor).toBe(2);

    // Resolve the current turn, then the paired fresh assignment clears the
    // cursor until the new active player moves again.
    transport.receive(serverMessage({
      type: 'turn-played',
      matchId: 'match-1',
      board: emptyBoard(),
      turnResult: {
        playerId: 'opponent-player',
        column: 2,
        triggerScoreDelta: 0,
        opponentScoreDelta: 0,
        stackSize: 0,
        steps: [],
        gameOver: false,
      },
      nextPlayerId: 'local-player',
      currentDisc: discC,
      nextDisc: discA,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 6,
      revision: 1,
    }));
    transport.receive(serverMessage({
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'local-player',
      turnDeadline: 16_000,
      board: emptyBoard(),
      currentDisc: discC,
      nextDisc: discA,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 6,
      revision: 1,
    }));
    expect(controller.view.opponentColumnCursor).toBeNull();
  });

  test('ignores an opponent-cursor message that echoes the local player\'s own id', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    transport.receive(serverMessage({
      type: 'turn-assigned',
      matchId: 'match-1',
      playerId: 'local-player',
      turnDeadline: 16_000,
      board: emptyBoard(),
      currentDisc: discA,
      nextDisc: discB,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 7,
      revision: 0,
    }));
    transport.receive(serverMessage({
      type: 'opponent-cursor',
      matchId: 'match-1',
      playerId: 'local-player',
      column: 4,
    }));
    expect(controller.view.opponentColumnCursor).toBeNull();
  });
});

interface DuelStatusOverrides {
  matchId?: string;
  revision?: number;
  serverTime?: number;
  activePlayerId?: string;
  turnDeadline?: number;
  activeColumn?: number;
  paused?: boolean;
  pausedBy?: string | null;
  scores?: readonly [{ playerId: string; score: number }, { playerId: string; score: number }];
  board?: WireBoard;
  currentDisc?: WireDisc;
  nextDisc?: WireDisc;
  level?: number;
  turnsPerLevel?: number;
  turnsRemaining?: number;
}

function duelStatusMessage(overrides: DuelStatusOverrides = {}): MultiplayerServerMessage {
  return serverMessage({
    type: 'duel-status',
    matchId: 'match-1',
    revision: 1,
    serverTime: 0,
    activePlayerId: 'opponent-player',
    turnDeadline: 16_000,
    activeColumn: 3,
    paused: false,
    pausedBy: null,
    scores: [
      { playerId: 'local-player', score: 0 },
      { playerId: 'opponent-player', score: 0 },
    ],
    board: emptyBoard(),
    currentDisc: discA,
    nextDisc: discB,
    level: 1,
    turnsPerLevel: 7,
    turnsRemaining: 7,
    ...overrides,
  });
}

function assignTurn(
  transport: FakeMultiplayerTransport,
  overrides: { playerId?: string; revision?: number; matchId?: string } = {},
): void {
  transport.receive(serverMessage({
    type: 'turn-assigned',
    matchId: 'match-1',
    playerId: 'opponent-player',
    turnDeadline: 16_000,
    board: emptyBoard(),
    currentDisc: discA,
    nextDisc: discB,
    level: 1,
    turnsPerLevel: 7,
    turnsRemaining: 7,
    revision: 0,
    ...overrides,
  }));
}

describe('SharedBoardSessionController duel-status reconciliation', () => {
  // Regression (problem 2 in the sync spec): a fresh turn's opponentColumnCursor
  // starts null and only a move would set it — so the ghost was invisible
  // until the opponent actually moved. The paired duel-status must place it
  // at the opponent's real stored cursor (column 3 by default) immediately.
  test('the opponent ghost appears at column 3 from duel-status, before any opponent-cursor move', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'opponent-player', revision: 0 });
    expect(controller.view.opponentColumnCursor).toBeNull();

    transport.receive(duelStatusMessage({ revision: 0, activePlayerId: 'opponent-player', activeColumn: 3 }));
    expect(controller.view.opponentColumnCursor).toBe(3);
  });

  test('never overwrites opponentColumnCursor with activeColumn when the local player is active', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });
    transport.receive(duelStatusMessage({ revision: 0, activePlayerId: 'local-player', activeColumn: 5 }));
    expect(controller.view.opponentColumnCursor).toBeNull();
  });

  // Regression (problem 1 in the sync spec): a reconnect snapshot's
  // turn-assigned alone forces scores to a 0-0 placeholder. Only the paired
  // duel-status carries the real authoritative scores.
  test('a reconnect snapshot restores non-zero scores instead of leaving the turn-assigned placeholder', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    // Simulates reconnecting mid-match: the very first message this fresh
    // controller ever sees is already at revision 3.
    assignTurn(transport, { playerId: 'opponent-player', revision: 3 });
    expect(controller.view.localScore).toBe(0);
    expect(controller.view.opponentScore).toBe(0);

    transport.receive(duelStatusMessage({
      revision: 3,
      activePlayerId: 'opponent-player',
      scores: [
        { playerId: 'local-player', score: 120 },
        { playerId: 'opponent-player', score: 80 },
      ],
    }));
    expect(controller.view.localScore).toBe(120);
    expect(controller.view.opponentScore).toBe(80);
  });

  test('a same-revision status updates scalar state without requesting an animation discard', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });
    transport.receive(duelStatusMessage({ revision: 0, activePlayerId: 'local-player' }));
    expect(controller.consumeAnimationDiscard()).toBe(false);
  });

  test('a status ahead of the applied revision requests an animation discard and fast-forwards', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });
    // Revision 2 arrives with nothing locally applied in between — the tab
    // missed at least one turn-played/turn-expired event.
    transport.receive(duelStatusMessage({
      revision: 2,
      activePlayerId: 'opponent-player',
      scores: [
        { playerId: 'local-player', score: 50 },
        { playerId: 'opponent-player', score: 30 },
      ],
    }));
    expect(controller.consumeAnimationDiscard()).toBe(true);
    expect(controller.view.localScore).toBe(50);
    expect(controller.view.isMyTurn).toBe(false);
    // One-shot: consuming it again returns false until the next discard-worthy status.
    expect(controller.consumeAnimationDiscard()).toBe(false);
  });

  test('a fast-forward discards an unconsumed pending turn result as well as an active animation', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });
    transport.receive(serverMessage({
      type: 'turn-played',
      matchId: 'match-1',
      board: emptyBoard(),
      turnResult: {
        playerId: 'local-player',
        column: 3,
        triggerScoreDelta: 10,
        opponentScoreDelta: 0,
        stackSize: 1,
        steps: [],
        gameOver: false,
      },
      nextPlayerId: 'opponent-player',
      currentDisc: discC,
      nextDisc: discA,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 6,
      revision: 1,
    }));
    expect(controller.consumePendingTurnResult()).not.toBeNull();

    // Create another pending result, then skip ahead before the render loop
    // consumes it. The snapshot must prevent that stale result from starting.
    assignTurn(transport, { playerId: 'opponent-player', revision: 1 });
    transport.receive(serverMessage({
      type: 'turn-played',
      matchId: 'match-1',
      board: emptyBoard(),
      turnResult: {
        playerId: 'opponent-player',
        column: 3,
        triggerScoreDelta: 0,
        opponentScoreDelta: 0,
        stackSize: 1,
        steps: [],
        gameOver: false,
      },
      nextPlayerId: 'local-player',
      currentDisc: discA,
      nextDisc: discB,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 5,
      revision: 2,
    }));
    transport.receive(duelStatusMessage({ revision: 3, activePlayerId: 'opponent-player' }));

    expect(controller.consumeAnimationDiscard()).toBe(true);
    expect(controller.consumePendingTurnResult()).toBeNull();
  });

  test('a skipped turn revision waits for duel-status instead of applying a partial delta', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });

    transport.receive(serverMessage({
      type: 'turn-played',
      matchId: 'match-1',
      board: emptyBoard(),
      turnResult: {
        playerId: 'local-player',
        column: 3,
        triggerScoreDelta: 999,
        opponentScoreDelta: 0,
        stackSize: 1,
        steps: [],
        gameOver: false,
      },
      nextPlayerId: 'opponent-player',
      currentDisc: discC,
      nextDisc: discA,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 5,
      revision: 2,
    }));
    assignTurn(transport, { playerId: 'opponent-player', revision: 2 });
    expect(controller.view.localScore).toBe(0);
    expect(controller.view.isMyTurn).toBe(true);
    expect(controller.consumePendingTurnResult()).toBeNull();

    transport.receive(duelStatusMessage({
      revision: 2,
      activePlayerId: 'opponent-player',
      scores: [
        { playerId: 'local-player', score: 40 },
        { playerId: 'opponent-player', score: 25 },
      ],
    }));
    expect(controller.view.localScore).toBe(40);
    expect(controller.view.isMyTurn).toBe(false);
    expect(controller.consumeAnimationDiscard()).toBe(true);
  });

  test('a paused status keeps remaining time frozen across client time and later pulses', () => {
    const { clock, transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });
    transport.receive(duelStatusMessage({
      revision: 0,
      serverTime: 10_000,
      turnDeadline: 10_050,
      activePlayerId: 'local-player',
      paused: true,
      pausedBy: 'local-player',
    }));
    expect(controller.view.remainingMs).toBe(50);

    clock.value = 5_000;
    expect(controller.view.remainingMs).toBe(50);
    transport.receive(duelStatusMessage({
      revision: 0,
      serverTime: 11_000,
      turnDeadline: 11_050,
      activePlayerId: 'local-player',
      paused: true,
      pausedBy: 'local-player',
    }));
    expect(controller.view.remainingMs).toBe(50);
  });

  test('a stale status (older than the applied revision) is ignored entirely', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });
    transport.receive(duelStatusMessage({
      revision: 2,
      activePlayerId: 'opponent-player',
      scores: [
        { playerId: 'local-player', score: 50 },
        { playerId: 'opponent-player', score: 30 },
      ],
    }));
    controller.consumeAnimationDiscard();

    // An older, stale pulse must not undo the already-applied revision-2 state.
    transport.receive(duelStatusMessage({
      revision: 1,
      activePlayerId: 'local-player',
      scores: [
        { playerId: 'local-player', score: 999 },
        { playerId: 'opponent-player', score: 999 },
      ],
    }));
    expect(controller.view.localScore).toBe(50);
    expect(controller.view.isMyTurn).toBe(false);
    expect(controller.consumeAnimationDiscard()).toBe(false);
  });

  // Regression: "after reconnect, the first accepted status clears stale
  // animation even when its revision equals the last locally applied
  // revision" — otherwise a reconnect that happens to land back on the same
  // revision would leave a stale animation/pause banner on screen.
  test('reconnecting forces the next status to discard stale animation even at an equal revision', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });
    transport.receive(duelStatusMessage({ revision: 0, activePlayerId: 'local-player' }));
    expect(controller.consumeAnimationDiscard()).toBe(false);

    transport.setConnection('reconnecting');
    transport.setConnection('connected');

    // Same revision as already applied — would normally be a no-op merge.
    transport.receive(duelStatusMessage({ revision: 0, activePlayerId: 'local-player' }));
    expect(controller.consumeAnimationDiscard()).toBe(true);
  });

  test('reconnecting never accepts an older status and keeps the forced resync for the next current snapshot', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });
    transport.receive(duelStatusMessage({
      revision: 2,
      activePlayerId: 'opponent-player',
      scores: [
        { playerId: 'local-player', score: 50 },
        { playerId: 'opponent-player', score: 30 },
      ],
    }));
    controller.consumeAnimationDiscard();

    transport.setConnection('reconnecting');
    transport.setConnection('connected');
    transport.receive(duelStatusMessage({
      revision: 1,
      activePlayerId: 'local-player',
      scores: [
        { playerId: 'local-player', score: 999 },
        { playerId: 'opponent-player', score: 999 },
      ],
    }));
    expect(controller.view.localScore).toBe(50);
    expect(controller.view.isMyTurn).toBe(false);
    expect(controller.consumeAnimationDiscard()).toBe(false);

    transport.receive(duelStatusMessage({
      revision: 2,
      activePlayerId: 'opponent-player',
      scores: [
        { playerId: 'local-player', score: 50 },
        { playerId: 'opponent-player', score: 30 },
      ],
    }));
    expect(controller.consumeAnimationDiscard()).toBe(true);
  });

  test('a duel-status missing the local player\'s score fails as session-mismatch', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });
    transport.receive(duelStatusMessage({
      scores: [
        { playerId: 'opponent-player', score: 10 },
        { playerId: 'someone-else', score: 20 },
      ],
    }));
    expect(controller.view.compatibilityError).toBe('session-mismatch');
    expect(controller.view.phase).toBe('finished');
  });

  test('a duel-status for a stale matchId is ignored and does not mutate the current match', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });
    const before = controller.view;
    transport.receive(duelStatusMessage({
      matchId: 'not-this-match',
      revision: 5,
      scores: [
        { playerId: 'local-player', score: 999 },
        { playerId: 'opponent-player', score: 999 },
      ],
    }));
    expect(controller.view.localScore).toBe(before.localScore);
    expect(controller.view.opponentScore).toBe(before.opponentScore);
    expect(controller.view.compatibilityError).toBeNull();
  });

  test('a turn-played for a stale matchId is ignored and does not mutate the current match', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });
    const boardBefore = controller.view.board;
    transport.receive(serverMessage({
      type: 'turn-played',
      matchId: 'not-this-match',
      board: emptyBoard(),
      turnResult: {
        playerId: 'local-player',
        column: 3,
        triggerScoreDelta: 999,
        opponentScoreDelta: 999,
        stackSize: 0,
        steps: [],
        gameOver: false,
      },
      nextPlayerId: 'opponent-player',
      currentDisc: discC,
      nextDisc: discA,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 6,
      revision: 1,
    }));
    expect(controller.view.localScore).toBe(0);
    expect(controller.view.board).toEqual(boardBefore);
    expect(controller.consumePendingTurnResult()).toBeNull();
  });
});

describe('SharedBoardSessionController action hardening', () => {
  test('a duplicate local playTurn while a submission is pending sends only once', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });

    controller.playTurn(3);
    controller.playTurn(3);
    controller.playTurn(4);
    const sends = transport.sent.filter(m => m.type === 'play-turn');
    expect(sends).toHaveLength(1);

    // A turn-played clears the pending flag so the next real turn can send.
    transport.receive(serverMessage({
      type: 'turn-played',
      matchId: 'match-1',
      board: emptyBoard(),
      turnResult: {
        playerId: 'local-player',
        column: 3,
        triggerScoreDelta: 0,
        opponentScoreDelta: 0,
        stackSize: 0,
        steps: [],
        gameOver: false,
      },
      nextPlayerId: 'local-player',
      currentDisc: discC,
      nextDisc: discA,
      level: 1,
      turnsPerLevel: 7,
      turnsRemaining: 6,
      revision: 1,
    }));
    controller.playTurn(2);
    expect(transport.sent.filter(m => m.type === 'play-turn')).toHaveLength(2);
  });

  test('a same-revision status pulse does not release a pending turn submission', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });

    controller.playTurn(3);
    transport.receive(duelStatusMessage({ revision: 0, activePlayerId: 'local-player' }));
    controller.playTurn(4);
    expect(transport.sent.filter(message => message.type === 'play-turn')).toHaveLength(1);

    // A corrective assignment at the current revision is the explicit server
    // rejection path and does release the submission for retry.
    assignTurn(transport, { playerId: 'local-player', revision: 0 });
    controller.playTurn(4);
    expect(transport.sent.filter(message => message.type === 'play-turn')).toHaveLength(2);
  });

  test('no gameplay action is sent while disconnected or reconnecting', () => {
    const { transport, controller } = createSession();
    startCountdown(transport);
    assignTurn(transport, { playerId: 'local-player', revision: 0 });

    transport.setConnection('disconnected');
    controller.playTurn(3);
    controller.moveCursor(5);
    controller.requestPause(true);
    controller.forfeit();
    expect(transport.sent).toHaveLength(0);

    transport.setConnection('reconnecting');
    controller.playTurn(3);
    controller.moveCursor(5);
    expect(transport.sent).toHaveLength(0);

    transport.setConnection('connected');
    controller.moveCursor(5);
    expect(transport.sent).toHaveLength(1);
  });
});

describe('SharedBoardSessionController chat', () => {
  test('sends a normalized chat message', () => {
    const { transport, controller } = createSession();
    expect(controller.sendChat('  hi  ')).toBe(true);
    expect(transport.sent.at(-1)).toMatchObject({
      type: 'send-chat', text: 'hi', playerId: 'local-player',
    });
  });

  test('appends received chat messages and throttle notices to the view', () => {
    const { transport, controller } = createSession();
    transport.receive(serverMessage({ type: 'chat-message', playerId: 'opponent', text: 'hello' }));
    transport.receive(serverMessage({ type: 'chat-rate-limited' }));
    expect(controller.view.messages).toEqual([
      { kind: 'message', playerId: 'opponent', text: 'hello' },
      { kind: 'notice', text: expect.any(String) },
    ]);
  });

  test('refuses to send empty, over-long, or disconnected chat', () => {
    const { transport, controller } = createSession();
    expect(controller.sendChat('   ')).toBe(false);
    expect(controller.sendChat('a'.repeat(501))).toBe(false);
    transport.setConnection('disconnected');
    expect(controller.sendChat('hi')).toBe(false);
    expect(transport.sent).toEqual([]);
  });
});
