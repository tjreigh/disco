import { ZodError } from 'zod';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('parses a full valid env object into the expected AppConfig shape', () => {
    const env = {
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: '9000',
      DATABASE_PATH: '/data/disco.sqlite',
      PUBLIC_SITE_ORIGIN: 'https://disco.example',
      API_ORIGIN: 'https://api.disco.example',
      SESSION_SECRET: 'a'.repeat(40),
      SESSION_COOKIE_NAME: 'my_session',
      SESSION_TTL_SECONDS: '3600',
      COOKIE_SECURE: 'true',
      OIDC_PROVIDERS_JSON: JSON.stringify({
        google: {
          issuer: 'https://accounts.google.com',
          clientId: 'google-client-id',
          clientSecret: 'google-client-secret',
          scope: 'openid email profile',
        },
      }),
    } as NodeJS.ProcessEnv;

    const config = loadConfig(env);

    expect(config).toEqual({
      nodeEnv: 'production',
      host: '0.0.0.0',
      port: 9000,
      databasePath: '/data/disco.sqlite',
      publicSiteOrigin: 'https://disco.example',
      apiOrigin: 'https://api.disco.example',
      sessionSecret: 'a'.repeat(40),
      sessionCookieName: 'my_session',
      sessionTtlSeconds: 3600,
      cookieSecure: true,
      oidcProviders: new Map([
        [
          'google',
          {
            id: 'google',
            issuer: 'https://accounts.google.com',
            clientId: 'google-client-id',
            clientSecret: 'google-client-secret',
            scope: 'openid email profile',
          },
        ],
      ]),
    });
  });

  it('applies defaults for an empty env object, including an empty provider map', () => {
    const config = loadConfig({} as NodeJS.ProcessEnv);

    expect(config.nodeEnv).toBe('development');
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(8787);
    expect(config.sessionCookieName).toBe('disco_session');
    expect(config.oidcProviders.size).toBe(0);
  });

  it('falls back to single-provider env vars when OIDC_PROVIDERS_JSON is absent', () => {
    const config = loadConfig({
      OIDC_PROVIDER_ID: 'okta',
      OIDC_ISSUER: 'https://issuer.example',
      OIDC_CLIENT_ID: 'client-id',
      OIDC_CLIENT_SECRET: 'client-secret',
    } as NodeJS.ProcessEnv);

    expect(config.oidcProviders.get('okta')).toEqual({
      id: 'okta',
      issuer: 'https://issuer.example',
      clientId: 'client-id',
      clientSecret: 'client-secret',
      scope: 'openid email profile',
    });
  });

  it('infers cookieSecure from an https API_ORIGIN when COOKIE_SECURE is unset', () => {
    const secureByDefault = loadConfig({ API_ORIGIN: 'https://api.disco.example' } as NodeJS.ProcessEnv);
    const insecureByDefault = loadConfig({ API_ORIGIN: 'http://localhost:8787' } as NodeJS.ProcessEnv);
    const explicitOverride = loadConfig({
      API_ORIGIN: 'https://api.disco.example',
      COOKIE_SECURE: 'false',
    } as NodeJS.ProcessEnv);

    expect(secureByDefault.cookieSecure).toBe(true);
    expect(insecureByDefault.cookieSecure).toBe(false);
    expect(explicitOverride.cookieSecure).toBe(false);
  });

  it('throws a ZodError when a var fails its own validation (SESSION_SECRET below the minimum length)', () => {
    expect(() => loadConfig({ SESSION_SECRET: 'too-short' } as NodeJS.ProcessEnv)).toThrow(ZodError);
  });

  it('throws a ZodError when PUBLIC_SITE_ORIGIN is not a valid URL', () => {
    expect(() => loadConfig({ PUBLIC_SITE_ORIGIN: 'not-a-url' } as NodeJS.ProcessEnv)).toThrow(ZodError);
  });

  it('throws a ZodError for invalid OIDC_PROVIDERS_JSON (fails the provider shape schema)', () => {
    const invalidJson = JSON.stringify({
      google: {
        issuer: 'not-a-valid-url',
        // missing required clientId/clientSecret
      },
    });

    expect(() => loadConfig({ OIDC_PROVIDERS_JSON: invalidJson } as NodeJS.ProcessEnv)).toThrow(ZodError);
  });
});
