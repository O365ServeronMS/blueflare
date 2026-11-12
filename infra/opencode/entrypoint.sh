#!/bin/sh
# Imports the opencode login exported on the host (`opencode auth export opencode`)
# into the container's own store, then serves. Re-imports only when the file
# changes, so a token the container refreshed itself is not overwritten on restart.
set -eu

: "${OPENCODE_SERVER_PASSWORD:?OPENCODE_SERVER_PASSWORD must be set (the worker uses the same value)}"
CRED=${OPENCODE_CREDENTIALS:-/run/opencode/credentials.json}
MARK=$HOME/.credentials.sha256

if [ -r "$CRED" ] && [ -s "$CRED" ]; then
  sum=$(sha256sum "$CRED" | cut -d' ' -f1)
  if [ "$(cat "$MARK" 2>/dev/null || true)" != "$sum" ]; then
    if opencode auth import --standalone "$CRED" >/dev/null 2>&1; then
      printf '%s\n' "$sum" >"$MARK"
      echo "opencode-entrypoint: imported credentials from $CRED"
    else
      echo "opencode-entrypoint: WARNING could not import $CRED; serving with the stored login" >&2
    fi
  fi
else
  echo "opencode-entrypoint: no readable $CRED; serving with the stored login (free models may refuse)" >&2
fi

exec opencode serve --hostname 0.0.0.0 --port 4096
