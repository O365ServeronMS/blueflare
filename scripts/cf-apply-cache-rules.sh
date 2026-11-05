#!/usr/bin/env bash
# Apply the four cache rules in infra/cloudflare/ to the bluesia.net zone, keeping
# any other cache rule (e.g. the dashboard "Bypass cache for Media") after ours.
# Needs CF_API_TOKEN with Zone > Cache Rules: Edit (and Zone: Read).
set -euo pipefail
: "${CF_API_TOKEN:?set CF_API_TOKEN}"
cd "$(dirname "$0")/../infra/cloudflare"
api() { curl -fsS -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" "$@"; }
zid=$(api "https://api.cloudflare.com/client/v4/zones?name=bluesia.net" | jq -r '.result[0].id')
entry=$(api "https://api.cloudflare.com/client/v4/zones/$zid/rulesets/phases/http_request_cache_settings/entrypoint")
rsid=$(jq -r '.result.id' <<<"$entry")
ours=$(jq -s '.' cloudflare-frontend-static-rule.json cloudflare-image-cache-rule.json cloudflare-cache-rule.json cloudflare-html-cache-rule.json)
body=$(jq -n --argjson ours "$ours" --argjson entry "$entry" '
  ($ours | map(.ref)) as $refs
  | {rules: ($ours + [$entry.result.rules[] | select(.ref as $r | $refs | index($r) | not)
      | {id, ref, action, action_parameters, expression, description, enabled}])}')
[[ "${1:-}" == "--dry-run" ]] && { jq . <<<"$body"; exit 0; }
api -X PUT "https://api.cloudflare.com/client/v4/zones/$zid/rulesets/$rsid" -d "$body" | jq -r '.result.rules[] | "\(.enabled)\t\(.ref)\t\(.description)"'
