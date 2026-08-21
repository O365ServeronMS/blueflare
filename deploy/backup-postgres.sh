#!/usr/bin/env bash
set -euo pipefail

STACK_DIR=${BLUEFLARE_STACK_DIR:-/opt/stacks/blueflare}
BACKUP_DIR=${BLUEFLARE_BACKUP_DIR:-/opt/docker/backups/blueflare/postgres}
COMPOSE_FILE=${BLUEFLARE_COMPOSE_FILE:-$STACK_DIR/compose.yml}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
TARGET="$BACKUP_DIR/blueflare-$STAMP.dump"
TEMPORARY="$TARGET.tmp"

umask 077
install -d -m 700 "$BACKUP_DIR"

docker compose --env-file "$STACK_DIR/.env" -f "$COMPOSE_FILE" \
  exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$TEMPORARY"

docker compose --env-file "$STACK_DIR/.env" -f "$COMPOSE_FILE" \
  exec -T postgres pg_restore --list < "$TEMPORARY" >/dev/null
mv "$TEMPORARY" "$TARGET"
printf '%s\n' "$TARGET"
