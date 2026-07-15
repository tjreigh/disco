import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import type { Db } from './db/connection.js';
import { Repositories } from './db/repositories.js';
import { sessionLoader } from './http/authenticate.js';
import { registerRoutes } from './http/routes.js';

export async function buildApp(config: AppConfig, db: Db) {
  const app = Fastify({
    logger: config.nodeEnv !== 'test',
    // Production traffic arrives through Caddy on loopback. Trust forwarded
    // client addresses only from that hop so rate-limit keys cannot be spoofed
    // by a directly connected remote client.
    trustProxy: ['127.0.0.1', '::1'],
  });
  const repos = new Repositories(db);

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
  return app;
}
