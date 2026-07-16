import { createHash } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type Database from 'better-sqlite3';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import type { CryptoKey } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import type { OidcProviderConfig } from '../src/config.js';
import { Repositories } from '../src/db/repositories.js';
import {
  clearOidcStateCookie,
  clearSessionCookie,
  randomToken,
  readOidcStateCookie,
  setOidcStateCookie,
  setSessionCookie,
} from '../src/auth/cookies.js';
import { buildAuthorizationUrl, exchangeAndVerifyCode } from '../src/auth/oidc.js';
import { createTestConfig, createTestDb } from './helpers.js';

function discoveryDocFor(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
  };
}

function makeProvider(issuer: string, overrides: Partial<OidcProviderConfig> = {}): OidcProviderConfig {
  return {
    id: 'test-provider',
    issuer,
    clientId: 'client-abc',
    clientSecret: 'secret-abc',
    scope: 'openid email profile',
    ...overrides,
  };
}

async function signIdToken(opts: {
  issuer: string;
  clientId: string;
  nonce: string;
  privateKey: CryptoKey;
  kid: string;
  subject?: string;
  email?: string | null;
  emailVerified?: boolean;
  name?: string | null;
}): Promise<string> {
  const claims: Record<string, unknown> = { nonce: opts.nonce };
  if (opts.email !== undefined) claims.email = opts.email;
  if (opts.emailVerified !== undefined) claims.email_verified = opts.emailVerified;
  if (opts.name !== undefined) claims.name = opts.name;

  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid })
    .setIssuedAt()
    .setIssuer(opts.issuer)
    .setSubject(opts.subject ?? 'subject-123')
    .setAudience(opts.clientId)
    .setExpirationTime('10m')
    .sign(opts.privateKey);
}

describe('cookies', () => {
  const config = createTestConfig();
  let app: FastifyInstance;

  async function buildCookieHarness(): Promise<FastifyInstance> {
    const harness = Fastify({ logger: false });
    await harness.register(fastifyCookie);
    harness.get('/set-oidc-state', async (_request, reply) => {
      setOidcStateCookie(reply, config, {
        providerId: 'test-provider',
        state: 'state-value',
        nonce: 'nonce-value',
        codeVerifier: 'verifier-value',
        returnTo: 'http://localhost:3000/',
      });
      return { ok: true };
    });
    harness.get('/read-oidc-state', async request => ({ state: readOidcStateCookie(request, config) }));
    harness.get('/clear-oidc-state', async (_request, reply) => {
      clearOidcStateCookie(reply, config);
      return { ok: true };
    });
    harness.get('/set-session', async (_request, reply) => {
      setSessionCookie(reply, config, 'session-token-value');
      return { ok: true };
    });
    harness.get('/clear-session', async (_request, reply) => {
      clearSessionCookie(reply, config);
      return { ok: true };
    });
    await harness.ready();
    return harness;
  }

  afterEach(async () => {
    await app?.close();
  });

  it('round-trips a signed OIDC state cookie', async () => {
    app = await buildCookieHarness();

    const setResponse = await app.inject({ method: 'GET', url: '/set-oidc-state' });
    const stateCookie = setResponse.cookies.find(c => c.name === 'disco_oidc_state');
    expect(stateCookie).toBeDefined();
    expect(stateCookie!.path).toBe('/auth');
    expect(stateCookie!.httpOnly).toBe(true);

    const readResponse = await app.inject({
      method: 'GET',
      url: '/read-oidc-state',
      cookies: { disco_oidc_state: stateCookie!.value },
    });

    expect(readResponse.json().state).toEqual({
      providerId: 'test-provider',
      state: 'state-value',
      nonce: 'nonce-value',
      codeVerifier: 'verifier-value',
      returnTo: 'http://localhost:3000/',
    });
  });

  it('returns null when the cookie signature has been tampered with', async () => {
    app = await buildCookieHarness();

    const setResponse = await app.inject({ method: 'GET', url: '/set-oidc-state' });
    const stateCookie = setResponse.cookies.find(c => c.name === 'disco_oidc_state')!;
    const [payload, signature] = stateCookie.value.split('.');
    const flippedLastChar = signature.at(-1) === 'A' ? 'B' : 'A';
    const tampered = `${payload}.${signature.slice(0, -1)}${flippedLastChar}`;

    const readResponse = await app.inject({
      method: 'GET',
      url: '/read-oidc-state',
      cookies: { disco_oidc_state: tampered },
    });

    expect(readResponse.json().state).toBeNull();
  });

  it('returns null for a malformed cookie value', async () => {
    app = await buildCookieHarness();

    const readResponse = await app.inject({
      method: 'GET',
      url: '/read-oidc-state',
      cookies: { disco_oidc_state: 'this-is-not-a-signed-payload' },
    });

    expect(readResponse.json().state).toBeNull();
  });

  it('returns null when no state cookie is present', async () => {
    app = await buildCookieHarness();

    const readResponse = await app.inject({ method: 'GET', url: '/read-oidc-state' });

    expect(readResponse.json().state).toBeNull();
  });

  it('sets and clears the session cookie', async () => {
    app = await buildCookieHarness();

    const setResponse = await app.inject({ method: 'GET', url: '/set-session' });
    const sessionCookie = setResponse.cookies.find(c => c.name === 'disco_session');
    expect(sessionCookie).toMatchObject({ value: 'session-token-value', path: '/', httpOnly: true });

    const clearResponse = await app.inject({ method: 'GET', url: '/clear-session' });
    const clearedCookie = clearResponse.cookies.find(c => c.name === 'disco_session');
    expect(clearedCookie?.value).toBe('');
  });

  it('clears the OIDC state cookie', async () => {
    app = await buildCookieHarness();

    const clearResponse = await app.inject({ method: 'GET', url: '/clear-oidc-state' });
    const clearedCookie = clearResponse.cookies.find(c => c.name === 'disco_oidc_state');
    expect(clearedCookie?.value).toBe('');
    expect(clearedCookie?.path).toBe('/auth');
  });

  it.each([16, 32, 48])('randomToken(%i) decodes to the requested byte length as base64url', bytes => {
    const token = randomToken(bytes);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(token, 'base64url').length).toBe(bytes);
  });

  it('randomToken defaults to 32 bytes', () => {
    const token = randomToken();
    expect(Buffer.from(token, 'base64url').length).toBe(32);
  });
});

