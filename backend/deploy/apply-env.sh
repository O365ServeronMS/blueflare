#!/usr/bin/env bash
# Validate backend/.env against .env.example, then recreate the affected
# containers in place from the current images (no rebuild). Run this after
# editing .env to ship a config-only change without a code deploy.
#
# Usage: backend/deploy/apply-env.sh
set -euo pipefail

STACK_DIR=${BLUEFLARE_STACK_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
ENV_FILE=${BLUEFLARE_ENV_FILE:-$STACK_DIR/.env}
EXAMPLE_FILE="$STACK_DIR/.env.example"
COMPOSE_FILE=${BLUEFLARE_COMPOSE_FILE:-$STACK_DIR/compose.yml}

# Keys whose value must not be empty and must not still be the .env.example
# placeholder in a production deploy.
REQUIRED_SECRETS=(
  IMAGE_SIGNING_SECRET
  POSTGRES_PASSWORD
  FRONTEND_REVALIDATE_SECRET
)

fail=0

if [[ ! -f "$ENV_FILE" ]]; then
  echo "FAIL: $ENV_FILE not found" >&2
  exit 1
fi

env_value() {
  local key="$1" file="$2"
  grep -E "^${key}=" "$file" | tail -n1 | cut -d= -f2- || true
}

echo "== validating $ENV_FILE against $EXAMPLE_FILE =="

while IFS= read -r key; do
  if ! grep -qE "^${key}=" "$ENV_FILE"; then
    echo "FAIL: $key is documented in .env.example but missing from .env" >&2
    fail=1
  fi
done < <(grep -oE '^[A-Z_]+=' "$EXAMPLE_FILE" | tr -d '=' | sort -u)

for key in "${REQUIRED_SECRETS[@]}"; do
  value=$(env_value "$key" "$ENV_FILE")
  if [[ -z "$value" ]]; then
    echo "FAIL: $key is empty in .env — dependent features silently no-op instead of erroring" >&2
    fail=1
  elif [[ "$value" == replace-with-* ]]; then
    echo "FAIL: $key is still the .env.example placeholder value" >&2
    fail=1
  fi
done

if [[ "$fail" -ne 0 ]]; then
  echo "== validation failed, aborting before touching containers ==" >&2
  exit 1
fi
echo "== validation passed =="

echo "== docker compose config --quiet =="
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" config --quiet

echo "== recreating api, worker, frontend from existing images (no rebuild) =="
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --no-build api worker frontend

api_port=$(env_value PORT "$ENV_FILE")
api_port=${api_port:-3200}
frontend_port=$(env_value FRONTEND_PORT "$ENV_FILE")
frontend_port=${frontend_port:-3100}

echo "== smoke test =="
for attempt in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:${api_port}/api/health" >/dev/null && \
     curl -fsS "http://127.0.0.1:${frontend_port}/healthz" >/dev/null; then
    echo "healthz + api/health OK"
    break
  fi
  if [[ "$attempt" -eq 20 ]]; then
    echo "FAIL: services did not become healthy in time" >&2
    exit 1
  fi
  sleep 3
done

secret=$(env_value FRONTEND_REVALIDATE_SECRET "$ENV_FILE")
echo "== pinging revalidate endpoint to flush stale render cache =="
revalidate_status=$(curl -s -o /dev/null -w '%{http_code}' \
  -X POST "http://127.0.0.1:${frontend_port}/api/internal/revalidate" \
  -H 'content-type: application/json' \
  -H "x-blueflare-revalidate: ${secret}" \
  -d '{"tags":["home"]}')
if [[ "$revalidate_status" != "200" ]]; then
  echo "WARN: revalidate ping returned HTTP $revalidate_status (expected 200)" >&2
else
  echo "revalidate OK"
fi

echo "== done =="
