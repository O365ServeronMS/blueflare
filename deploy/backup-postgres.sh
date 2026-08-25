#!/usr/bin/env bash
# Take one backup right now, outside the backup container's schedule.
#
# Thin wrapper on purpose: the dump/verify/upload/prune logic lives in
# deploy/backup/backup.sh and runs in the backup service, so there is one
# implementation rather than a scheduled one and a manual one that drift.
#
# BACKUP_ENABLED is forced on for this run, so an ad-hoc backup works even
# while the scheduled service is switched off.
#
# Usage: deploy/backup-postgres.sh
set -euo pipefail

STACK_DIR=${BLUEFLARE_STACK_DIR:-/opt/stacks/blueflare}
COMPOSE_FILE=${BLUEFLARE_COMPOSE_FILE:-$STACK_DIR/compose.yml}

exec docker compose --env-file "$STACK_DIR/.env" -f "$COMPOSE_FILE" \
  run --rm --env BACKUP_ENABLED=true backup --once
