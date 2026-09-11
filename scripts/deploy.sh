#!/usr/bin/env bash
# Deploy the committed HEAD to the live stack: build only the services the
# change touches, recreate them, wait for health, smoke-test, and put the
# previous images back if that gate fails.
#
#   scripts/deploy.sh [--dry-run] [--force] [--skip-tests] [--no-rollback] [service...|all]
#
# With no service names, they come from `git diff <deployed rev>..HEAD`, the
# rev recorded in $STACK_DIR/.last-deploy. The first deploy has no record, so
# name the services (`all` = every built service).
#
#   --dry-run      print the plan, every check and the sync preview; change nothing
#   --force        deploy despite CPU steal, low RAM, or an already-unhealthy API
#   --skip-tests   skip node --test / vitest (the image build still runs next build)
#   --no-rollback  leave the new containers running when the health gate fails
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/stack.sh"

dry=0 force=0 tests=1 rollback=1 services=()
for a in "$@"; do
  case $a in
    --dry-run) dry=1 ;;
    --force) force=1 ;;
    --skip-tests) tests=0 ;;
    --no-rollback) rollback=0 ;;
    all) services+=("${BUILT_SERVICES[@]}") ;;
    -*) die "unknown flag $a" ;;
    *) is_built_service "$a" || die "'$a' is not a built service (${BUILT_SERVICES[*]})"; services+=("$a") ;;
  esac
done

# In a dry run every failed check is reported and the preview continues.
gate() { if (( dry )); then printf 'WOULD ABORT: %s\n' "$1"; else die "$1"; fi; }
has() { [[ " ${services[*]} " == *" $1 "* ]]; }

cd "$ROOT"

# 1. The images are built from this working tree, so it must be exactly a
#    pushed commit — anything else ships code nobody can find in git.
[[ $(git branch --show-current) == main ]] || gate "not on main"
[[ -z $(git status --porcelain --untracked-files=no) ]] \
  || gate "uncommitted changes would be baked into the image; commit them first"
untracked=$(git ls-files -o --exclude-standard -- src components lib public backend/src backend/migrations deploy)
[[ -z $untracked ]] || gate "untracked files inside the build context: $(tr '\n' ' ' <<<"$untracked")"
git fetch -q origin main || gate "git fetch origin main failed"
git merge-base --is-ancestor HEAD origin/main || gate "HEAD $(git rev-parse --short HEAD) is not on origin/main; push first"
rev=$(git rev-parse HEAD)
prev_rev=$(state_get rev)

# 2. What changed since the running rev.
changed=
if [[ -n $prev_rev ]] && git cat-file -e "$prev_rev^{commit}" 2>/dev/null; then
  changed=$(git diff --name-only "$prev_rev" "$rev")
