#!/usr/bin/env bash
# Blueflare offsite backup.
#
# Dumps PostgreSQL, proves the dump is readable, mirrors it to any
# S3-compatible object store, and prunes old copies on both ends.
#
# The target is deliberately generic rather than R2-specific: R2, Backblaze B2,
# Wasabi, MinIO and AWS S3 all differ only in endpoint and region, so switching
# provider is an env change, not a code change.
#
#   BACKUP_S3_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com   BACKUP_S3_REGION=auto
#   BACKUP_S3_ENDPOINT=https://s3.us-west-004.backblazeb2.com          BACKUP_S3_REGION=us-west-004
#   BACKUP_S3_ENDPOINT=https://s3.eu-central-1.amazonaws.com           BACKUP_S3_REGION=eu-central-1
#
# The dump stays local as well: restoring from disk is faster, and the object
# store can be unreachable exactly when it is needed.
#
# Usage: backup.sh [--once]
set -euo pipefail

ENABLED=${BACKUP_ENABLED:-false}
INTERVAL=${BACKUP_INTERVAL_SECONDS:-86400}
START_DELAY=${BACKUP_START_DELAY_SECONDS:-300}
DIRECTORY=${BACKUP_DIR:-/backups}
KEEP_LOCAL=${BACKUP_KEEP_LOCAL:-3}
KEEP_REMOTE=${BACKUP_KEEP_REMOTE:-14}
PREFIX=${BACKUP_S3_PREFIX:-postgres/}
REGION=${BACKUP_S3_REGION:-auto}
ONCE=${1:-}

EMPTY_SHA=e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855

log() { printf '[backup] %s\n' "$*"; }
fail() { printf '[backup] %s\n' "$*" >&2; }

if [[ "$ENABLED" != "true" && "$ENABLED" != "1" ]]; then
  # Exiting 0 with `restart: on-failure` leaves the container stopped instead
  # of restart-looping, which is the honest representation of "turned off".
  log "BACKUP_ENABLED=$ENABLED; nothing to do"
  exit 0
fi

for required in POSTGRES_USER POSTGRES_PASSWORD POSTGRES_DB \
                BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET \
                BACKUP_S3_ACCESS_KEY_ID BACKUP_S3_SECRET_ACCESS_KEY; do
  if [[ -z "${!required:-}" ]]; then
    fail "$required is required when BACKUP_ENABLED=true"
    exit 1
  fi
done

ENDPOINT=${BACKUP_S3_ENDPOINT%/}
HOST=${BACKUP_POSTGRES_HOST:-postgres}

# A dump is the whole database in one file; keep it owner-only.
umask 077
mkdir -p "$DIRECTORY"

# Signed S3 request. Every call needs the payload hash, so it is explicit
# rather than implied.
s3() {
  local method="$1" path="$2" payload_sha="$3"
  shift 3
  curl --fail --silent --show-error --retry 3 --retry-delay 5 \
    --request "$method" \
    --aws-sigv4 "aws:amz:$REGION:s3" \
    --user "$BACKUP_S3_ACCESS_KEY_ID:$BACKUP_S3_SECRET_ACCESS_KEY" \
    --header "x-amz-content-sha256: $payload_sha" \
    "$@" \
    "$ENDPOINT$path"
}

run_once() {
  local stamp target temporary object payload_sha size
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  target="$DIRECTORY/blueflare-$stamp.dump"
  temporary="$target.tmp"

  # --- dump, and prove it is readable before it counts as a backup ----------
  if ! PGPASSWORD="$POSTGRES_PASSWORD" pg_dump \
        -h "$HOST" -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc > "$temporary"; then
    rm -f "$temporary"
    fail "pg_dump failed"
    return 1
  fi
  if ! pg_restore --list < "$temporary" >/dev/null 2>&1; then
    rm -f "$temporary"
    fail "dump failed verification and was discarded"
    return 1
  fi
  mv "$temporary" "$target"
  size=$(du -h "$target" | cut -f1)
  log "dump $(basename "$target") ($size)"

  # --- offsite -------------------------------------------------------------
  object="$PREFIX$(basename "$target")"
  payload_sha=$(sha256sum "$target" | cut -d' ' -f1)
  if ! s3 PUT "/$BACKUP_S3_BUCKET/$object" "$payload_sha" \
        --upload-file "$target" \
        --header 'content-type: application/octet-stream' >/dev/null; then
    fail "upload failed; $(basename "$target") exists only on this host"
    prune_local
    return 1
  fi
  log "offsite s3://$BACKUP_S3_BUCKET/$object"

  prune_local
  prune_remote
}

# The UTC stamp in each name sorts chronologically, so lexical order is
# chronological order and no date parsing is needed on either end.
#
# A bash glob rather than `find -printf`: this runs on Alpine, whose busybox
# find has no -printf.
local_dumps() {
  local path
  for path in "$DIRECTORY"/blueflare-*.dump; do
    [[ -e "$path" ]] || continue
    basename "$path"
  done
}

prune_local() {
  local stale
  local_dumps | sort -r | tail -n +$((KEEP_LOCAL + 1)) \
    | while read -r stale; do
        rm -f "$DIRECTORY/$stale"
        log "prune local $stale"
      done
}

prune_remote() {
  local stale
  s3 GET "/$BACKUP_S3_BUCKET?list-type=2&prefix=$PREFIX" "$EMPTY_SHA" \
    | grep -o '<Key>[^<]*</Key>' | sed 's/<[^>]*>//g' \
    | sort -r | tail -n +$((KEEP_REMOTE + 1)) \
    | while read -r stale; do
        s3 DELETE "/$BACKUP_S3_BUCKET/$stale" "$EMPTY_SHA" >/dev/null
        log "prune remote $stale"
      done
}

if [[ "$ONCE" == "--once" ]]; then
  run_once
  exit $?
fi

stopping=false
trap 'stopping=true; log "signal received, stopping after current backup"' TERM INT

log "started; every ${INTERVAL}s, first run in ${START_DELAY}s, keep ${KEEP_LOCAL} local / ${KEEP_REMOTE} remote"
sleep "$START_DELAY" &
wait $! || true

while [[ "$stopping" == false ]]; do
  run_once || fail "backup cycle failed; retrying next interval"
  [[ "$stopping" == true ]] && break
  sleep "$INTERVAL" &
  wait $! || true
done
