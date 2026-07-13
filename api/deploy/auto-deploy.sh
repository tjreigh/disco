#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${1:-/srv/disco}"
ENV_FILE="${2:-/etc/disco/disco-api.env}"
BRANCH="${BRANCH:-main}"
LOCK_FILE="${LOCK_FILE:-/var/lib/disco/auto-deploy.lock}"
STATE_FILE="${STATE_FILE:-/var/lib/disco/auto-deploy-success.sha}"
RELEASES_DIR="${RELEASES_DIR:-/var/lib/disco/releases}"
CURRENT_LINK="${CURRENT_LINK:-/var/lib/disco/current}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/disco}"
SYSTEMCTL="${SYSTEMCTL:-/usr/bin/systemctl}"
SERVICE="${SERVICE:-disco-api}"
SMOKE_ATTEMPTS="${SMOKE_ATTEMPTS:-5}"
SMOKE_RETRY_DELAY="${SMOKE_RETRY_DELAY:-2}"

log() {
  echo "[auto-deploy] $*"
}

fail() {
  echo "[auto-deploy] $*" >&2
  exit 1
}

write_success_sha() {
  local sha="$1"
  local temporary="${STATE_FILE}.tmp"
  printf '%s\n' "$sha" > "$temporary"
  mv -f "$temporary" "$STATE_FILE"
}

activate_release() {
  local release="$1"
  local temporary="${CURRENT_LINK}.next"
  ln -sfn "$release" "$temporary"
  mv -Tf "$temporary" "$CURRENT_LINK"
}

smoke_test() {
  local attempt
  for ((attempt = 1; attempt <= SMOKE_ATTEMPTS; attempt++)); do
    if "$CURRENT_LINK/api/deploy/smoke-test.sh" "$API_ORIGIN"; then
      return 0
    fi
    log "smoke test attempt $attempt failed; retrying"
    sleep "$SMOKE_RETRY_DELAY"
  done
  return 1
}

for command in flock git yarn node curl sudo sqlite3 gzip sed tr dirname ln mv readlink; do
  command -v "$command" >/dev/null 2>&1 || fail "required command not found: $command"
done

[[ -d "$REPO_DIR/.git" ]] || fail "not a Git checkout: $REPO_DIR"
[[ -r "$ENV_FILE" ]] || fail "environment file is not readable: $ENV_FILE"

set -a
. "$ENV_FILE"
set +a

