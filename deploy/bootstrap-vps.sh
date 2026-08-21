#!/usr/bin/env bash
# Bootstrap một VPS Ubuntu (24.04/26.04) mới cho stack blueflare.
#
# Làm gì:
#   1. Cài Docker Engine + Compose plugin và Caddy (kho chính chủ).
#   2. Clone codebase qua SSH về CODEBASE_DIR (bỏ qua nếu đã có).
#   3. Dựng thư mục runtime STACK_DIR (mặc định /opt/stacks/blueflare để dockhand
#      thấy) và sync compose.yml + deploy/* từ repo vào đó (KHÔNG đụng .env/data).
#   4. Tạo .env lần đầu từ .env.example: tự sinh các secret ngẫu nhiên, trỏ
#      IMAGE_CACHE_HOST_DIR về STACK_DIR/data/images, và đặt BACKFILL_ENABLED=false
#      (bạn bật tay sau qua dockhand). KHÔNG bao giờ ghi đè .env đã tồn tại.
#   5. Cấp cho user hiện tại quyền ghi /etc/caddy/Caddyfile (chown root:$USER,
#      664 — Caddy vẫn chạy bằng user `caddy`, không phải root) và chèn khối
#      phim.bluesia.net/img.bluesia.net thẳng vào đó (idempotent, có marker),
#      rồi `caddy reload` qua admin API cục bộ (127.0.0.1:2019) — không sudo.
#      Sau bước này mọi lần sửa Caddyfile về sau (kể cả tự động) không cần sudo.
#
# Cố tình KHÔNG tự `docker compose up` — bạn xem lại .env (nhất là TMDB_API_KEY)
# rồi bấm deploy trong dockhand. Chạy với --deploy nếu muốn script build+up luôn.
#
# Usage:
#   deploy/bootstrap-vps.sh [--deploy]
#
# Ghi đè bằng biến môi trường nếu cần:
#   CODEBASE_DIR   (mặc định /home/ubuntu/blueflare)
#   STACK_DIR      (mặc định /opt/stacks/blueflare)
#   GIT_REMOTE     (mặc định git@github.com:O365ServeronMS/blueflare.git)
set -euo pipefail

CODEBASE_DIR=${CODEBASE_DIR:-/home/ubuntu/blueflare}
STACK_DIR=${STACK_DIR:-/opt/stacks/blueflare}
GIT_REMOTE=${GIT_REMOTE:-git@github.com:O365ServeronMS/blueflare.git}
DO_DEPLOY=0
[[ "${1:-}" == "--deploy" ]] && DO_DEPLOY=1

