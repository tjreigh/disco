#!/usr/bin/env bash
set -euo pipefail

base_url="${1:-}"

if [[ -z "$base_url" ]]; then
  echo "usage: $0 https://api.example.com" >&2
  exit 1
fi

check() {
  local path="$1"
  local expected="$2"
  local body

  body="$(curl --fail --silent --show-error "$base_url$path")"
  if [[ "$body" != *"$expected"* ]]; then
    echo "unexpected response for $path: $body" >&2
    exit 1
  fi

  echo "ok $path"
}

check "/health" '"ok":true'
check "/me" '"account":null'
check "/leaderboards/classic?limit=1" '"entries"'
