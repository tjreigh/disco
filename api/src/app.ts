import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from './config.js';
import type { Db } from './db/connection.js';
import { Repositories } from './db/repositories.js';
import { sessionLoader } from './http/authenticate.js';
import { registerRoutes } from './http/routes.js';

export async function buildApp(config: AppConfig, db: Db) {
  const app = Fastify({ logger: config.nodeEnv !== 'test' });
  const repos = new Repositories(db);

  await app.register(cookie);
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
    app.log.error(error);
    reply.code(500).send({ error: 'internal_error' });
  });

  await registerRoutes(app, config, repos);
  return app;
}
