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

    // A fresh turn-assigned clears it until the new active player moves again.
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
