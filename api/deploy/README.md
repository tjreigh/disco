# VPS deployment

This API is independent from the root Cloudflare Pages app. Deploy it from `api/` on a VPS and keep the SQLite database outside the repo.

## Assumptions

- app code checked out at `/srv/disco`
- API working directory is `/srv/disco/api`
- auto-deployed release entrypoint is `/var/lib/disco/current/api/dist/server.js`
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
sudo chmod 750 /var/backups/disco
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

Backups are created with mode `0600`; the backup directory should be `0750`.
Harden any backups created before this permission policy was installed:

```bash
sudo chmod 750 /var/backups/disco
sudo find /var/backups/disco -type f -name 'disco-*.sqlite.gz' -exec chmod 600 {} +
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

## 9. Automate redeploys with polling

`auto-deploy.sh` polls `origin/main` on a timer. API commits are built in an
isolated Git worktree under `/var/lib/disco/releases`; a successful build is
activated through the `/var/lib/disco/current` symlink and then restarted and
smoke-tested. Frontend-only commits advance the successful-run marker without
rebuilding or restarting the API. This never deploys Cloudflare Pages.

The script records the last successfully processed commit in
`/var/lib/disco/auto-deploy-success.sha`. That marker is deliberately separate
from `/srv/disco`'s checked-out `HEAD`: a failed build, migration, restart, or
smoke test leaves the marker unchanged, so the next timer run retries the same
target instead of incorrectly reporting that it is up to date.

One-time prerequisite: the timer's `disco` process must be able to `git fetch`
non-interactively. The unit uses `HOME=/var/lib/disco` so package-manager caches
cannot dirty the control checkout. Either add a read-only GitHub deploy key at
`/var/lib/disco/.ssh/`, or (if the repo is public) point the checkout's remote
at HTTPS instead of SSH:

```bash
git remote set-url origin https://github.com/tjreigh/disco.git
```

The host also needs Bash, Git, Yarn, Node, curl, SQLite, gzip, and `flock`
(normally supplied by `util-linux`).

The release build intentionally runs `yarn install --production=false` even though
the environment file sets `NODE_ENV=production`. Yarn Classic otherwise treats
`NODE_ENV=production` as an instruction to omit `devDependencies`, including the
TypeScript compiler required by `yarn build`. The flag controls build-time
dependency installation only; systemd still starts the compiled API with
`NODE_ENV=production`.

The restart step needs `disco` to have passwordless sudo for exactly
`systemctl restart disco-api`. Check first:

```bash
sudo -l -U disco
```

If it is missing, grant exactly that command and nothing broader:

```bash
sudo visudo -f /etc/sudoers.d/disco-api-restart
```

```
disco ALL=(root) NOPASSWD: /usr/bin/systemctl restart disco-api
```

Install the release-aware API unit and timer. Copying the API unit does not
interrupt the currently running process; the first auto-deploy creates the
`current` symlink before restarting it with the new release entrypoint. The
service keeps `/srv/disco/api` as its working directory so relative-path and
operations assumptions remain compatible with the manual setup.

```bash
sudo cp disco-api-release.service.example /etc/systemd/system/disco-api.service
sudo cp disco-api-auto-deploy.service.example /etc/systemd/system/disco-api-auto-deploy.service
sudo cp disco-api-auto-deploy.timer.example /etc/systemd/system/disco-api-auto-deploy.timer
sudo systemctl daemon-reload
sudo systemctl start disco-api-auto-deploy.service
sudo systemctl enable --now disco-api-auto-deploy.timer
```

Check that the initial release succeeded before relying on the timer:

```bash
systemctl status disco-api-auto-deploy.service
readlink -f /var/lib/disco/current
cat /var/lib/disco/auto-deploy-success.sha
```

Check status and logs:

```bash
systemctl status disco-api-auto-deploy.timer
journalctl -u disco-api-auto-deploy.service -n 100
```

### Failure and rollback behavior

Before doing any deployment work, the script validates the environment file,
`API_ORIGIN`, an absolute `DATABASE_PATH`, required commands, the narrow sudo
grant, and a completely clean control checkout (including untracked files).

- Install or build failure: the active release is untouched.
- Migration failure: the active code release is untouched and the successful
  marker is not advanced. A compressed SQLite backup is taken immediately
  before migration when the database already exists.
- Restart or smoke-test failure: when a previous release exists, the `current`
  symlink is switched back and that code is restarted and smoke-tested.
- Any failure leaves the successful marker unchanged, so the timer retries.

Database migrations are not automatically reversed during a code rollback.
Doing so could erase writes accepted after restart. Production migrations must
therefore be backward-compatible with the immediately previous API release
(the expand/contract pattern). The pre-migration backup in
`/var/backups/disco` is for deliberate operator recovery, not automatic
rollback.

If the initial release has no previous code to restore, or both the candidate
and rollback release fail smoke testing, the unit exits nonzero and requires
manual recovery. Inspect the journal and `/var/lib/disco/current`; after fixing
the problem, starting `disco-api-auto-deploy.service` retries because the
successful marker was not advanced.

At most the active and immediately previous Git worktrees are retained after a
successful deployment. Failed candidates that were never activated are
removed automatically.

## Notes

- Keep the repo checkout and the SQLite database on separate paths.
- Keep `SESSION_SECRET` and OIDC client secrets out of git.
- This deployment path does not touch the root Pages build or root `wrangler` configuration.
- `/srv/disco` is the clean control checkout, not the running release: never
  commit, add untracked files, or hand-edit files there. `auto-deploy.sh`
  refuses a dirty checkout and resets a clean one to `origin/main`.
- `/var/lib/disco/current` is managed by `auto-deploy.sh`; do not repoint it by
  hand except during documented manual recovery.
