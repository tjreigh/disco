import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';

const OIDC_STATE_COOKIE = 'disco_oidc_state';

export interface OidcStateCookie {
  providerId: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function sign(value: string, secret: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

function encodeSignedJson(value: unknown, secret: string): string {
  const payload = Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function decodeSignedJson<T>(cookieValue: string | undefined, secret: string): T | null {
  if (!cookieValue) return null;
  const [payload, signature] = cookieValue.split('.');
  if (!payload || !signature) return null;

  const expected = sign(payload, secret);
  const provided = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (provided.length !== expectedBuffer.length || !timingSafeEqual(provided, expectedBuffer)) {
    return null;
  }

  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as T;
}

// Paths remain explicit because session and OIDC cookies use different scopes.
function baseCookieOptions(config: AppConfig, path: string) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax' as const,
    path,
  };
}

export function setSessionCookie(reply: FastifyReply, config: AppConfig, token: string): void {
  reply.setCookie(config.sessionCookieName, token, {
    ...baseCookieOptions(config, '/'),
    maxAge: config.sessionTtlSeconds,
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(config.sessionCookieName, baseCookieOptions(config, '/'));
}

export function setOidcStateCookie(reply: FastifyReply, config: AppConfig, state: OidcStateCookie): void {
  reply.setCookie(OIDC_STATE_COOKIE, encodeSignedJson(state, config.sessionSecret), {
    ...baseCookieOptions(config, '/auth'),
    maxAge: 10 * 60,
  });
}

export function readOidcStateCookie(request: FastifyRequest, config: AppConfig): OidcStateCookie | null {
  return decodeSignedJson<OidcStateCookie>(request.cookies[OIDC_STATE_COOKIE], config.sessionSecret);
}

export function clearOidcStateCookie(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(OIDC_STATE_COOKIE, baseCookieOptions(config, '/auth'));
}
