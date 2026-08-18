# Plan: Tách codebase về /home/ubuntu/blueflare, giữ runtime ở /opt/docker/stacks/blueflare

Thực thi ADR-001 (Option B). Trạng thái: **chờ duyệt, chưa chạy.**

## Nguyên tắc

1. **Dùng `mv`, không `git clone`.** Hai branch có commit chưa nằm trên `origin/<branch>`
   và PR #27/#28 đã merge nên branch trên GitHub có thể đã bị xóa — clone lại sẽ mất.
   `/opt` và `/home` cùng filesystem `/`, nên `mv` là thao tác đổi tên inode: tức thời,
   không nhân đôi 114 M cache ảnh, giữ nguyên toàn bộ `.git`.
2. **Không bao giờ chạy `docker compose down -v`.** Cờ `-v` xóa named volume, tức là mất
   sạch Postgres. Chỉ dùng `down` trần.
3. **Giữ nguyên `name: blueflare`** trong compose. Đổi tên project → compose tạo volume mới
   `<tên>_postgres18-data` và bỏ lại dữ liệu cũ.
4. **Có điểm quay lui ở mọi bước.** Tar toàn bộ stack (138 M) + dump Postgres trước khi đụng gì.

## Downtime

Một cửa sổ khoảng **1–3 phút** ở Phase 3, vì bind mount `data/images` không thể dời khi
container đang giữ. Các phase khác chạy nóng, không ảnh hưởng.

## Bảng phân chia

### Ở lại `/opt/docker/stacks/blueflare` (runtime — 114 M)

| Nguồn hiện tại | Đích | Lý do |
|---|---|---|
| `backend/compose.yml` | `compose.yml` | file vận hành; `deploy/*.sh` vốn đã mặc định `$STACK_DIR/compose.yml` |
| `backend/.env` | `.env` (chmod 600) | secret, không vào git |
| `backend/.env.bak-20260818T154014` | `.env.bak-20260818T154014` | bản lùi cấu hình |
| `backend/deploy/` | `deploy/` | `apply-env.sh` tự suy `STACK_DIR` = `$(dirname)/..` → tự đúng sau khi dời |
| `backend/data/` | `data/` | 114 M cache ảnh đã ký — state runtime, không tái tạo miễn phí |
| `backend/.env.example` | `.env.example` → **symlink** vào codebase | `apply-env.sh` đọc `$STACK_DIR/.env.example` để validate; symlink giữ nó luôn khớp repo |

### Dời về `/home/ubuntu/blueflare` (codebase — ~24 M)

Toàn bộ phần còn lại: `.git/`, `.gitignore`, `.dockerignore`, `Dockerfile.frontend`,
`src/`, `components/`, `lib/`, `public/`, `scripts/`, `docs/`, `package*.json`,
`tsconfig.json`, `next.config.ts`, `postcss.config.mjs`, `vitest.config.ts`,
`next-env.d.ts`, `theme.css`, `tokens.json`, `variables.css`, `.env.example` (bản 3 dòng
của frontend), `AGENTS.md`, `CLAUDE.md`, `DESIGN.md`, `README.md`, `design-qa.md`,
`blueflare-desktop-ui-design/`, `blueflare-mobile-ui-design/`, `.astro/`, `.codex/`, `.claude/`,
và trong `backend/`: `src/`, `migrations/`, `test/`, `Dockerfile`, `.dockerignore`,
`package*.json`, `.env.example`, `README.md`.

## compose.yml — các thay đổi

```yaml
# 1. api và worker: context trỏ ra codebase
  api:
    build:
      context: ${BLUEFLARE_SRC:-/home/ubuntu/blueflare}/backend
  worker:
    build:
      context: ${BLUEFLARE_SRC:-/home/ubuntu/blueflare}/backend

# 2. frontend: context là gốc repo
  frontend:
    build:
      context: ${BLUEFLARE_SRC:-/home/ubuntu/blueflare}
      dockerfile: Dockerfile.frontend

# 3. image-cache-init: bỏ build hẳn, chỉ để mkdir/chown thì không cần dựng image backend.
#    Lưu ý: alpine không có user `node`, phải chown bằng uid/gid số.
#    1000:1000 là uid/gid của user `node` trong node:22-bookworm-slim.
  image-cache-init:
    image: alpine:3
    restart: "no"
    user: "0:0"
    command: ["sh", "-c", "mkdir -p /data/images && chown -R 1000:1000 /data/images"]
    volumes:
      - ${IMAGE_CACHE_HOST_DIR:-./data/images}:/data/images
```

Đổi trong `.env`:
```
IMAGE_CACHE_HOST_DIR=/opt/docker/stacks/blueflare/data/images   # bỏ /backend
BLUEFLARE_SRC=/home/ubuntu/blueflare                            # thêm mới
```

Không đổi: `name: blueflare`, toàn bộ khối `volumes:`, `networks:`, port mapping,
healthcheck, `env_file: ${BLUEFLARE_ENV_FILE:-.env}` (vẫn phân giải tương đối theo
thư mục chứa compose file → gốc stack, đúng chỗ `.env` mới).

Không cần đụng: Caddy (chỉ `reverse_proxy` sang 127.0.0.1:3100/3200, không tham chiếu
filesystem), systemd, cron — đã kiểm tra, không có gì trỏ vào đường dẫn stack.

