#!/usr/bin/env bash
set -euo pipefail

SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

ORIGIN="$TMP_DIR/origin.git"
SEED="$TMP_DIR/seed"
CONTROL="$TMP_DIR/control"
FAKE_BIN="$TMP_DIR/bin"
STATE="$TMP_DIR/state"
ENV_FILE="$TMP_DIR/api.env"

mkdir -p "$SEED/api/deploy" "$FAKE_BIN" "$STATE"

cp "$SOURCE_DIR/auto-deploy.sh" "$SEED/api/deploy/auto-deploy.sh"
cp "$SOURCE_DIR/backup-sqlite.sh" "$SEED/api/deploy/backup-sqlite.sh"
cp "$SOURCE_DIR/smoke-test.sh" "$SEED/api/deploy/smoke-test.sh"
chmod +x "$SEED/api/deploy/"*.sh
printf '{"name":"deploy-fixture","private":true}\n' > "$SEED/api/package.json"

cat > "$FAKE_BIN/yarn" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "build" && -f "$TEST_STATE/fail-build" ]]; then
  exit 1
fi
exit 0
EOF

cat > "$FAKE_BIN/node" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$FAKE_BIN/curl" <<'EOF'
#!/usr/bin/env bash
if [[ -f "$TEST_STATE/fail-smoke" ]]; then
  remaining="$(cat "$TEST_STATE/fail-smoke")"
  if ((remaining > 0)); then
    printf '%s\n' "$((remaining - 1))" > "$TEST_STATE/fail-smoke"
    exit 22
  fi
fi
printf '{"ok":true,"account":null,"entries":[]}\n'
EOF

cat > "$FAKE_BIN/sudo" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$FAKE_BIN/sqlite3" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$FAKE_BIN/gzip" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$FAKE_BIN/flock" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

# Production is Linux and uses GNU mv -T for atomic symlink replacement.
# Translate that one invocation for the macOS integration-test host.
cat > "$FAKE_BIN/mv" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-Tf" ]]; then
  /bin/rm -f "$3"
  exec /bin/mv "$2" "$3"
fi
exec /bin/mv "$@"
EOF

chmod +x "$FAKE_BIN/"*

git init --quiet --bare "$ORIGIN"
git -C "$ORIGIN" symbolic-ref HEAD refs/heads/main
git -C "$SEED" init --quiet -b main
git -C "$SEED" config user.name "Deploy Test"
git -C "$SEED" config user.email "deploy-test@example.invalid"
git -C "$SEED" add .
git -C "$SEED" commit --quiet -m "initial api"
git -C "$SEED" remote add origin "$ORIGIN"
git -C "$SEED" push --quiet -u origin main
git clone --quiet --branch main "$ORIGIN" "$CONTROL"

cat > "$ENV_FILE" <<EOF
API_ORIGIN=https://api.example.invalid
DATABASE_PATH=$STATE/disco.sqlite
EOF

run_deploy() {
  PATH="$FAKE_BIN:$PATH" \
  TEST_STATE="$STATE" \
  LOCK_FILE="$STATE/deploy.lock" \
  STATE_FILE="$STATE/success.sha" \
  RELEASES_DIR="$STATE/releases" \
  CURRENT_LINK="$STATE/current" \
  BACKUP_DIR="$STATE/backups" \
  SYSTEMCTL=/bin/true \
  SMOKE_ATTEMPTS=2 \
  SMOKE_RETRY_DELAY=0 \
  bash "$SOURCE_DIR/auto-deploy.sh" "$CONTROL" "$ENV_FILE"
}

assert_equal() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $message (expected '$expected', got '$actual')" >&2
    exit 1
  fi
}

sha1="$(git -C "$SEED" rev-parse HEAD)"
run_deploy
assert_equal "$sha1" "$(cat "$STATE/success.sha")" "initial deployment marker"
[[ -d "$(readlink -f "$STATE/current")" ]] || {
  echo "FAIL: initial release symlink is invalid" >&2
  exit 1
}

printf 'local drift\n' > "$CONTROL/untracked.txt"
if run_deploy; then
  echo "FAIL: dirty control checkout unexpectedly succeeded" >&2
  exit 1
fi
assert_equal "$sha1" "$(cat "$STATE/success.sha")" "dirty checkout must not advance marker"
rm "$CONTROL/untracked.txt"

printf 'api change 2\n' > "$SEED/api/change-2.txt"
git -C "$SEED" add api/change-2.txt
git -C "$SEED" commit --quiet -m "api change 2"
git -C "$SEED" push --quiet
sha2="$(git -C "$SEED" rev-parse HEAD)"

touch "$STATE/fail-build"
if run_deploy; then
  echo "FAIL: build failure unexpectedly succeeded" >&2
  exit 1
fi
assert_equal "$sha1" "$(cat "$STATE/success.sha")" "failed build must not advance marker"

rm "$STATE/fail-build"
run_deploy
assert_equal "$sha2" "$(cat "$STATE/success.sha")" "same target must retry after build failure"

previous_release="$(readlink -f "$STATE/current")"
printf 'api change 3\n' > "$SEED/api/change-3.txt"
git -C "$SEED" add api/change-3.txt
git -C "$SEED" commit --quiet -m "api change 3"
git -C "$SEED" push --quiet
sha3="$(git -C "$SEED" rev-parse HEAD)"

printf '2\n' > "$STATE/fail-smoke"
if run_deploy; then
  echo "FAIL: smoke failure unexpectedly succeeded" >&2
  exit 1
fi
assert_equal "$sha2" "$(cat "$STATE/success.sha")" "failed smoke test must not advance marker"
assert_equal "$previous_release" "$(readlink -f "$STATE/current")" "failed smoke test must restore previous release"

rm "$STATE/fail-smoke"
run_deploy
assert_equal "$sha3" "$(cat "$STATE/success.sha")" "same target must retry after smoke failure"

active_release="$(readlink -f "$STATE/current")"
printf 'frontend only\n' > "$SEED/README.md"
git -C "$SEED" add README.md
git -C "$SEED" commit --quiet -m "frontend only"
git -C "$SEED" push --quiet
sha4="$(git -C "$SEED" rev-parse HEAD)"

run_deploy
assert_equal "$sha4" "$(cat "$STATE/success.sha")" "frontend-only marker"
assert_equal "$active_release" "$(readlink -f "$STATE/current")" "frontend-only commit must not activate a release"

echo "auto-deploy integration test passed"
