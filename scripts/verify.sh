#!/usr/bin/env bash
# Run the blueflare verification checklist (CLAUDE.md "Verification") and print
# one line per check. Exit 0 only if no check failed.
#
#   scripts/verify.sh            every check
#   scripts/verify.sh --changed  only the sections the working tree touches
#
# Read-only against production: it builds locally and probes the running
# containers on 127.0.0.1, but never restarts, syncs, or reloads anything.
set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STACK_ENV=${BLUEFLARE_STACK_DIR:-/opt/stacks/blueflare}/.env
LOG_DIR=$(mktemp -d /tmp/blueflare-verify.XXXXXX)
mode=all
[[ "${1:-}" == "--changed" ]] && mode=changed

changed=$(cd "$ROOT" && { git diff --name-only HEAD; git ls-files --others --exclude-standard; } | sort -u)
touches() { [[ "$mode" == all ]] || grep -Eq "$1" <<<"$changed"; }

pass=0 fail=0 warn=0

# run <name> <command...> — runs in a subshell from the repo root so no check
# can leave the next one in the wrong directory.
run() {
  local name=$1 log="$LOG_DIR/$1.log" start=$SECONDS; shift
  if (cd "$ROOT" && "$@") >"$log" 2>&1; then
    printf 'PASS  %-13s %4ss\n' "$name" $((SECONDS - start)); pass=$((pass + 1))
  else
    printf 'FAIL  %-13s %4ss  log: %s\n' "$name" $((SECONDS - start)) "$log"
    tail -n 30 "$log" | sed 's/^/      | /'
    fail=$((fail + 1))
  fi
}
skip() { printf 'SKIP  %-13s        %s\n' "$1" "$2"; }

http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$@"; }

check_backend() {
  if [[ ! -d backend/node_modules ]]; then
    echo "backend/node_modules is missing: run 'npm ci' in backend/ (providers.test.js needs 'pg')."
    return 1
  fi
  cd backend && node --test
}

# vitest only runs what vitest.config.ts includes; a test file outside those
# globs silently never runs.
check_vitest_scope() {
  local stray
  stray=$(git ls-files -co --exclude-standard '*.test.ts' '*.test.tsx' ':!backend/' \
    | grep -Ev '^((lib|src)/.*\.test\.ts|components/.*\.test\.tsx?)$')
  [[ -z "$stray" ]] && return 0
  echo "Test files outside vitest.config.ts include globs (never run):"
  echo "$stray"
  return 1
}

check_compose() {
  BLUEFLARE_ENV_FILE="$ROOT/backend/.env.example" docker compose -f deploy/compose.yml config --quiet
}

# Mirrors deploy/apply-env.sh: every key in .env.example must exist in the stack
# .env, or the next deploy aborts. Prints key names only, never values.
check_env_keys() {
  local key missing=0
  while IFS= read -r key; do
    grep -qE "^${key}=" "$STACK_ENV" || { echo "missing from $STACK_ENV: $key"; missing=1; }
  done < <(grep -oE '^[A-Z_]+=' backend/.env.example | tr -d '=' | sort -u)
  return "$missing"
}

check_smoke() {
  local p code bad=0
  for p in /healthz "/list/phim-le?page=2" "/list/phim-le?page=3"; do
    code=$(http_code "http://127.0.0.1:3100$p")
    echo "$p -> $code"
    [[ "$code" == 200 ]] || bad=1
  done
  return "$bad"
}

check_revalidate() {
  local code
  code=$(http_code -X POST http://127.0.0.1:3100/api/internal/revalidate)
  echo "unauthenticated POST /api/internal/revalidate -> $code (want 401/403/404)"
  [[ "$code" =~ ^(401|403|404)$ ]]
}

cd "$ROOT" || exit 2
echo "blueflare verify ($mode) — logs in $LOG_DIR"

run whitespace git diff --check HEAD

if touches '^backend/'; then
  run backend check_backend
else
  skip backend "no backend/ changes"
fi

if touches '^(src|components|lib|public)/|^(package(-lock)?\.json|next\.config\.ts|tsconfig\.json|vitest\.config\.ts|postcss\.config\.mjs)$'; then
  run vitest-scope check_vitest_scope
  run vitest npx vitest run
  run build npm run build
else
  skip vitest "no frontend changes"
  skip build "no frontend changes"
fi

if touches '^deploy/|^backend/\.env\.example$'; then
  run compose check_compose
else
  skip compose "no deploy/ or .env.example changes"
fi

if ! touches '^backend/\.env\.example$'; then
  skip env-keys "backend/.env.example unchanged"
elif [[ ! -r "$STACK_ENV" ]]; then
  skip env-keys "$STACK_ENV not readable"
else
  run env-keys check_env_keys
fi

# The smoke test probes the deployed containers, not the working tree.
run smoke check_smoke
run revalidate check_revalidate

# Worker health describes production, not the change: a warning, not a failure.
health=$(curl -s --max-time 10 http://127.0.0.1:3200/api/health | jq -c '{status, worker}' 2>/dev/null)
if [[ "$(jq -r '.status' <<<"$health" 2>/dev/null)" == ok ]]; then
  printf 'PASS  %-13s\n' api-health; pass=$((pass + 1))
else
  printf 'WARN  %-13s        production api/worker not healthy: %s (use the prod-health skill)\n' \
    api-health "${health:-no response}"
  warn=$((warn + 1))
fi

echo "== $pass passed, $fail failed, $warn warnings =="
[[ "$fail" -eq 0 ]]
