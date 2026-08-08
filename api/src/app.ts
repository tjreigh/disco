import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError } from 'zod';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import type { Db } from './db/connection.js';
import { Repositories } from './db/repositories.js';
import { sessionLoader } from './http/authenticate.js';
import { registerRoutes } from './http/routes.js';
import {
  registerMultiplayerGateway,
} from './multiplayer/room-gateway.js';
import {
  SCORE_RACE_ROOM_MODE,
  ScoreRaceRoomService,
} from './multiplayer/room-service.js';
import {
  SHARED_DUEL_ROOM_MODE,
  SharedBoardRoomService,
} from './multiplayer/shared-board-room-service.js';

export interface BuildAppOptions {
  readonly roomService?: ScoreRaceRoomService;
  readonly sharedBoardRoomService?: SharedBoardRoomService;
  readonly roomTickMs?: number;
  readonly roomHeartbeatMs?: number;
}

export async function buildApp(
  config: AppConfig,
  db: Db,
  options: BuildAppOptions = {},
) {
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
    // Production traffic arrives through Caddy on loopback. Trust forwarded
    // client addresses only from that hop so rate-limit keys cannot be spoofed
    // by a directly connected remote client.
    trustProxy: ['127.0.0.1', '::1'],
  });
  const repos = new Repositories(db);
  const roomService = options.roomService ?? new ScoreRaceRoomService({
    clock: { now: () => Date.now() },
  });
  const sharedBoardRoomService = options.sharedBoardRoomService ?? new SharedBoardRoomService({
    clock: { now: () => Date.now() },
  });

  // WebSocket support must be installed before any route declarations.
  await app.register(websocket, {
    options: { maxPayload: 4_096 },
  });
  await app.register(cookie);
  await app.register(rateLimit, { global: false });
  await app.register(cors, {
    origin: config.publicSiteOrigin,
    methods: ['GET', 'POST', 'PUT', 'OPTIONS'],
    allowedHeaders: ['content-type'],
    credentials: true,
  });

  app.addHook('preHandler', sessionLoader(config, repos));
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof ZodError) {
      reply.code(400).send({ error: 'invalid_request', details: error });
      return;
    }
    if (error.statusCode === 413) {
      reply.code(413).send({ error: 'payload_too_large' });
      return;
    }
    if (error.statusCode === 429) {
      reply.code(429).send({ error: 'rate_limited' });
      return;
    }
    app.log.error(error);
    reply.code(500).send({ error: 'internal_error' });
  });

  await registerRoutes(app, config, repos);
  await registerMultiplayerGateway(app, {
    [SCORE_RACE_ROOM_MODE.id]: roomService,
    [SHARED_DUEL_ROOM_MODE.id]: sharedBoardRoomService,
  }, {
    ...(options.roomTickMs !== undefined ? { tickMs: options.roomTickMs } : {}),
    ...(options.roomHeartbeatMs !== undefined ? { heartbeatIntervalMs: options.roomHeartbeatMs } : {}),
  });
  return app;
}