describe('oidc', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('caches the discovery document per issuer across calls', async () => {
    const issuer = 'https://issuer-caching.example';
    const provider = makeProvider(issuer);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(discoveryDocFor(issuer)), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await buildAuthorizationUrl(provider, 'http://api.example', 'state-1', 'nonce-1', 'verifier-1');
    await buildAuthorizationUrl(provider, 'http://api.example', 'state-2', 'nonce-2', 'verifier-2');

    const discoveryCalls = fetchMock.mock.calls.filter(([url]) => url.toString().includes('.well-known'));
    expect(discoveryCalls).toHaveLength(1);
  });

  it('builds an authorization URL with PKCE and redirect params', async () => {
    const issuer = 'https://issuer-build-url.example';
    const provider = makeProvider(issuer);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(discoveryDocFor(issuer)), { status: 200 })));

    const urlString = await buildAuthorizationUrl(provider, 'http://api.example', 'the-state', 'the-nonce', 'the-verifier');
    const url = new URL(urlString);

    expect(url.origin + url.pathname).toBe(`${issuer}/authorize`);
    expect(url.searchParams.get('client_id')).toBe('client-abc');
    expect(url.searchParams.get('redirect_uri')).toBe('http://api.example/auth/callback/test-provider');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('the-state');
    expect(url.searchParams.get('nonce')).toBe('the-nonce');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update('the-verifier').digest('base64url'));
  });

  it('throws when the token endpoint responds with a non-ok status', async () => {
    const issuer = 'https://issuer-token-nonok.example';
    const provider = makeProvider(issuer);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('.well-known')) return new Response(JSON.stringify(discoveryDocFor(issuer)), { status: 200 });
      return new Response('server error', { status: 500 });
    }));

    await expect(exchangeAndVerifyCode(provider, 'http://api.example', 'code', 'verifier', 'nonce'))
      .rejects.toThrow(/token exchange failed/i);
  });

  it('throws when the token response is missing id_token', async () => {
    const issuer = 'https://issuer-missing-idtoken.example';
    const provider = makeProvider(issuer);
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('.well-known')) return new Response(JSON.stringify(discoveryDocFor(issuer)), { status: 200 });
      return new Response(JSON.stringify({ access_token: 'abc' }), { status: 200 });
    }));

    await expect(exchangeAndVerifyCode(provider, 'http://api.example', 'code', 'verifier', 'nonce'))
      .rejects.toThrow(/did not include id_token/i);
  });

  it('throws on nonce mismatch even with a validly signed token', async () => {
    const issuer = 'https://issuer-nonce-mismatch.example';
    const provider = makeProvider(issuer);
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const kid = 'test-key-1';
    const publicJwk = await exportJWK(publicKey);
    const idToken = await signIdToken({
      issuer,
      clientId: provider.clientId,
      nonce: 'actual-nonce',
      privateKey,
      kid,
      email: 'user@example.com',
      emailVerified: true,
      name: 'Test User',
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('.well-known')) return new Response(JSON.stringify(discoveryDocFor(issuer)), { status: 200 });
      if (urlStr.endsWith('/token')) return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
      if (urlStr.endsWith('/jwks')) return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] }), { status: 200 });
      throw new Error(`unexpected fetch: ${urlStr}`);
    }));

    await expect(exchangeAndVerifyCode(provider, 'http://api.example', 'code', 'verifier', 'expected-nonce'))
      .rejects.toThrow(/nonce mismatch/i);
  });

  it('verifies a real signed id_token end-to-end and returns the identity', async () => {
    const issuer = 'https://issuer-happy.example';
    const provider = makeProvider(issuer);
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const kid = 'test-key-2';
    const publicJwk = await exportJWK(publicKey);
    const idToken = await signIdToken({
      issuer,
      clientId: provider.clientId,
      subject: 'user-subject-42',
      nonce: 'matching-nonce',
      privateKey,
      kid,
      email: 'happy@example.com',
      emailVerified: true,
      name: 'Happy User',
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('.well-known')) return new Response(JSON.stringify(discoveryDocFor(issuer)), { status: 200 });
      if (urlStr.endsWith('/token')) return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
      if (urlStr.endsWith('/jwks')) return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] }), { status: 200 });
      throw new Error(`unexpected fetch: ${urlStr}`);
    }));

    const identity = await exchangeAndVerifyCode(provider, 'http://api.example', 'code', 'verifier', 'matching-nonce');

    expect(identity).toEqual({
      issuer,
      subject: 'user-subject-42',
      email: 'happy@example.com',
      emailVerified: true,
      displayName: 'Happy User',
    });
  });
});

