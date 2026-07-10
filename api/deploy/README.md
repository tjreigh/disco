# VPS deployment

This API is independent from the root Cloudflare Pages app. Deploy it from `api/` on a VPS and keep the SQLite database outside the repo.

## Assumptions

- app code checked out at `/srv/disco`
- API working directory is `/srv/disco/api`
- runtime user is `disco`
- external API origin is `https://api.example.com`
- static site origin is `https://disco.example.com`
- SQLite file is `/var/lib/disco/disco.sqlite`

## 1. Install runtime dependencies

Install current Node LTS, `sqlite3`, and Caddy on the VPS.

```bash
sudo mkdir -p /srv/disco /etc/disco /var/lib/disco /var/backups/disco
sudo useradd --system --home /srv/disco --shell /usr/sbin/nologin disco || true
sudo chown -R disco:disco /srv/disco /var/lib/disco /var/backups/disco
```

## 2. Build the API

```bash
cd /srv/disco/api
yarn install --frozen-lockfile
yarn build
```

## 3. Create the production env file

Start from [`.env.production.example`](./.env.production.example) and write the real values to `/etc/disco/disco-api.env`.

```bash
sudo install -m 640 -o root -g disco /dev/null /etc/disco/disco-api.env
sudo editor /etc/disco/disco-api.env
```

Minimum production variables:

- `NODE_ENV=production`
- `HOST=127.0.0.1`
- `PORT=8787`
- `DATABASE_PATH=/var/lib/disco/disco.sqlite`
- `PUBLIC_SITE_ORIGIN=https://disco.example.com`
- `API_ORIGIN=https://api.example.com`
- `SESSION_SECRET=` a random string with at least 32 characters
- OIDC provider values if login is enabled

## 4. Run migrations

Use the built migration entrypoint:

```bash
cd /srv/disco/api
set -a
. /etc/disco/disco-api.env
set +a
node dist/db/migrate.js
```

`dist/server.js` also runs migrations on boot, but running them explicitly before restart keeps deployment failures obvious.

## 5. Start the service with systemd

Copy [disco-api.service.example](./disco-api.service.example) to `/etc/systemd/system/disco-api.service`, then enable it:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now disco-api
sudo systemctl status disco-api
```

Useful restart flow after a deploy:

```bash
cd /srv/disco/api
yarn install --frozen-lockfile
yarn build
set -a
. /etc/disco/disco-api.env
set +a
node dist/db/migrate.js
sudo systemctl restart disco-api
```

## 6. Put Caddy in front of the API

Copy [Caddyfile.example](./Caddyfile.example) into your Caddy config, replace the host names, then reload:

```bash
sudo systemctl reload caddy
```

The API binds only to `127.0.0.1:8787`; Caddy terminates TLS and forwards requests locally.

## 7. Back up SQLite

Use [backup-sqlite.sh](./backup-sqlite.sh) on the VPS:

```bash
sudo install -m 750 -o root -g disco ./backup-sqlite.sh /usr/local/bin/disco-backup-sqlite
sudo /usr/local/bin/disco-backup-sqlite /etc/disco/disco-api.env /var/backups/disco
```

Suggested nightly cron entry:

```cron
15 3 * * * root /usr/local/bin/disco-backup-sqlite /etc/disco/disco-api.env /var/backups/disco
```

Restore example:

```bash
sudo systemctl stop disco-api
sudo gunzip -c /var/backups/disco/disco-20260102-031500.sqlite.gz > /var/lib/disco/disco.sqlite
sudo chown disco:disco /var/lib/disco/disco.sqlite
sudo systemctl start disco-api
```

## 8. Smoke test after deploy

Run [smoke-test.sh](./smoke-test.sh) from the VPS or any machine that can reach the API:

```bash
./smoke-test.sh https://api.example.com
```

It checks:

- `GET /health`
- `GET /me`
- `GET /leaderboards/classic?limit=1`

## Notes

- Keep the repo checkout and the SQLite database on separate paths.
- Keep `SESSION_SECRET` and OIDC client secrets out of git.
- This deployment path does not touch the root Pages build or root `wrangler` configuration.
