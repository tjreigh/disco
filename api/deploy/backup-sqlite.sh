#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${1:-/etc/disco/disco-api.env}"
BACKUP_DIR="${2:-/var/backups/disco}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "missing env file: $ENV_FILE" >&2
  exit 1
fi

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required" >&2
  exit 1
fi

set -a
. "$ENV_FILE"
set +a

if [[ -z "${DATABASE_PATH:-}" ]]; then
  echo "DATABASE_PATH is not set" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

timestamp="$(date +%Y%m%d-%H%M%S)"
backup_file="$BACKUP_DIR/disco-$timestamp.sqlite"

sqlite3 "$DATABASE_PATH" ".backup '$backup_file'"
gzip -f "$backup_file"

find "$BACKUP_DIR" -type f -name 'disco-*.sqlite.gz' -mtime +14 -delete

echo "backup written to $backup_file.gz"
