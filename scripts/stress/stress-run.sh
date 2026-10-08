#!/usr/bin/env bash
# Bounded, stepped, read-only GET load against the live stack, with guardrails.
#
#   scripts/stress/stress-run.sh --dry-run            print plan + URL mix, send nothing
#   scripts/stress/stress-run.sh cdn                  ladder through https://phim.bluesia.net
#   scripts/stress/stress-run.sh origin               ladder straight at 127.0.0.1:3100/:3200
#   scripts/stress/stress-run.sh soak <conc>          3 min at <conc> (use ~50% of the safe level)
#
# Hard limits: GET only, concurrency <= 40, never /api/auth|me|internal, /admin,
# /login, /signup. Aborts the whole run on the first guardrail breach (exit 2).
# Preflight failure exits 3 (NOT RUN). Output: per-step and per-route-group table.
set -uo pipefail

MAX_CONC=40
PUBLIC=https://phim.bluesia.net
IMG=https://img.bluesia.net
FRONT=http://127.0.0.1:3100
API=http://127.0.0.1:3200

mode=${1:-}
dry=0
[[ $mode == --dry-run ]] && { dry=1; mode=cdn; }
[[ $mode == cdn || $mode == origin || $mode == soak ]] || { sed -n 2,9p "$0"; exit 64; }
soak_c=${2:-10}
(( soak_c >= 1 && soak_c <= MAX_CONC )) || { echo "concurrency must be 1..$MAX_CONC"; exit 64; }

W=$(mktemp -d "${TMPDIR:-/tmp}/stress.XXXXXX")
trap 'rm -rf "$W"' EXIT
URLS=$W/urls
fail() { echo "NOT RUN (preflight failed: $*)"; exit 3; }

# ---------- host + health probes ----------
steal()  { sar -u 1 2 2>/dev/null | awk '/Average/ {print $(NF-1)}' | head -1; }
avail()  { free -m | awk '/^Mem:/ {print $7}'; }
swapu()  { free -m | awk '/^Swap:/ {print $3}'; }
load1()  { awk '{print $1}' /proc/loadavg; }
restarts() { docker inspect --format '{{.Name}}={{.RestartCount}}' $(docker ps -aq --filter name=blueflare-) 2>/dev/null | sort | tr '\n' ' '; }
unhealthy() { docker ps -a --filter name=blueflare- --format '{{.Names}} {{.Status}}' | grep -E 'blueflare-(frontend|api|worker|postgres|valkey) ' | grep -v '(healthy)'; }
health_ok() { curl -sS -m 10 $API/api/health | jq -e '.status=="ok" and .worker.ok==true' >/dev/null 2>&1; }
oom_count() { journalctl -k --since "$T0" 2>/dev/null | grep -ciE 'out of memory|rcu.*stall'; }

health_ok || fail "api/health not ok"
[[ -z "$(unhealthy)" ]] || fail "container not healthy: $(unhealthy | head -2)"
ST=$(steal); AV=$(avail); LD=$(load1)
awk -v s="${ST:-0}" -v a="$AV" -v l="$LD" 'BEGIN{exit !(s>10||a<1500||l>3)}' && fail "host steal=$ST% avail=${AV}MiB load=$LD"
T0=$(date '+%Y-%m-%d %H:%M:%S'); R0=$(restarts); SW0=$(swapu)

# ---------- URL mix (real slugs, never invented) ----------
home=$(curl -sS -m 10 $API/api/home-data)
mapfile -t slugs < <(jq -r '[.phimLe.items[]?.slug, .phimBo.items[]?.slug, .newMovies.items[]?.slug]|unique|.[0:30][]' <<<"$home")
(( ${#slugs[@]} >= 5 )) || fail "could not discover slugs"
mapfile -t people < <(for s in "${slugs[@]:0:8}"; do curl -sS -m 10 "$API/api/movie/$s" | jq -r '.movie.people.cast[0:2][]?.slug'; done | sort -u)
terms=(a nam tinh yeu hanh dong)

emit() { # base_page base_api   -> "group url" lines
  local P=$1 A=$2 n i
  for n in 1 2 3 4 5; do for i in 1 2 3 4 5 6 7 8; do echo "list $P/list/phim-le?page=$n"; done; done
  for i in $(seq 40); do echo "home $P/"; done
  for s in "${slugs[@]}"; do for i in 1 2; do echo "movie $P/movie/$s"; done; done
  for t in "${terms[@]}"; do for i in 1 2 3 4 5 6; do echo "search $P/search?q=$t"; done; done
  for p in "${people[@]:0:10}"; do echo "person $P/person/$p"; echo "person $P/person/$p"; done
  for i in 1 2 3 4 5; do echo "health $P/healthz"; done
}
if [[ $mode == origin ]]; then
  emit "$FRONT" "$API" > "$URLS"
  for s in "${slugs[@]:0:10}"; do echo "api $API/api/movie/$s" >> "$URLS"; done
  for n in 1 2 3; do echo "api $API/api/list?type=phim-le&page=$n" >> "$URLS"; done
else
  emit "$PUBLIC" "" > "$URLS"
  # ~20% of list URLs get a cache-buster so the origin is exercised, not only the CDN.
  awk 'BEGIN{srand()} $1=="list" && rand()<0.2 {print $1, $2 "&_=" int(rand()*1e6); next} {print}' "$URLS" > "$URLS.2" && mv "$URLS.2" "$URLS"
  mapfile -t imgs < <(grep -oE '/i/[md]/[0-9a-f-]{36}\.webp' <(curl -sS -m 10 $PUBLIC/) | sort -u | head -6)
  for u in "${imgs[@]}"; do echo "image $IMG$u" >> "$URLS"; done
fi
grep -qE '/(api/(auth|me|internal)|admin|login|signup)' "$URLS" && fail "forbidden path in URL list"

case $mode in
  cdn)    LADDER=(2 5 10 20 40); SECS=60 ;;
  origin) LADDER=(2 5 10 20);    SECS=30 ;;
  soak)   LADDER=("$soak_c");    SECS=180 ;;
