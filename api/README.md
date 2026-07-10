# Disco API

Fastify + SQLite API for account, auth, stats, and leaderboard endpoints used by the static Pages game.

## Local development

```bash
cd api
yarn install
yarn migrate
yarn dev
```

The API defaults to `http://127.0.0.1:8787` and uses `./data/disco.sqlite` unless overridden with environment variables.

`api/yarn.lock` is intentionally committed even though the root repo ignores
lockfiles by default. The API is a deployable Node service, so the lockfile
keeps VPS installs aligned with the dependency graph tested locally. Installed
modules, build output, and local SQLite data remain ignored.

## VPS deployment

Deployment examples live in [api/deploy/README.md](./deploy/README.md). They assume:

- the static site remains deployed separately on Cloudflare Pages
- the API runs as a standalone Node service on a VPS
- SQLite lives outside the repo, for example `/var/lib/disco/disco.sqlite`
