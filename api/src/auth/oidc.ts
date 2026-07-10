import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { OidcProviderConfig } from '../config.js';

interface DiscoveryDocument {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
}

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email: string | null;
  emailVerified: boolean;
  displayName: string | null;
}

const discoveryCache = new Map<string, DiscoveryDocument>();

function calculatePkceCodeChallenge(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

async function discover(provider: OidcProviderConfig): Promise<DiscoveryDocument> {
  const cached = discoveryCache.get(provider.issuer);
  if (cached) return cached;

  const response = await fetch(new URL('/.well-known/openid-configuration', provider.issuer));
  if (!response.ok) {
    throw new Error(`OIDC discovery failed for ${provider.id}: ${response.status}`);
  }
  const discovery = await response.json() as DiscoveryDocument;
  discoveryCache.set(provider.issuer, discovery);
  return discovery;
}

export async function buildAuthorizationUrl(
  provider: OidcProviderConfig,
  apiOrigin: string,
  state: string,
  nonce: string,
  codeVerifier: string,
): Promise<string> {
  const discovery = await discover(provider);
  const challenge = calculatePkceCodeChallenge(codeVerifier);
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('client_id', provider.clientId);
  url.searchParams.set('redirect_uri', `${apiOrigin}/auth/callback/${provider.id}`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', provider.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

export async function exchangeAndVerifyCode(
  provider: OidcProviderConfig,
  apiOrigin: string,
  code: string,
  codeVerifier: string,
  nonce: string,
): Promise<VerifiedIdentity> {
  const discovery = await discover(provider);
  const tokenResponse = await fetch(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      redirect_uri: `${apiOrigin}/auth/callback/${provider.id}`,
      code,
      code_verifier: codeVerifier,
    }),
  });

  if (!tokenResponse.ok) {
    throw new Error(`OIDC token exchange failed for ${provider.id}: ${tokenResponse.status}`);
  }

  const tokenSet = await tokenResponse.json() as { id_token?: string };
  if (!tokenSet.id_token) throw new Error(`OIDC response for ${provider.id} did not include id_token`);

  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  const verified = await jwtVerify(tokenSet.id_token, jwks, {
    issuer: discovery.issuer,
    audience: provider.clientId,
  });

  if (verified.payload.nonce !== nonce) {
    throw new Error('OIDC nonce mismatch');
  }

  return {
    issuer: String(verified.payload.iss),
    subject: String(verified.payload.sub),
    email: typeof verified.payload.email === 'string' ? verified.payload.email : null,
    emailVerified: verified.payload.email_verified === true,
    displayName: typeof verified.payload.name === 'string' ? verified.payload.name : null,
  };
}
