import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Repositories, AuthenticatedSession } from '../db/repositories.js';
import type { AppConfig } from '../config.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthenticatedSession | null;
  }
}

export function sessionLoader(config: AppConfig, repos: Repositories) {
  return async function loadSession(request: FastifyRequest): Promise<void> {
    const token = request.cookies[config.sessionCookieName];
    request.auth = token ? repos.findSessionByToken(token) : null;
  };
}

export async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!request.auth) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
}
