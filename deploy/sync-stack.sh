#!/usr/bin/env bash
# Đồng bộ file vận hành từ repo sang thư mục stack.
# Repo là bản chuẩn; thư mục stack chỉ giữ bản copy + .env + data/.
# Không đụng .env và data/ — hai thứ đó chỉ tồn tại ở stack.
#
# Usage: deploy/sync-stack.sh [--dry-run]
set -euo pipefail

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
STACK_DIR=${BLUEFLARE_STACK_DIR:-/opt/stacks/blueflare}
DRY=${1:-}

copy() {
  local from="$1" to="$2"
  if [[ "$DRY" == "--dry-run" ]]; then
    diff -q "$from" "$to" >/dev/null 2>&1 && echo "same: $to" || echo "WOULD UPDATE: $to"
  else
    install -m "$3" "$from" "$to"
    echo "synced: $to"
  fi
}

copy "$SRC_DIR/deploy/compose.yml" "$STACK_DIR/compose.yml" 644
# apply-env.sh validates .env against this file, so a stale copy means new
# required keys stop being checked. It is a template, never real secrets.
copy "$SRC_DIR/backend/.env.example" "$STACK_DIR/.env.example" 644
for f in "$SRC_DIR"/deploy/*.sh; do
  [[ "$(basename "$f")" == "sync-stack.sh" ]] && continue
  copy "$f" "$STACK_DIR/deploy/$(basename "$f")" 755
done
for f in "$SRC_DIR"/deploy/*.json; do
  copy "$f" "$STACK_DIR/deploy/$(basename "$f")" 644
done

echo
echo "Chưa áp dụng gì vào container. Tiếp theo, tại $STACK_DIR:"
echo "  docker compose config          # kiểm tra khô"
echo "  ./deploy/apply-env.sh          # đổi cấu hình, không rebuild"
echo "  docker compose up -d --build   # deploy code mới"
