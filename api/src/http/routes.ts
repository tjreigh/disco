import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import type { Repositories } from '../db/repositories.js';
import {
  clearOidcStateCookie,
  clearSessionCookie,
  randomToken,
  readOidcStateCookie,
  setOidcStateCookie,
  setSessionCookie,
} from '../auth/cookies.js';
import { buildAuthorizationUrl, exchangeAndVerifyCode } from '../auth/oidc.js';
import { modeIdSchema, normalizeStats, scoreSubmissionSchema, statsSchema } from '../stats/schemas.js';
import { requireSession } from './authenticate.js';

const providerParamsSchema = z.object({ provider: z.string().min(1) });
const callbackQuerySchema = z.object({
  code: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  error: z.string().optional(),
});
const leaderboardQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

function redirectToSite(config: AppConfig, path = '/'): string {
  return new URL(path, config.publicSiteOrigin).toString();
}

export async function registerRoutes(app: FastifyInstance, config: AppConfig, repos: Repositories): Promise<void> {
  app.get('/health', async () => ({ ok: true }));

  app.get('/auth/login/:provider', async (request: FastifyRequest, reply: FastifyReply) => {
    const { provider: providerId } = providerParamsSchema.parse(request.params);
    const provider = config.oidcProviders.get(providerId);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });

    const state = randomToken();
    const nonce = randomToken();
    const codeVerifier = randomToken(48);
    setOidcStateCookie(reply, config, {
      providerId,
      state,
      nonce,
      codeVerifier,
      returnTo: redirectToSite(config),
    });

    const url = await buildAuthorizationUrl(provider, config.apiOrigin, state, nonce, codeVerifier);
    return reply.redirect(url);
  });

  app.get('/auth/callback/:provider', async (request: FastifyRequest, reply: FastifyReply) => {
    const { provider: providerId } = providerParamsSchema.parse(request.params);
    const query = callbackQuerySchema.parse(request.query);
    const stateCookie = readOidcStateCookie(request, config);
    clearOidcStateCookie(reply, config);

    if (query.error) return reply.redirect(`${redirectToSite(config)}?auth=error`);
    if (!query.code || !query.state || !stateCookie || stateCookie.state !== query.state || stateCookie.providerId !== providerId) {
      return reply.code(400).send({ error: 'invalid_oidc_state' });
    }

    const provider = config.oidcProviders.get(providerId);
    if (!provider) return reply.code(404).send({ error: 'unknown_provider' });

    const identity = await exchangeAndVerifyCode(
      provider,
      config.apiOrigin,
      query.code,
      stateCookie.codeVerifier,
      stateCookie.nonce,
    );
    const account = repos.findOrCreateAccountForIdentity({
      issuer: identity.issuer,
      subject: identity.subject,
      email: identity.email,
      emailVerified: identity.emailVerified,
      providerName: providerId,
      displayName: identity.displayName,
    });

    const token = randomToken(48);
    const expiresAt = new Date(Date.now() + config.sessionTtlSeconds * 1000);
    repos.createSession(account.id, token, expiresAt);
    setSessionCookie(reply, config, token);
    return reply.redirect(stateCookie.returnTo);
  });

  app.post('/auth/logout', async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.cookies[config.sessionCookieName];
    if (token) repos.revokeSession(token);
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  app.get('/me', async (request: FastifyRequest) => ({
    account: request.auth?.account ?? null,
    identities: request.auth ? repos.listIdentities(request.auth.account.id).map(identity => ({
      id: identity.id,
      providerName: identity.providerName,
      issuer: identity.issuer,
      email: identity.email,
      emailVerified: identity.emailVerified,
    })) : [],
  }));

  app.get('/stats', { preHandler: requireSession }, async (request: FastifyRequest) => ({
    stats: repos.getStats(request.auth!.account.id),
  }));

  app.put('/stats/:modeId', { preHandler: requireSession }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { modeId } = z.object({ modeId: modeIdSchema }).parse(request.params);
    const parsedBody = z.record(z.unknown()).parse(request.body);
    const body = normalizeStats(statsSchema.parse({ ...parsedBody, modeId }));
    const stats = repos.upsertStats(request.auth!.account.id, body);
    return reply.code(200).send({ stats });
  });

  app.post('/scores/:modeId', { preHandler: requireSession }, async (request: FastifyRequest, reply: FastifyReply) => {
    const { modeId } = z.object({ modeId: modeIdSchema }).parse(request.params);
    const body = scoreSubmissionSchema.parse(request.body);
    const clientStats = body.clientStats ? normalizeStats({ ...body.clientStats, modeId }) : null;
    const stats = repos.submitScore(request.auth!.account.id, {
      modeId,
      score: body.score,
      longestStreak: body.longestStreak,
      clientStats,
    });
    return reply.code(201).send({ stats });
  });

  app.get('/leaderboards/:modeId', async (request: FastifyRequest) => {
    const { modeId } = z.object({ modeId: modeIdSchema }).parse(request.params);
    const { limit } = leaderboardQuerySchema.parse(request.query);
    return { entries: repos.leaderboard(modeId, limit) };
  });
}
