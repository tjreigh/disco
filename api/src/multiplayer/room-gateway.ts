import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  parseMultiplayerClientMessage,
} from './contracts.js';
import type {
  MultiplayerClientMessage,
  MultiplayerModeIdentity,
} from './contracts.js';
import {
  ScoreRaceRoomService,
} from './room-service.js';
import type {
  RoomConnection,
  RoomDelivery,
  RoomServiceError,
  RoomServiceResult,
} from './room-service.js';

const ROOM_TICK_MS = 250;
const SOCKET_MAX_PAYLOAD_BYTES = 4_096;
const CREATE_ROOM_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;
const JOIN_ROOM_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;

const modeIdentitySchema = z.object({
  id: z.string().trim().min(1).max(64),
  version: z.number().int().positive(),
  rules: z.object({
    id: z.string().trim().min(1).max(64),
    version: z.number().int().positive(),
  }).strict(),
}).strict();

const admissionSchema = z.object({
  protocolVersion: z.number().int().positive(),
  mode: modeIdentitySchema,
}).strict();

const roomParamsSchema = z.object({
  roomId: z.string().trim().min(1).max(32).transform(value => value.toUpperCase()),
}).strict();

const socketAuthenticationSchema = z.object({
  type: z.literal('authenticate-room'),
  protocolVersion: z.number().int().positive(),
  roomId: z.string().trim().min(1).max(32).transform(value => value.toUpperCase()),
  playerId: z.string().trim().min(1).max(128),
  reconnectCredential: z.string().trim().min(1).max(256),
}).strict();

export interface MultiplayerGatewayOptions {
  readonly tickMs?: number;
}

interface ActiveSocket {
  readonly socket: WebSocket;
  readonly connection: RoomConnection;
}

interface TransportErrorMessage {
  readonly type: 'room-transport-error';
  readonly error: RoomServiceError | 'invalid-message';
}

/**
 * Public network adapter for private Score Race rooms.
 *
 * Guests are admitted over rate-limited HTTP. The socket authenticates in its
 * first message so reconnect credentials do not leak through URLs or access logs.
 * Only validated canonical messages cross into the room service.
 */
export async function registerMultiplayerGateway(
  app: FastifyInstance,
  service: ScoreRaceRoomService,
  options: MultiplayerGatewayOptions = {},
): Promise<void> {
  const sockets = new Map<string, ActiveSocket>();
  const tickMs = options.tickMs ?? ROOM_TICK_MS;

  const dispatch = (deliveries: readonly RoomDelivery[]): void => {
    for (const delivery of deliveries) {
      const active = sockets.get(delivery.playerId);
      if (active && active.socket.readyState === active.socket.OPEN) {
        active.socket.send(JSON.stringify(delivery.message));
      }
    }
  };

  const timer = setInterval(() => {
    dispatch(service.tick().deliveries);
  }, tickMs);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
  });

  app.post('/multiplayer/rooms', {
    config: { rateLimit: CREATE_ROOM_RATE_LIMIT },
    bodyLimit: 1_024,
  }, async (request, reply) => {
    const body = admissionSchema.parse(request.body);
    return sendAdmissionResult(reply, service.createRoom({
      protocolVersion: body.protocolVersion,
      mode: copyMode(body.mode),
    }), 201);
  });

  app.post('/multiplayer/rooms/:roomId/join', {
    config: { rateLimit: JOIN_ROOM_RATE_LIMIT },
    bodyLimit: 1_024,
  }, async (request, reply) => {
    const { roomId } = roomParamsSchema.parse(request.params);
    const body = admissionSchema.parse(request.body);
    return sendAdmissionResult(reply, service.joinRoom({
      roomId,
      protocolVersion: body.protocolVersion,
      mode: copyMode(body.mode),
    }), 201);
  });

  app.get('/multiplayer/socket', { websocket: true }, (socket) => {
    let connection: RoomConnection | null = null;

    socket.on('message', (raw) => {
      if (!connection) {
        const authentication = parseSocketAuthentication(raw);
        if (!authentication) {
          closeWithError(socket, 'invalid-message');
          return;
        }
        if (authentication.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) {
          closeWithError(socket, 'protocol-mismatch');
          return;
        }
        const result = service.connect(authentication);
        if (!result.ok) {
          dispatch(result.deliveries);
          closeWithError(socket, result.error);
          return;
        }
        connection = result.value;
        const previous = sockets.get(connection.playerId);
        sockets.set(connection.playerId, { socket, connection });
        if (previous && previous.socket !== socket) {
          previous.socket.close(4001, 'Connection replaced');
        }
        dispatch(result.deliveries);
        return;
      }

      const parsed = parseClientMessage(raw);
      if (!parsed) {
        closeWithError(socket, 'invalid-message');
        return;
      }
      const result = service.receive(connection, parsed);
      dispatch(result.deliveries);
      if (!result.ok) closeWithError(socket, result.error);
    });

    socket.on('close', () => {
      if (!connection) return;
      const active = sockets.get(connection.playerId);
      if (active?.connection !== connection) return;
      sockets.delete(connection.playerId);
      dispatch(service.disconnect(connection));
    });
  });
}

function parseSocketAuthentication(raw: RawData) {
  const value = parseJson(raw);
  const parsed = socketAuthenticationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseClientMessage(raw: RawData): MultiplayerClientMessage | null {
  const parsed = parseMultiplayerClientMessage(parseJson(raw));
  return parsed.ok ? parsed.message : null;
}

function parseJson(raw: RawData): unknown {
  try {
    return JSON.parse(raw.toString());
  } catch {
    return null;
  }
}

function closeWithError(
  socket: WebSocket,
  error: TransportErrorMessage['error'],
): void {
  if (socket.readyState !== socket.OPEN) return;
  const message: TransportErrorMessage = { type: 'room-transport-error', error };
  socket.send(JSON.stringify(message), () => socket.close(1008, error));
}

function sendAdmissionResult<T>(
  reply: FastifyReply,
  result: RoomServiceResult<T>,
  successStatus: number,
) {
  if (result.ok) return reply.code(successStatus).send(result.value);
  return reply.code(statusForRoomError(result.error)).send({ error: result.error });
}

function statusForRoomError(error: RoomServiceError): number {
  switch (error) {
    case 'room-not-found': return 404;
    case 'room-full':
    case 'protocol-mismatch':
    case 'mode-mismatch':
      return 409;
    default:
      return 400;
  }
}

function copyMode(mode: MultiplayerModeIdentity): MultiplayerModeIdentity {
  return {
    id: mode.id,
    version: mode.version,
    rules: { id: mode.rules.id, version: mode.rules.version },
  };
}