[[ -n "${API_ORIGIN:-}" ]] || fail "API_ORIGIN is not set in $ENV_FILE"
[[ -n "${DATABASE_PATH:-}" ]] || fail "DATABASE_PATH is not set in $ENV_FILE"
[[ "$DATABASE_PATH" == /* ]] || fail "DATABASE_PATH must be absolute for auto-deploy: $DATABASE_PATH"
sudo -n -l "$SYSTEMCTL" restart "$SERVICE" >/dev/null 2>&1 \
  || fail "passwordless sudo is not configured for: $SYSTEMCTL restart $SERVICE"

mkdir -p "$(dirname "$LOCK_FILE")" "$RELEASES_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "deploy already in progress, skipping this run"
  exit 0
fi

cd "$REPO_DIR"

# This checkout is a deploy target, never a workspace — refuse to run over
# unexpected local changes instead of clobbering them with reset --hard.
if [[ -n "$(git status --porcelain --untracked-files=all)" ]]; then
  fail "tracked or untracked local changes found in $REPO_DIR; refusing to auto-deploy"
fi

git fetch --quiet origin
target_sha="$(git rev-parse "origin/$BRANCH")"
successful_sha=""

if [[ -f "$STATE_FILE" ]]; then
  successful_sha="$(tr -d '[:space:]' < "$STATE_FILE")"
  [[ -n "$successful_sha" ]] || fail "success marker is empty: $STATE_FILE"
  git cat-file -e "${successful_sha}^{commit}" 2>/dev/null \
    || fail "success marker $successful_sha is not available in the checkout"
fi

if [[ "$successful_sha" == "$target_sha" ]]; then
  log "up to date ($target_sha)"
  exit 0
fi

if [[ -n "$successful_sha" ]]; then
  log "new commits since last successful run: $successful_sha -> $target_sha"
else
  log "no successful deployment marker; preparing initial release $target_sha"
fi

api_changed=1
if [[ -n "$successful_sha" ]]; then
  git diff --quiet "$successful_sha" "$target_sha" -- api/ && api_changed=0 || true
fi

# Move the checkout regardless of whether api/ changed, so the next run's
# scripts and documentation match origin. Deployment retry state is tracked by
# STATE_FILE, not by this mutable checkout's HEAD.
git reset --hard "$target_sha"

if [[ "$api_changed" -eq 0 ]]; then
  write_success_sha "$target_sha"
  log "api/ unchanged; advanced successful-run marker without restarting"
  exit 0
fi

candidate="$RELEASES_DIR/${target_sha}-$$"
candidate_active=0

cleanup_candidate() {
  if [[ -n "${candidate:-}" && "$candidate_active" -eq 0 && -d "$candidate" ]]; then
    git -C "$REPO_DIR" worktree remove --force "$candidate" >/dev/null 2>&1 || true
  fi
}
trap cleanup_candidate EXIT

log "building isolated release $candidate"
git worktree add --quiet --detach "$candidate" "$target_sha"
cd "$candidate/api"

yarn install --frozen-lockfile --production=false || {
  fail "yarn install failed for $target_sha; active release was not changed"
}

yarn build || {
  fail "yarn build failed for $target_sha; active release was not changed"
}

if [[ -f "$DATABASE_PATH" ]]; then
  "$candidate/api/deploy/backup-sqlite.sh" "$ENV_FILE" "$BACKUP_DIR" \
    || fail "database backup failed; migration was not attempted"
else
  log "database does not exist yet; skipping pre-migration backup"
fi

node dist/db/migrate.js || {
  fail "migrations failed for $target_sha; active release was not changed"
}

previous_release=""
if [[ -L "$CURRENT_LINK" ]]; then
  previous_release="$(readlink -f "$CURRENT_LINK")"
elif [[ -e "$CURRENT_LINK" ]]; then
  fail "$CURRENT_LINK exists but is not a symlink"
fi

activate_release "$candidate"
candidate_active=1

if ! sudo -n "$SYSTEMCTL" restart "$SERVICE"; then
  if [[ -n "$previous_release" && -d "$previous_release" ]]; then
    log "restart failed; restoring previous release $previous_release"
    activate_release "$previous_release"
    candidate_active=0
    sudo -n "$SYSTEMCTL" restart "$SERVICE" \
      || fail "restart and rollback restart both failed; manual recovery required"
  fi
  fail "restart failed for $target_sha; successful deployment marker was not advanced"
fi

if ! smoke_test; then
  if [[ -n "$previous_release" && -d "$previous_release" ]]; then
    log "smoke test failed; rolling code back to $previous_release"
    activate_release "$previous_release"
    candidate_active=0
    sudo -n "$SYSTEMCTL" restart "$SERVICE" \
      || fail "smoke test failed and rollback restart failed; manual recovery required"
    smoke_test || fail "candidate and restored release both failed smoke testing; manual recovery required"
    fail "smoke test failed for $target_sha; previous code release restored (database migration remains applied)"
  fi
  fail "smoke test failed for initial release $target_sha; no previous code release exists to restore"
fi

write_success_sha "$target_sha"
log "deployed $target_sha successfully"

# Keep the active and immediately previous releases for rollback; remove older
# Git worktrees so API deployments do not grow storage without bound.
while IFS= read -r worktree; do
  case "$worktree" in
    "$REPO_DIR"|"$candidate"|"$previous_release") continue ;;
    "$RELEASES_DIR"/*)
      git -C "$REPO_DIR" worktree remove --force "$worktree" >/dev/null 2>&1 || true
      ;;
  esac
done < <(git -C "$REPO_DIR" worktree list --porcelain | sed -n 's/^worktree //p')
git -C "$REPO_DIR" worktree prune

exit 0