## Các phase

### Phase 0 — Chốt điểm quay lui (chạy nóng, không downtime)
1. `git add -A && git commit` cho 4 thay đổi đang dở (`.gitignore`, `README.md`,
   `backend/README.md`, `docs/adr/`), rồi `git push origin main`.
2. `git bundle create /opt/docker/backups/blueflare/all-branches-<stamp>.bundle --all`
   — gói mọi branch kể cả branch chưa lên remote, phòng khi `.git` hỏng giữa chừng.
3. `backend/deploy/backup-postgres.sh` → dump vào `/opt/docker/backups/blueflare/postgres/`.
4. `tar czf /opt/docker/backups/blueflare/stack-<stamp>.tar.gz -C /opt/docker/stacks blueflare`
   (138 M) — ảnh chụp toàn bộ layout cũ.
5. `docker compose -f backend/compose.yml config > /opt/docker/backups/blueflare/config-before.yml`
   — bản chuẩn để đối chiếu ở Phase 4.

### Phase 1 — Dựng codebase ở /home/ubuntu/blueflare (chạy nóng)
6. `/home/ubuntu/blueflare` hiện chỉ có `.claude/` — gộp vào chứ không ghi đè.
7. `mv` mọi mục trong bảng "dời về codebase" sang `/home/ubuntu/blueflare`,
   **trừ** 6 mục runtime. Stack lúc này vẫn chạy bình thường vì container dùng image
   đã build sẵn, không bind-mount source.
8. `git -C /home/ubuntu/blueflare status` — xác nhận repo nguyên vẹn, `git worktree list`
   chỉ còn một entry trỏ đúng đường dẫn mới.

### Phase 2 — Dựng layout runtime (chạy nóng)
9. `mv backend/compose.yml`, `backend/.env`, `backend/.env.bak-*`, `backend/deploy`
   lên gốc stack. `chmod 600 .env`.
10. `ln -s /home/ubuntu/blueflare/backend/.env.example /opt/docker/stacks/blueflare/.env.example`
11. Sửa `compose.yml` và `.env` theo mục trên.

### Phase 3 — Dời cache ảnh (⚠ cửa sổ downtime duy nhất)
12. `docker compose down` **(không có `-v`)**.
13. `mv backend/data /opt/docker/stacks/blueflare/data` — tức thời, cùng filesystem.
14. `rmdir backend` — thư mục phải rỗng; nếu còn sót gì thì dừng lại xem là gì.

### Phase 4 — Kiểm tra khô rồi bật lại
15. `docker compose config > config-after.yml`, `diff config-before.yml config-after.yml`.
    Khác biệt **duy nhất được phép**: 3 đường dẫn build context, khối image-cache-init,
    và đường dẫn bind mount `data/images`. Bất kỳ thay đổi nào ở volume name, project
    name, port, hay env → dừng và tìm hiểu.
16. `docker compose up -d --no-build` — bật lại từ image cũ, chưa build. Cô lập rủi ro
    "layout sai" khỏi rủi ro "build hỏng".
17. Xác nhận 5 service `healthy`; `curl 127.0.0.1:3200/api/health` và `127.0.0.1:3100/healthz`;
    mở một ảnh qua `img.bluesia.net` để chắc bind mount mới phục vụ đúng cache cũ.

### Phase 5 — Xác nhận đường build mới
18. `docker compose build` — chứng minh context trỏ sang `/home/ubuntu/blueflare` build được.
19. `docker compose up -d`, kiểm tra lại health như bước 17.
20. `backend/deploy/apply-env.sh` (nay là `deploy/apply-env.sh`) — chạy để xác nhận script
    vận hành còn đúng sau khi dời.

### Phase 6 — Dọn và ghi lại
21. Chỉ khi Phase 5 xanh: xóa `config-before/after.yml` tạm; giữ tarball ít nhất 1 tuần.
22. Trong codebase: copy `compose.yml` đã sửa vào `deploy/compose.yml` làm bản chuẩn của repo,
    ghi rõ trong README rằng bản vận hành nằm ở stack và được đồng bộ có chủ đích.
23. Cập nhật `README.md` + `docs/FILE_MAP.md`: quy trình deploy hai chỗ
    (`git pull` ở `/home/ubuntu/blueflare` → `docker compose up -d --build` ở stack).
24. Đổi `Status: Proposed` → `Accepted` trong ADR-001.

## Rủi ro và cách chặn

| Rủi ro | Chặn bằng |
|---|---|
| Mất DB do `down -v` hoặc đổi project name | Nguyên tắc 2 + 3; dump ở bước 3; diff config ở bước 15 |
| Mất branch chưa push | Dùng `mv` thay clone; thêm `git bundle --all` ở bước 2 |
| Sai đường dẫn cache ảnh → ảnh 404 hàng loạt | Bước 15 diff bind mount; bước 17 test ảnh thật |
| `chown node:node` fail vì alpine không có user `node` | Dùng `1000:1000` dạng số |
| Build hỏng vì context mới thiếu file | Tách bước 16 (no-build) khỏi 18 (build); `.dockerignore` đi cùng source nên vẫn áp dụng |
| Script deploy trỏ sai chỗ | `apply-env.sh` tự suy `STACK_DIR`; chạy thật ở bước 20 để xác nhận |
