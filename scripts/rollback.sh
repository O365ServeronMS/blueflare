#!/usr/bin/env bash
# Put services back on the images they ran before the last deploy, then run the
# same health gate as scripts/deploy.sh. The swap is symmetric: running it a
# second time rolls forward again.
#
#   scripts/rollback.sh [--dry-run] [service...]
#
# With no service names, rolls back what $STACK_DIR/.last-deploy says the last
# deploy rebuilt. Only images move: stack files synced from deploy/ and any
# migration the API already ran stay as they are.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib/stack.sh"

dry=0 services=()
for a in "$@"; do
  case $a in
    --dry-run) dry=1 ;;
    -*) die "unknown flag $a" ;;
    *) is_built_service "$a" || die "'$a' is not a built service (${BUILT_SERVICES[*]})"; services+=("$a") ;;
  esac
done
if (( ${#services[@]} == 0 )); then read -ra services <<<"$(state_get services)"; fi
(( ${#services[@]} )) || die "nothing to roll back: name the services ($STATE_FILE records no image change)"

rev=$(state_get rev) prev=$(state_get prev_rev)
if [[ -n $rev ]]; then log "running rev ${rev:0:7}, previous ${prev:0:7}"; else log "no $STATE_FILE: running rev unknown"; fi
for s in "${services[@]}"; do
  p=$(img_id "blueflare-$s:prev")
  printf '  %-9s container %-12s :latest %-12s :prev %s\n' "$s" \
    "$(docker inspect --format '{{.Image}}' "blueflare-$s" 2>/dev/null | cut -c8-19)" \
    "$(img_id "blueflare-$s:latest")" \
    "${p:+$p (built $(docker image inspect --format '{{.Created}}' "blueflare-$s:prev" | cut -c1-16))}${p:-missing — nothing to roll back to}"
done
(( dry )) && exit 0

log "rolling back ${services[*]}"
swap_images "${services[@]}"
recreate "${services[@]}"

ok=1
for s in "${services[@]}"; do wait_healthy "$s" || ok=0; done
if (( ok )); then log "smoke"; smoke || ok=0; fi
(( ok )) || die "rollback failed its health gate; the fault is probably not the deploy (run the prod-health skill). Run this script again to roll forward."

if [[ -r $STATE_FILE ]]; then state_write "$prev" "$rev" "${services[@]}"; fi
log "rolled back ${services[*]}; running rev is now ${prev:0:7}"