describe('auth routes', () => {
  let db: Database.Database | null = null;
  let app: FastifyInstance | null = null;

  afterEach(async () => {
    await app?.close();
    db?.close();
    app = null;
    db = null;
    vi.unstubAllGlobals();
  });

  it('returns 404 for /auth/login/:provider with an unknown provider', async () => {
    db = createTestDb();
    app = await buildApp(createTestConfig(), db);

    const response = await app.inject({ method: 'GET', url: '/auth/login/unknown' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'unknown_provider' });
  });

  it('redirects to the provider and sets a signed state cookie for a known provider', async () => {
    const issuer = 'https://issuer-route-login.example';
    const provider = makeProvider(issuer, { id: 'route-login-provider' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(discoveryDocFor(issuer)), { status: 200 })));
    db = createTestDb();
    app = await buildApp(createTestConfig({ oidcProviders: new Map([[provider.id, provider]]) }), db);

    const response = await app.inject({ method: 'GET', url: `/auth/login/${provider.id}` });

    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.location as string);
    expect(location.origin + location.pathname).toBe(`${issuer}/authorize`);
    const stateCookie = response.cookies.find(c => c.name === 'disco_oidc_state');
    expect(stateCookie).toBeDefined();
    expect(stateCookie!.path).toBe('/auth');
  });

  it('returns 400 for a missing or mismatched callback state', async () => {
    const issuer = 'https://issuer-route-badstate.example';
    const provider = makeProvider(issuer, { id: 'route-badstate-provider' });
    db = createTestDb();
    app = await buildApp(createTestConfig({ oidcProviders: new Map([[provider.id, provider]]) }), db);

    const missing = await app.inject({ method: 'GET', url: `/auth/callback/${provider.id}?code=abc&state=xyz` });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({ error: 'invalid_oidc_state' });

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(discoveryDocFor(issuer)), { status: 200 })));
    const login = await app.inject({ method: 'GET', url: `/auth/login/${provider.id}` });
    const stateCookie = login.cookies.find(c => c.name === 'disco_oidc_state')!;

    const mismatched = await app.inject({
      method: 'GET',
      url: `/auth/callback/${provider.id}?code=abc&state=wrong-state`,
      cookies: { disco_oidc_state: stateCookie.value },
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json()).toEqual({ error: 'invalid_oidc_state' });
  });

  it('redirects to the site with an error flag when the provider reports an error', async () => {
    db = createTestDb();
    const config = createTestConfig();
    app = await buildApp(config, db);

    const response = await app.inject({ method: 'GET', url: '/auth/callback/whatever?error=access_denied' });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe(`${config.publicSiteOrigin}/?auth=error`);
  });

  it('completes the OIDC happy path: creates an account, sets a session, and redirects to returnTo', async () => {
    const issuer = 'https://issuer-route-happy.example';
    const provider = makeProvider(issuer, { id: 'route-happy-provider' });
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const kid = 'route-happy-key';
    const publicJwk = await exportJWK(publicKey);

    db = createTestDb();
    const config = createTestConfig({ oidcProviders: new Map([[provider.id, provider]]) });
    app = await buildApp(config, db);

    let idToken = '';
    const fetchMock = vi.fn(async (url: string | URL) => {
      const urlStr = url.toString();
      if (urlStr.includes('.well-known')) return new Response(JSON.stringify(discoveryDocFor(issuer)), { status: 200 });
      if (urlStr.endsWith('/jwks')) return new Response(JSON.stringify({ keys: [{ ...publicJwk, kid, alg: 'RS256', use: 'sig' }] }), { status: 200 });
      if (urlStr.endsWith('/token')) return new Response(JSON.stringify({ id_token: idToken }), { status: 200 });
      throw new Error(`unexpected fetch: ${urlStr}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const login = await app.inject({ method: 'GET', url: `/auth/login/${provider.id}` });
    const stateCookie = login.cookies.find(c => c.name === 'disco_oidc_state')!;
    const loginLocation = new URL(login.headers.location as string);
    const state = loginLocation.searchParams.get('state')!;
    const nonce = loginLocation.searchParams.get('nonce')!;

    idToken = await signIdToken({
      issuer,
      clientId: provider.clientId,
      subject: 'route-happy-subject',
      nonce,
      privateKey,
      kid,
      email: 'route-happy@example.com',
      emailVerified: true,
      name: 'Route Happy',
    });

    const callback = await app.inject({
      method: 'GET',
      url: `/auth/callback/${provider.id}?code=some-code&state=${state}`,
      cookies: { disco_oidc_state: stateCookie.value },
    });

    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe(`${config.publicSiteOrigin}/`);
    const sessionCookie = callback.cookies.find(c => c.name === 'disco_session');
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie!.value.length).toBeGreaterThan(0);

    const me = await app.inject({ method: 'GET', url: '/me', cookies: { disco_session: sessionCookie!.value } });
    expect(me.json()).toMatchObject({
      account: { displayName: 'Route Happy' },
      identities: [
        {
          providerName: provider.id,
          issuer,
          email: 'route-happy@example.com',
          emailVerified: true,
        },
      ],
    });
  });

  it('clears the session cookie and returns ok on /auth/logout regardless of prior auth state', async () => {
    db = createTestDb();
    app = await buildApp(createTestConfig(), db);

    const withoutSession = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(withoutSession.statusCode).toBe(200);
    expect(withoutSession.json()).toEqual({ ok: true });
    const clearedCookie = withoutSession.cookies.find(c => c.name === 'disco_session');
    expect(clearedCookie?.value).toBe('');

    const repos = new Repositories(db);
    const account = repos.findOrCreateAccountForIdentity({
      issuer: 'https://issuer-logout.example',
      subject: 'logout-user',
      email: null,
      emailVerified: false,
      providerName: 'test',
      displayName: 'Logout User',
    });
    const token = 'logout-session-token';
    repos.createSession(account.id, token, new Date(Date.now() + 60_000));

    const withSession = await app.inject({ method: 'POST', url: '/auth/logout', cookies: { disco_session: token } });
    expect(withSession.statusCode).toBe(200);
    expect(withSession.json()).toEqual({ ok: true });

    const meAfter = await app.inject({ method: 'GET', url: '/me', cookies: { disco_session: token } });
    expect(meAfter.json()).toEqual({ account: null, identities: [] });
  });
});
