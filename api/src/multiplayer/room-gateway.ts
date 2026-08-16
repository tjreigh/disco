import type { FastifyInstance, FastifyReply } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';
import {
  MULTIPLAYER_PROTOCOL_VERSION,
  encodeMultiplayerServerMessage,
  multiplayerModeIdentity,
  parseMultiplayerClientWireMessage,
} from './contracts.js';
import type {
  MultiplayerClientMessage,
  MultiplayerModeIdentity,
} from './contracts.js';
import type {
  RoomAdmission,
  RoomAdmissionRequest,
  RoomConnectRequest,
  RoomConnection,
  RoomDelivery,
  RoomJoinRequest,
  RoomServiceError,
  RoomServiceResult,
  RoomTickResult,
} from './room-types.js';

/**
 * Structural contract shared by every per-mode room service
 * (ScoreRaceRoomService, SharedBoardRoomService, ...). The gateway routes to
 * one of these by the mode identity a client declares at create/join time.
 */
export interface MultiplayerRoomService {
  createRoom(request: RoomAdmissionRequest): RoomServiceResult<RoomAdmission>;
  joinRoom(request: RoomJoinRequest): RoomServiceResult<RoomAdmission>;
  connect(request: RoomConnectRequest): RoomServiceResult<RoomConnection>;
  disconnect(connection: RoomConnection): readonly RoomDelivery[];
  receive(connection: RoomConnection, message: MultiplayerClientMessage): RoomServiceResult<null>;
  tick(): RoomTickResult;
}

const ROOM_TICK_MS = 250;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const SOCKET_MAX_PAYLOAD_BYTES = 4_096;
const CREATE_ROOM_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;
const JOIN_ROOM_RATE_LIMIT = { max: 30, timeWindow: '1 minute' } as const;
// Recoverable rejections (a late cursor move, a duplicate drop, ...) are
// expected under normal play and must never spam production logs — sample
// at most one log line per room+error combination per interval, reporting
// how many occurred since the last one.
const RECOVERABLE_LOG_INTERVAL_MS = 5_000;

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
  protocolVersion: z.number().int().positive(),
  authenticate: z.object({
    roomId: z.string().trim().min(1).max(32).transform(value => value.toUpperCase()),
    playerId: z.string().trim().min(1).max(128),
    reconnectCredential: z.string().trim().min(1).max(256),
  }).strict(),
}).strict();

export interface MultiplayerGatewayOptions {
  readonly tickMs?: number;
  readonly heartbeatIntervalMs?: number;
}

interface ActiveSocket {
  readonly socket: WebSocket;
  readonly connection: RoomConnection;
  readonly service: MultiplayerRoomService;
}

interface TransportErrorMessage {
  readonly type: 'room-transport-error';
  readonly error: RoomServiceError | 'invalid-message';
}

/**
 * Public network adapter for private multiplayer rooms.
 *
 * Guests are admitted over rate-limited HTTP. The socket authenticates in its
 * first message so reconnect credentials do not leak through URLs or access logs.
 * Only validated canonical messages cross into a room service.
 *
 * `servicesByModeId` holds one room service per supported mode identity (e.g.
 * `score-race`, `shared-duel`). A create/join request declares the mode it
 * wants and is routed to the matching service; a room's owning service is
 * then remembered so later socket traffic for that room reaches the same
 * service, since the socket's own first message carries no mode identity.
 */