esac
# STRESS_SECS may only shorten a step (used to smoke-test this script).
(( ${STRESS_SECS:-$SECS} < SECS )) && SECS=$STRESS_SECS
echo "mode=$mode steps=${LADDER[*]} secs/step=$SECS urls=$(wc -l <"$URLS") baseline: steal=${ST}% avail=${AV}MiB load=$LD"
awk '{print $1}' "$URLS" | sort | uniq -c | tr '\n' ' '; echo
(( dry )) && { echo "DRY RUN: nothing sent"; exit 0; }

# ---------- load step ----------
run_step() { # conc secs out — the timeout wraps the whole pipeline, so queued URLs die with it
  local c=$1 s=$2 out=$3
  URLS=$URLS C=$c timeout "$s" bash -c '
    while :; do shuf -n 200 "$URLS"; done |
    xargs -P "$C" -L1 sh -c '"'"'curl -sS -o /dev/null -m 20 -w "$0 %{http_code} %{time_total} %header{cf-cache-status}\n" "$1" 2>/dev/null || echo "$0 000 20 -"'"'"'
  ' > "$out" 2>/dev/null
}
pct() { sort -n | awk -v p="$1" '{a[NR]=$1} END{if(NR==0){print "-";exit} i=int(NR*p); if(i<1)i=1; printf "%.2f", a[i]}'; }

echo "step|conc|reqs|req/s|err%|p50|p95|p99|cdn-hit%|steal%|availMiB|load"
base_p95=""
for c in "${LADDER[@]}"; do
  out=$W/step.$c; run_step "$c" "$SECS" "$out"
  sleep 3
  n=$(wc -l <"$out"); (( n )) || { echo "ABORTED: no responses at conc=$c"; exit 2; }
  err=$(awk '$2>=500||$2==0||$2=="000"{e++} END{printf "%.2f", 100*e/NR}' "$out")
  p50=$(awk '{print $3}' "$out" | pct 0.50); p95=$(awk '{print $3}' "$out" | pct 0.95); p99=$(awk '{print $3}' "$out" | pct 0.99)
  hit=$(awk '$4=="HIT"{h++} $4!="-" && $4!=""{t++} END{printf "%.0f", t? 100*h/t : 0}' "$out")
  ST=$(steal); AV=$(avail); LD=$(load1)
  printf '%s|%s|%s|%.1f|%s|%s|%s|%s|%s|%s|%s|%s\n' "$mode" "$c" "$n" "$(awk -v n="$n" -v s="$SECS" 'BEGIN{print n/s}')" "$err" "$p50" "$p95" "$p99" "$hit" "$ST" "$AV" "$LD"
  echo "  by route group (p50/p95/err%):"
  for g in $(awk '{print $1}' "$out" | sort -u); do
    awk -v g="$g" '$1==g' "$out" > "$W/g"
    gn=$(wc -l <"$W/g"); ge=$(awk '$2>=500||$2=="000"{e++} END{printf "%.1f", 100*e/NR}' "$W/g")
    printf '    %-7s n=%-5s %s/%s err=%s%%\n' "$g" "$gn" "$(awk '{print $3}' "$W/g" | pct 0.5)" "$(awk '{print $3}' "$W/g" | pct 0.95)" "$ge"
  done
  [[ -z $base_p95 ]] && base_p95=$p95
  # ---------- guardrails ----------
  why=""
  awk -v e="$err" 'BEGIN{exit !(e>2)}' && why+="error>2% "
  awk -v p="$p95" -v b="$base_p95" 'BEGIN{exit !(p>4 || (b>0 && p>5*b && p>1))}' && why+="p95 "
  health_ok || why+="health "
  awk -v s="${ST:-0}" 'BEGIN{exit !(s>30)}' && why+="steal>30% "
  awk -v a="$AV" 'BEGIN{exit !(a<800)}' && why+="RAM<800 "
  (( $(swapu) - SW0 > 300 )) && why+="swap+300 "
  awk -v l="$LD" 'BEGIN{exit !(l>8)}' && why+="load>8 "
  [[ -n "$(unhealthy)" ]] && why+="container "
  [[ "$(restarts)" != "$R0" ]] && why+="restart "
  (( $(oom_count) > 0 )) && why+="kernel(oom/rcu) "
  if [[ -n $why ]]; then echo "ABORTED at conc=$c: $why(stop sending; do not retry)"; sleep 30; health_ok && echo "recovered: health ok" || echo "NOT RECOVERED: health not ok"; exit 2; fi
  sleep 10
done
sleep 30
health_ok && echo "RESULT: completed ladder ${LADDER[*]}; health ok after 30s; restarts unchanged: $([[ "$(restarts)" == "$R0" ]] && echo yes || echo NO)" || { echo "RESULT: health NOT ok 30s after test"; exit 2; }
