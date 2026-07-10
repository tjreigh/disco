import { z } from 'zod';

export interface OidcProviderConfig {
  id: string;
  issuer: string;
  clientId: string;
  clientSecret: string;
  scope: string;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  databasePath: string;
  publicSiteOrigin: string;
  apiOrigin: string;
  sessionSecret: string;
  sessionCookieName: string;
  sessionTtlSeconds: number;
  cookieSecure: boolean;
  oidcProviders: ReadonlyMap<string, OidcProviderConfig>;
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_PATH: z.string().default('./data/disco.sqlite'),
  PUBLIC_SITE_ORIGIN: z.string().url().default('http://localhost:3000'),
  API_ORIGIN: z.string().url().default('http://localhost:8787'),
  SESSION_SECRET: z.string().min(32).default('development-session-secret-change-before-production'),
  SESSION_COOKIE_NAME: z.string().min(1).default('disco_session'),
  SESSION_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  OIDC_PROVIDERS_JSON: z.string().optional(),
  OIDC_PROVIDER_ID: z.string().default('google'),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
  OIDC_SCOPE: z.string().default('openid email profile'),
});

const providerJsonSchema = z.record(
  z.object({
    issuer: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    scope: z.string().default('openid email profile'),
  }),
);

function parseProviders(env: z.infer<typeof envSchema>): ReadonlyMap<string, OidcProviderConfig> {
  const providers = new Map<string, OidcProviderConfig>();

  if (env.OIDC_PROVIDERS_JSON) {
    const parsed = providerJsonSchema.parse(JSON.parse(env.OIDC_PROVIDERS_JSON));
    for (const [id, provider] of Object.entries(parsed)) {
      providers.set(id, { id, ...provider });
    }
    return providers;
  }

  if (env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET) {
    providers.set(env.OIDC_PROVIDER_ID, {
      id: env.OIDC_PROVIDER_ID,
      issuer: env.OIDC_ISSUER,
      clientId: env.OIDC_CLIENT_ID,
      clientSecret: env.OIDC_CLIENT_SECRET,
      scope: env.OIDC_SCOPE,
    });
  }

  return providers;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const env = envSchema.parse(source);
  const cookieSecure = env.COOKIE_SECURE === undefined
    ? env.API_ORIGIN.startsWith('https://')
    : env.COOKIE_SECURE === 'true';

  return {
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    databasePath: env.DATABASE_PATH,
    publicSiteOrigin: env.PUBLIC_SITE_ORIGIN,
    apiOrigin: env.API_ORIGIN,
    sessionSecret: env.SESSION_SECRET,
    sessionCookieName: env.SESSION_COOKIE_NAME,
    sessionTtlSeconds: env.SESSION_TTL_SECONDS,
    cookieSecure,
    oidcProviders: parseProviders(env),
  };
}