log()  { printf '\n\033[1;34m== %s ==\033[0m\n' "$*"; }
warn() { printf '\033[1;33mWARN: %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31mFAIL: %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] && die "Đừng chạy bằng root. Chạy bằng user thường có quyền sudo."
command -v sudo >/dev/null || die "cần sudo"

# ---------------------------------------------------------------------------
log "1/5 Cài gói nền, Docker, Caddy"
# ---------------------------------------------------------------------------
sudo apt-get update -y
sudo apt-get install -y ca-certificates curl git gnupg openssl python3 debian-keyring debian-archive-keyring apt-transport-https

if ! command -v docker >/dev/null; then
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  # 26.04 có thể chưa có kho stable cho codename mới; fallback về LTS gần nhất.
  codename=$(. /etc/os-release && echo "$VERSION_CODENAME")
  if ! curl -fsSL "https://download.docker.com/linux/ubuntu/dists/${codename}/Release" >/dev/null 2>&1; then
    warn "Docker chưa publish kho cho '${codename}'; tạm dùng 'noble' (24.04 LTS)."
    codename=noble
  fi
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${codename} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "docker đã có, bỏ qua."
fi

if ! getent group docker | grep -qw "$USER"; then
  sudo usermod -aG docker "$USER"
  warn "Đã thêm $USER vào group docker — đăng xuất/đăng nhập lại để có hiệu lực."
fi

if ! command -v caddy >/dev/null; then
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
else
  echo "caddy đã có, bỏ qua."
fi

# ---------------------------------------------------------------------------
log "2/5 Clone codebase (SSH) về $CODEBASE_DIR"
# ---------------------------------------------------------------------------
if [[ -d "$CODEBASE_DIR/.git" ]]; then
  echo "$CODEBASE_DIR đã là git repo, bỏ qua clone."
else
  git clone "$GIT_REMOTE" "$CODEBASE_DIR"
fi
[[ -f "$CODEBASE_DIR/deploy/compose.yml" ]] || die "$CODEBASE_DIR/deploy/compose.yml không thấy — codebase sai chỗ?"

# ---------------------------------------------------------------------------
log "3/5 Dựng thư mục runtime $STACK_DIR + sync file vận hành"
# ---------------------------------------------------------------------------
sudo mkdir -p "$STACK_DIR/deploy" "$STACK_DIR/data/images"
sudo chown -R "$USER":"$USER" "$STACK_DIR"
# node uid:gid = 1000 trong image api/worker; cache ảnh phải thuộc về nó.
sudo chown -R 1000:1000 "$STACK_DIR/data/images"

BLUEFLARE_STACK_DIR="$STACK_DIR" "$CODEBASE_DIR/deploy/sync-stack.sh"
install -m 644 "$CODEBASE_DIR/backend/.env.example" "$STACK_DIR/.env.example"

# ---------------------------------------------------------------------------
log "4/5 Chuẩn bị .env"
# ---------------------------------------------------------------------------
ENV_FILE="$STACK_DIR/.env"
if [[ -f "$ENV_FILE" ]]; then
  warn ".env đã tồn tại — GIỮ NGUYÊN, không đụng tới. Tự kiểm tra bằng deploy/apply-env.sh."
else
  cp "$STACK_DIR/.env.example" "$ENV_FILE"
  chmod 600 "$ENV_FILE"

  set_kv() { # set_kv KEY VALUE  — thay dòng ^KEY= tại chỗ (value có thể chứa /,&)
    local key="$1" val="$2"
    python3 - "$ENV_FILE" "$key" "$val" <<'PY'
import sys
path, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path).read().splitlines()
out, seen = [], False
for ln in lines:
    if ln.startswith(key + "="):
        out.append(f"{key}={val}"); seen = True
    else:
        out.append(ln)
if not seen:
    out.append(f"{key}={val}")
open(path, "w").write("\n".join(out) + "\n")
PY
  }

  pg_pass=$(openssl rand -hex 24)
  img_secret=$(openssl rand -hex 32)
  reval_secret=$(openssl rand -hex 32)
  metrics_token=$(openssl rand -hex 24)

  set_kv POSTGRES_PASSWORD "$pg_pass"
  # DATABASE_URL phải khớp POSTGRES_PASSWORD (user/db lấy từ .env.example: blueflare).
  set_kv DATABASE_URL "postgres://blueflare:${pg_pass}@postgres:5432/blueflare"
  set_kv IMAGE_SIGNING_SECRET "$img_secret"
  set_kv FRONTEND_REVALIDATE_SECRET "$reval_secret"
  set_kv METRICS_TOKEN "$metrics_token"
  set_kv IMAGE_CACHE_HOST_DIR "$STACK_DIR/data/images"
  # Head sync bật để có phim mới; backfill để bạn tự bật qua dockhand.
  set_kv SYNC_ENABLED "true"
  set_kv BACKFILL_ENABLED "false"

  echo "Đã tạo $ENV_FILE (chmod 600) với secret ngẫu nhiên."
  echo "CÒN PHẢI SỬA TAY: TMDB_API_KEY (nếu muốn Hero Trending)."
fi