export async function registerMultiplayerGateway(
  app: FastifyInstance,
  servicesByModeId: Readonly<Record<string, MultiplayerRoomService>>,
  options: MultiplayerGatewayOptions = {},
): Promise<void> {
  const sockets = new Map<string, ActiveSocket>();
  const roomOwners = new Map<string, MultiplayerRoomService>();
  const tickMs = options.tickMs ?? ROOM_TICK_MS;
  const recoverableCounts = new Map<string, number>();
  const recoverableLastLoggedAt = new Map<string, number>();

  const recordRecoverableRejection = (
    connection: RoomConnection,
    error: RoomServiceError,
    messageType: string,
  ): void => {
    const key = `${connection.roomId}:${error}`;
    const count = (recoverableCounts.get(key) ?? 0) + 1;
    recoverableCounts.set(key, count);
    const now = Date.now();
    const lastLoggedAt = recoverableLastLoggedAt.get(key) ?? 0;
    if (now - lastLoggedAt < RECOVERABLE_LOG_INTERVAL_MS) return;
    recoverableLastLoggedAt.set(key, now);
    recoverableCounts.set(key, 0);
    app.log.info(
      { roomId: connection.roomId, playerId: connection.playerId, error, messageType, countSinceLastLog: count },
      'multiplayer recoverable rejection',
    );
  };

  const clearRecoverableRejections = (roomId: string): void => {
    const prefix = `${roomId}:`;
    for (const key of recoverableCounts.keys()) {
      if (key.startsWith(prefix)) recoverableCounts.delete(key);
    }
    for (const key of recoverableLastLoggedAt.keys()) {
      if (key.startsWith(prefix)) recoverableLastLoggedAt.delete(key);
    }
  };

  const dispatch = (deliveries: readonly RoomDelivery[]): void => {
    // Every room-service output (message handling, the tick, connect,
    // disconnect) funnels through here, so this is the one place that can
    // see match-level state transitions without the room services
    // themselves depending on a logger. A broadcast delivers the same
    // logical event once per player — dedupe within this call so a pause or
    // finish is logged once, not twice.
    const loggedEvents = new Set<string>();
    for (const delivery of deliveries) {
      logNotableEvent(delivery.message, loggedEvents);
      const active = sockets.get(delivery.playerId);
      if (active && active.socket.readyState === active.socket.OPEN) {
        active.socket.send(JSON.stringify(encodeMultiplayerServerMessage(delivery.message)));
      }
    }
  };

  const logNotableEvent = (message: RoomDelivery['message'], loggedEvents: Set<string>): void => {
    if (message.type !== 'match-paused' && message.type !== 'match-finished') return;
    const key = `${message.type}:${message.roomId}:${message.matchId}`;
    if (loggedEvents.has(key)) return;
    loggedEvents.add(key);
    if (message.type === 'match-paused') {
      app.log.info(
        { roomId: message.roomId, matchId: message.matchId, paused: message.paused, pausedBy: message.pausedBy },
        'multiplayer match pause state changed',
      );
    } else {
      app.log.info(
        {
          roomId: message.roomId,
          matchId: message.matchId,
          winnerId: message.result.winnerId,
          forfeitedBy: message.result.forfeitedBy,
        },
        'multiplayer match finished',
      );
    }
  };

  const timer = setInterval(() => {
    for (const service of Object.values(servicesByModeId)) {
      const result = service.tick();
      dispatch(result.deliveries);
      for (const roomId of result.expiredRoomIds) {
        roomOwners.delete(roomId);
        clearRecoverableRejections(roomId);
      }
    }
  }, tickMs);
  timer.unref();
  app.addHook('onClose', async () => {
    clearInterval(timer);
  });

  // Detects a connection that has gone silently dead (network partition, a
  // device sleeping mid-connection, a dropped NAT mapping) without ever
  // firing a 'close' event on its own — the room/turn-freeze logic below
  // only engages once 'close' fires, so a silent death would otherwise
  // never be noticed. `true` means a pong (or the initial connection) has
  // been seen since the last ping; a socket still `false` when the next
  // interval fires missed its previous ping entirely. This timer is
  // intentionally separate from the room-state tick above.
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const heartbeatAlive = new Map<WebSocket, boolean>();
  // Marks a socket as terminated-by-heartbeat so the 'close' handler's log
  // line can distinguish a silent death from a normal close/replace — the
  // whole reason this diagnostic exists.
  const heartbeatTerminated = new WeakSet<WebSocket>();
  const heartbeatTimer = setInterval(() => {
    for (const [socket, alive] of heartbeatAlive) {
      if (socket.readyState !== socket.OPEN) {
        heartbeatAlive.delete(socket);
        continue;
      }
      if (!alive) {
        heartbeatAlive.delete(socket);
        heartbeatTerminated.add(socket);
        // terminate() fires this socket's own 'close' handler, which is
        // what actually calls service.disconnect() and starts the
        // abandonment timer — this timer only detects and forces the close.
        socket.terminate();
        continue;
      }
      heartbeatAlive.set(socket, false);
      socket.ping();
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();
  app.addHook('onClose', async () => {
    clearInterval(heartbeatTimer);
  });

  app.post('/multiplayer/rooms', {
    config: { rateLimit: CREATE_ROOM_RATE_LIMIT },
    bodyLimit: 1_024,
  }, async (request, reply) => {
    const body = admissionSchema.parse(request.body);
    const service = servicesByModeId[body.mode.id];
    if (!service) return sendAdmissionResult(reply, modeMismatch(), 201);
    const result = service.createRoom({
      protocolVersion: body.protocolVersion,
      mode: multiplayerModeIdentity(body.mode),
    });
    if (result.ok) roomOwners.set(result.value.roomId, service);
    return sendAdmissionResult(reply, result, 201);
  });

  app.post('/multiplayer/rooms/:roomId/join', {
    config: { rateLimit: JOIN_ROOM_RATE_LIMIT },
    bodyLimit: 1_024,
  }, async (request, reply) => {
    const { roomId } = roomParamsSchema.parse(request.params);
    const body = admissionSchema.parse(request.body);
    const service = servicesByModeId[body.mode.id];
    if (!service) return sendAdmissionResult(reply, modeMismatch(), 201);
    const result = service.joinRoom({
      roomId,
      protocolVersion: body.protocolVersion,
      mode: multiplayerModeIdentity(body.mode),
    });
    if (result.ok) roomOwners.set(roomId, service);
    return sendAdmissionResult(reply, result, 201);
  });

  app.get('/multiplayer/socket', { websocket: true }, (socket) => {
    let connection: RoomConnection | null = null;
    let ownerService: MultiplayerRoomService | null = null;

    heartbeatAlive.set(socket, true);
    socket.on('pong', () => {
      heartbeatAlive.set(socket, true);
    });

    socket.on('message', (raw) => {
      if (!connection || !ownerService) {
        const authentication = parseSocketAuthentication(raw);
        if (!authentication) {
          closeWithError(socket, 'invalid-message');
          return;
        }
        if (authentication.protocolVersion !== MULTIPLAYER_PROTOCOL_VERSION) {
          closeWithError(socket, 'protocol-mismatch');
          return;
        }
        const service = roomOwners.get(authentication.authenticate.roomId);
        if (!service) {
          closeWithError(socket, 'room-not-found');
          return;
        }
        const result = service.connect(authentication.authenticate);
        if (!result.ok) {
          dispatch(result.deliveries);
          closeWithError(socket, result.error);
          return;
        }
        connection = result.value;
        ownerService = service;
        const previous = sockets.get(connection.playerId);
        sockets.set(connection.playerId, { socket, connection, service });
        if (previous && previous.socket !== socket) {
          previous.socket.close(4001, 'Connection replaced');
        }
        app.log.info(
          { roomId: connection.roomId, playerId: connection.playerId, reconnect: previous !== undefined },
          'multiplayer socket authenticated',
        );
        dispatch(result.deliveries);
        return;
      }

      const parsed = parseClientMessage(raw, connection);
      if (!parsed) {
        closeWithError(socket, 'invalid-message');
        return;
      }
      const result = ownerService.receive(connection, parsed);
      dispatch(result.deliveries);
      if (!result.ok) {
        // Only 'recoverable' keeps the socket open; every other (fatal)
        // disposition closes it — a fail-closed default if a new
        // disposition value is ever added without updating this branch.
        if (result.disposition === 'recoverable') {
          // Deliveries already dispatched above carry the corrective
          // snapshot; the socket stays open for the next valid message.
          recordRecoverableRejection(connection, result.error, parsed.type);
        } else {
          closeWithError(socket, result.error);
        }
      }
    });

    socket.on('close', () => {
      heartbeatAlive.delete(socket);
      if (!connection || !ownerService) return;
      const active = sockets.get(connection.playerId);
      if (active?.connection !== connection) return;
      sockets.delete(connection.playerId);
      const reason = heartbeatTerminated.has(socket) ? 'heartbeat-timeout' : 'closed';
      heartbeatTerminated.delete(socket);
      const logLevel = reason === 'heartbeat-timeout' ? 'warn' : 'info';
      app.log[logLevel]({ roomId: connection.roomId, playerId: connection.playerId, reason }, 'multiplayer socket disconnected');
      dispatch(ownerService.disconnect(connection));
    });
  });
}

function parseSocketAuthentication(raw: RawData) {
  const value = parseJson(raw);
  const parsed = socketAuthenticationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseClientMessage(
  raw: RawData,
  connection: RoomConnection,
): MultiplayerClientMessage | null {
  const parsed = parseMultiplayerClientWireMessage(parseJson(raw), connection);
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

function modeMismatch(): RoomServiceResult<never> {
  return { ok: false, disposition: 'fatal', error: 'mode-mismatch', deliveries: [] };
}