fi
if (( ${#services[@]} == 0 )); then
  [[ -n $prev_rev ]] || die "no $STATE_FILE yet: name the services, e.g. scripts/deploy.sh all"
  [[ -n $changed || $prev_rev == "$rev" ]] || die "recorded rev $prev_rev is unknown to this repo; name the services"
  if [[ $prev_rev == "$rev" ]]; then log "HEAD ${rev:0:7} is already deployed"; exit 0; fi
  if grep -Eq '^(src|components|lib|public)/|^(package(-lock)?\.json|next\.config\.ts|tsconfig\.json|postcss\.config\.mjs|Dockerfile\.frontend|\.dockerignore)$' <<<"$changed"; then
    services+=(frontend)
  fi
  if grep -Eq '^backend/(src/|migrations/|package(-lock)?\.json$|Dockerfile$|\.dockerignore$)' <<<"$changed"; then
    services+=(api worker)
  fi
  if grep -q '^deploy/backup/' <<<"$changed"; then services+=(backup); fi
fi
mapfile -t services < <(printf '%s\n' ${services[@]+"${services[@]}"} | awk 'NF && !seen[$0]++')
compose_changed=0
diff -q deploy/compose.yml "$STACK_DIR/compose.yml" >/dev/null 2>&1 || compose_changed=1
new_migrations=$(grep '^backend/migrations/' <<<"$changed" || true)

log "deploy ${prev_rev:0:7}${prev_rev:+..}${rev:0:7}  services: ${services[*]:-none}  compose.yml changed: $compose_changed"
if [[ -n $new_migrations ]]; then
  log "migrations the api runs at boot — a rollback does NOT undo them:"
  sed 's/^/    /' <<<"$new_migrations"
fi

# 3. Every key .env.example documents must already be in the stack .env
#    (apply-env.sh enforces the same). Key names only, never values.
missing=$(comm -23 <(grep -oE '^[A-Z_]+=' backend/.env.example | sort -u) \
                   <(grep -oE '^[A-Z_]+=' "$STACK_DIR/.env" | sort -u) | tr -d '=' | tr '\n' ' ')
[[ -z $missing ]] || gate "$STACK_DIR/.env lacks keys documented in backend/.env.example: $missing"

if (( ${#services[@]} || compose_changed )); then
  # 4. A build on a starved host is how 09-06 (RAM) and 09-10 (CPU steal) began.
  mem_avail=$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo)
  need=700; if has frontend; then need=1500; fi
  read -r _ u1 n1 s1 i1 w1 q1 sq1 st1 _ </proc/stat; sleep 3
  read -r _ u2 n2 s2 i2 w2 q2 sq2 st2 _ </proc/stat
  total=$(( (u2 + n2 + s2 + i2 + w2 + q2 + sq2 + st2) - (u1 + n1 + s1 + i1 + w1 + q1 + sq1 + st1) ))
  steal=$(( total > 0 ? 100 * (st2 - st1) / total : 0 ))
  log "host: MemAvailable ${mem_avail} MiB (need ${need}), CPU steal ${steal}% over 3s"
  if (( (mem_avail < need || steal > 40) && ! force )); then
    gate "host under pressure; wait, or rerun with --force"
  fi

  # 5. The gate below cannot tell a bad deploy from a fault that was already there.
  code=$(http_code http://127.0.0.1:3200/api/health)
  if [[ $code != 200 ]] && (( ! force )); then
    gate "api/health is already $code before deploying; run the prod-health skill first, or --force if this deploy is the fix"
  fi
fi

if (( dry )); then
  log "sync preview:"
  deploy/sync-stack.sh --dry-run | grep '^WOULD' || echo "    stack files already current"
  exit 0
fi

# 6. Fast tests. The image build runs next build, so it is not repeated here.
if (( tests )); then
  if has api || has worker; then
    log "backend: node --test"
    (cd backend && node --test) >/tmp/blueflare-deploy-backend.log 2>&1 \
      || { tail -n 30 /tmp/blueflare-deploy-backend.log; die "backend tests failed"; }
  fi
  if has frontend; then
    log "frontend: vitest"
    npx vitest run >/tmp/blueflare-deploy-vitest.log 2>&1 \
      || { tail -n 30 /tmp/blueflare-deploy-vitest.log; die "vitest failed"; }
  fi
fi
if (( compose_changed )); then
  BLUEFLARE_ENV_FILE="$ROOT/backend/.env.example" docker compose -f deploy/compose.yml config --quiet \
    || die "deploy/compose.yml does not validate"
fi

# 7. Stack files first, so the build and the recreate read the new compose.yml.
sync_out=$(deploy/sync-stack.sh)
log "synced $(grep -c '^synced:' <<<"$sync_out") stack files"

if (( ${#services[@]} == 0 && ! compose_changed )); then
  state_write "$rev" "$prev_rev"
  log "no image changes; recorded ${rev:0:7} as deployed"
  exit 0
fi

# 8. Build while the old containers keep serving. :prev is the rollback target.
if (( ${#services[@]} )); then
  for s in "${services[@]}"; do
    if docker image inspect "blueflare-$s:latest" >/dev/null 2>&1; then
      docker tag "blueflare-$s:latest" "blueflare-$s:prev"
    fi
  done
  log "building ${services[*]}"
  compose build "${services[@]}" || die "build failed; nothing was recreated"
fi

# 9. Recreate. A compose.yml change may touch any service, so reconcile all.
check=(${services[@]+"${services[@]}"})
if (( compose_changed )); then
  log "compose.yml changed: reconciling every service"
  compose up -d --no-build
  check=(postgres valkey api worker frontend backup)
fi
if (( ${#services[@]} )); then recreate "${services[@]}"; fi

# 10. Health gate.
log "waiting for health"
ok=1
for s in "${check[@]}"; do wait_healthy "$s" || ok=0; done
if (( ok )); then log "smoke"; smoke || ok=0; fi

if (( ! ok )); then
  if (( rollback && ${#services[@]} )); then
    log "health gate failed — putting ${services[*]} back on their previous images"
    swap_images "${services[@]}"
    recreate "${services[@]}"
    for s in "${services[@]}"; do wait_healthy "$s" || true; done
    smoke || log "still failing after the rollback: the fault is not only this change (run the prod-health skill)"
    (( compose_changed )) && log "compose.yml stays at the new version; revert that commit and deploy to undo it"
  fi
  die "deploy of ${rev:0:7} failed its health gate; $STATE_FILE still names ${prev_rev:0:7}"
fi

state_write "$rev" "$prev_rev" "${services[@]}"
docker image prune -f --filter label=com.docker.compose.project=blueflare >/dev/null || true
log "deployed ${rev:0:7}: ${services[*]:-no image changes}"