# ---------------------------------------------------------------------------
log "5/5 Caddy edge cho phim.bluesia.net + img.bluesia.net (sudo-free sau bước này)"
# ---------------------------------------------------------------------------
command -v caddy >/dev/null || die "caddy chưa cài — bước 1 chưa chạy?"

if ! systemctl is-active --quiet caddy; then
  sudo systemctl enable --now caddy
fi

CADDYFILE=/etc/caddy/Caddyfile
[[ -f "$CADDYFILE" ]] || sudo install -m 664 -o root -g "$USER" /dev/null "$CADDYFILE"
# Chỉ cấp quyền ghi trên đúng file này — Caddy vẫn chạy bằng user `caddy`,
# đây không phải trao quyền root. Thư mục /etc/caddy không cần ghi được:
# mọi chỉnh sửa dưới đây là ghi tại chỗ / append, không tạo/đổi tên file mới.
sudo chown root:"$USER" "$CADDYFILE"
sudo chmod 664 "$CADDYFILE"

for grp in adm systemd-journal; do
  if ! id -nG "$USER" | grep -qw "$grp"; then
    sudo usermod -aG "$grp" "$USER"
    warn "Đã thêm $USER vào group $grp (đọc log caddy) — cần đăng nhập lại để có hiệu lực."
  fi
done

inject_caddy_block() { # inject_caddy_block MARKER SRC_FILE
  local marker="$1" src="$2"
  if grep -q "^# BEGIN blueflare:${marker}\$" "$CADDYFILE" 2>/dev/null; then
    echo "Caddyfile: khối ${marker} đã có, bỏ qua."
    return
  fi
  {
    echo "# BEGIN blueflare:${marker}"
    cat "$src"
    echo "# END blueflare:${marker}"
  } >> "$CADDYFILE"
  echo "Caddyfile: đã thêm khối ${marker}."
}

inject_caddy_block "phim.bluesia.net" "$STACK_DIR/deploy/phim.bluesia.net.caddy"
inject_caddy_block "img.bluesia.net"  "$STACK_DIR/deploy/img.bluesia.net.caddy"

caddy fmt --overwrite "$CADDYFILE"
if caddy validate --config "$CADDYFILE" --adapter caddyfile >/tmp/caddy-validate.$$ 2>&1; then
  if caddy reload --config "$CADDYFILE" >/tmp/caddy-reload.$$ 2>&1; then
    echo "Caddy reload OK."
  else
    warn "caddy reload lỗi — xem /tmp/caddy-reload.$$ hoặc journalctl -u caddy -n 40 --no-pager"
  fi
else
  warn "caddy validate lỗi — xem /tmp/caddy-validate.$$. Khối vừa thêm có thể đang nằm sai trong $CADDYFILE, sửa tay trước khi reload."
fi

# ---------------------------------------------------------------------------
log "Kiểm tra khô compose"
# ---------------------------------------------------------------------------
( cd "$STACK_DIR" && docker compose config --quiet ) && echo "compose config OK."

if [[ "$DO_DEPLOY" -eq 1 ]]; then
  log "Deploy (build + up)"
  ( cd "$STACK_DIR" && docker compose up -d --build )
  echo "Xong. Chờ service healthy: (cd $STACK_DIR && docker compose ps)"
else
  cat <<EOF

Bootstrap xong. Chưa deploy container (theo chủ đích).
Tiếp theo:
  1. Xem lại $ENV_FILE — điền TMDB_API_KEY nếu cần.
  2. Deploy qua dockhand (stack: blueflare) HOẶC:
       cd $STACK_DIR && docker compose up -d --build
  3. Smoke test:
       curl -fsS http://127.0.0.1:3200/api/health
       curl -fsS http://127.0.0.1:3100/healthz
  4. Bật BACKFILL sau: sửa BACKFILL_ENABLED=true trong .env qua dockhand rồi redeploy
     (hoặc $STACK_DIR/deploy/apply-env.sh để recreate không rebuild).
EOF
fi
