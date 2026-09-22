# Shared helpers for scripts/deploy.sh and scripts/rollback.sh. Sourced, not run.
#
# The stack runs from $STACK_DIR (ADR-001) and builds straight from this repo
# through BLUEFLARE_SRC, so every compose call happens from the stack directory.

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
STACK_DIR=${BLUEFLARE_STACK_DIR:-/opt/stacks/blueflare}
# rev / prev_rev / services / at of the code that is running. Written only after
# a deploy or rollback passes its health gate, so it always names healthy code.
STATE_FILE=$STACK_DIR/.last-deploy
# Services with a build: section; the others run pinned upstream images.
BUILT_SERVICES=(frontend api worker backup)

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf 'ABORT: %s\n' "$*" >&2; exit 1; }
compose() { (cd "$STACK_DIR" && docker compose "$@"); }
http_code() { curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$@" || true; }
# Empty output, not a failure, for a missing image: callers run under pipefail.
img_id() { docker image inspect --format '{{.Id}}' "$1" 2>/dev/null | cut -c8-19 || true; }

is_built_service() {
  local s
  for s in "${BUILT_SERVICES[@]}"; do [[ $s == "$1" ]] && return 0; done
  return 1
}

state_get() {
  [[ -r $STATE_FILE ]] || return 0
  sed -n "s/^$1=//p" "$STATE_FILE" | tail -n 1
}

# state_write <rev> <prev_rev> <services...>
state_write() {
  local rev=$1 prev=$2 tmp
  shift 2
  tmp=$(mktemp "$STACK_DIR/.last-deploy.XXXXXX")
  printf 'rev=%s\nprev_rev=%s\nservices=%s\nat=%s\n' "$rev" "$prev" "$*" "$(date -Is)" >"$tmp"
  mv "$tmp" "$STATE_FILE"
}

# wait_healthy <service> [timeout-seconds]. api/frontend only turn `unhealthy`
# after 20 failed probes, so `unhealthy` is a verdict, not a transient.
wait_healthy() {
  local svc=$1 deadline=$((SECONDS + ${2:-300})) state=
  while (( SECONDS < deadline )); do
    state=$(docker inspect --format '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}/{{.State.ExitCode}}' "blueflare-$svc" 2>/dev/null) || state=missing
    case $state in
      running/healthy/*|running/none/*) log "  $svc: $state"; return 0 ;;
      running/starting/*|created/*|restarting/*) ;;
      # backup exits 0 by design when BACKUP_ENABLED=false.
      exited/none/0) [[ $svc == backup ]] && { log "  $svc: exited 0 (backup disabled)"; return 0; }
                     log "  $svc: $state"; return 1 ;;
      *) log "  $svc: $state"; return 1 ;;
    esac
    sleep 5
  done
  log "  $svc: still '$state' after timeout"
  return 1
}

# smoke — the probes from scripts/verify.sh plus the API and the public origin.
# Retries because a freshly started Next server renders its first list cold.
smoke() {
  local attempt p code bad slug person
  for attempt in 1 2 3; do
    bad=0
    for p in /healthz "/list/phim-le?page=2" "/list/phim-le?page=3"; do
      code=$(http_code "http://127.0.0.1:3100$p"); [[ $code == 200 ]] || bad=1
      log "  :3100$p -> $code"
    done
    code=$(http_code -X POST http://127.0.0.1:3100/api/internal/revalidate); [[ $code =~ ^(401|403|404)$ ]] || bad=1
    log "  unauthenticated POST revalidate -> $code (want 401/403/404)"
    code=$(http_code http://127.0.0.1:3200/api/health); [[ $code == 200 ]] || bad=1
    log "  :3200/api/health -> $code"
    # The detail page is the only route reading movie_credits, and it turns an API
    # failure into notFound() — so a broken credits query surfaces as 404 here, not
    # 5xx. The slug comes from the live catalog so the probe cannot rot.
    slug=$(curl -s --max-time 15 "http://127.0.0.1:3200/api/list?type=phim-le&page=1" | jq -r '.data.items[0].slug // empty' || true)
    if [[ -z $slug ]]; then
      log "  :3200/api/list returned no phim-le slug to probe"; bad=1
    else
      code=$(http_code "http://127.0.0.1:3200/api/movie/$slug"); [[ $code == 200 ]] || bad=1
      log "  :3200/api/movie/$slug -> $code"
      code=$(http_code "http://127.0.0.1:3100/movie/$slug"); [[ $code == 200 ]] || bad=1
      log "  :3100/movie/$slug -> $code"
      # Only a real person slug reaches listPersonMovies; an invented one 404s at the
      # lookup. Absent until the worker's first credits pass has run.
      person=$(curl -s --max-time 15 "http://127.0.0.1:3200/api/movie/$slug" | jq -r '.movie.people.cast[0].slug // empty' || true)
      if [[ -n $person ]]; then
        code=$(http_code "http://127.0.0.1:3100/person/$person"); [[ $code == 200 ]] || bad=1
        log "  :3100/person/$person -> $code"
      else
        log "  :3100/person skipped: $slug has no credits yet"
      fi
    fi
    code=$(http_code https://phim.bluesia.net/); [[ $code == 200 ]] || bad=1
    log "  https://phim.bluesia.net/ -> $code"
    (( bad == 0 )) && return 0
    if (( attempt < 3 )); then log "  smoke attempt $attempt failed, retrying in 15s"; sleep 15; fi
  done
  return 1
}

# swap_images <service...> — exchange :latest and :prev, so a second call undoes
# the first. Checks every :prev exists before retagging anything.
swap_images() {
  local s
  for s in "$@"; do
    docker image inspect "blueflare-$s:prev" >/dev/null 2>&1 || die "no blueflare-$s:prev image to swap to"
  done
  for s in "$@"; do
    docker tag "blueflare-$s:latest" "blueflare-$s:swap"
    docker tag "blueflare-$s:prev" "blueflare-$s:latest"
    docker tag "blueflare-$s:swap" "blueflare-$s:prev"
    docker rmi "blueflare-$s:swap" >/dev/null
    log "  $s: :latest is now $(img_id "blueflare-$s:latest")"
  done
}

# recreate <service...> — move containers onto their current :latest image,
# without rebuilding and without touching dependencies. Containers already on
# that image are left alone.
recreate() {
  local s stale=()
  for s in "$@"; do
    [[ $(docker inspect --format '{{.Image}}' "blueflare-$s" 2>/dev/null | cut -c8-19) == "$(img_id "blueflare-$s:latest")" ]] || stale+=("$s")
  done
  if (( ${#stale[@]} == 0 )); then log "  already on their current images: $*"; return 0; fi
  compose up -d --no-build --no-deps --force-recreate "${stale[@]}"
}
