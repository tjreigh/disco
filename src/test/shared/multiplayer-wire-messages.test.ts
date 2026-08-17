import { describe, expect, test } from 'vitest';
import {
  encodeMultiplayerClientMessage,
  encodeMultiplayerServerMessage,
  parseMultiplayerServerMessage,
  parseMultiplayerClientWireMessage,
  parseMultiplayerServerWireMessage,
} from '../../shared/multiplayer-messages.js';
import {
  multiplayerModeIdentity,
  MULTIPLAYER_PROTOCOL_VERSION,
} from '../../shared/multiplayer-contracts.js';
import { SCORE_RACE_MODE } from '../../game/modes/index.js';

const context = { roomId: 'ROOM1', playerId: 'player-1' };
const mode = multiplayerModeIdentity(SCORE_RACE_MODE);

describe('multiplayer wire envelopes', () => {
  test('a client command does not repeat authenticated identity', () => {
    const internal = {
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      ...context,
      type: 'set-ready' as const,
      ready: true,
    };

    const wire = encodeMultiplayerClientMessage(internal);

    expect(wire).toEqual({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      command: { type: 'set-ready', ready: true },
    });
    expect(parseMultiplayerClientWireMessage(wire, context)).toEqual({
      ok: true,
      message: internal,
    });
  });

  test('rejects identity smuggled into a command body', () => {
    expect(parseMultiplayerClientWireMessage({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      command: { type: 'set-ready', ready: true, playerId: 'someone-else' },
    }, context)).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('a server event groups room context separately from event data', () => {
    const internal = {
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: context.roomId,
      mode,
      type: 'room-state' as const,
      localReady: true,
      opponentReady: false,
      opponentJoined: false,
      opponentConnected: false,
    };

    const wire = encodeMultiplayerServerMessage(internal);

    expect(wire).toEqual({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      room: { id: context.roomId, mode },
      event: {
        type: 'room-state', localReady: true, opponentReady: false,
        opponentJoined: false, opponentConnected: false,
      },
    });
    expect(parseMultiplayerServerWireMessage(wire)).toEqual({
      ok: true,
      message: internal,
    });
  });

  test('requires explicit opponent presence in room state', () => {
    expect(parseMultiplayerServerMessage({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: context.roomId,
      mode,
      type: 'room-state',
      localReady: false,
      opponentReady: false,
      opponentConnected: false,
    })).toEqual({ ok: false, error: 'invalid-message' });
  });

  test('reports a protocol mismatch before inspecting the body', () => {
    expect(parseMultiplayerServerWireMessage({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION + 1,
      room: {},
      event: {},
    })).toEqual({ ok: false, error: 'protocol-mismatch' });
  });

  test('a chat command does not repeat authenticated identity', () => {
    const internal = {
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      ...context,
      type: 'send-chat' as const,
      text: 'hello',
    };

    const wire = encodeMultiplayerClientMessage(internal);

    expect(wire).toEqual({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      command: { type: 'send-chat', text: 'hello' },
    });
    expect(parseMultiplayerClientWireMessage(wire, context)).toEqual({
      ok: true,
      message: internal,
    });
  });

  test('a chat event carries only the sender and text', () => {
    const internal = {
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      roomId: context.roomId,
      mode,
      type: 'chat-message' as const,
      playerId: 'player-2',
      text: 'hello',
    };

    const wire = encodeMultiplayerServerMessage(internal);

    expect(wire).toEqual({
      protocolVersion: MULTIPLAYER_PROTOCOL_VERSION,
      room: { id: context.roomId, mode },
      event: { type: 'chat-message', playerId: 'player-2', text: 'hello' },
    });
    expect(parseMultiplayerServerWireMessage(wire)).toEqual({
      ok: true,
      message: internal,
    });
  });
});
