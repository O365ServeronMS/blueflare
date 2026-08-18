# ADR-001: Tách thư mục runtime của stack Docker khỏi codebase

**Status:** Accepted
**Date:** 2026-08-18
**Deciders:** chủ VPS / maintainer Blueflare

## Context

Hôm nay `/opt/docker/stacks/blueflare` **chính là** working tree của git repo
`O365ServeronMS/blueflare`. Toàn bộ mã nguồn, node_modules, build cache và cả
worktree của trợ lý AI đều nằm trong thư mục vốn chỉ nên chứa cấu hình vận hành.
`/home/ubuntu/blueflare` hiện đang **rỗng** (chỉ có `.claude/`).

Đo thực tế — 4.2 GB trong thư mục stack:

| Thành phần | Dung lượng | Cần để chạy? |
|---|---|---|
| `.claude/worktrees/` (7 worktree, không nằm trong .gitignore) | 3.9 G | Không |
| `backend/data/images/` (cache ảnh đã ký) | 114 M | **Có** — state runtime |
| `.next/`, `node_modules/`, `backend/node_modules/`, `dist/`, `tsconfig.tsbuildinfo` | ~160 M | Không (build lại được) |
| `.git/` | 17 M | Không |
| `docs/`, `blueflare-*-ui-design/`, `src/`, `components/`, `lib/`, `backend/src/` | ~10 M | Chỉ lúc **build** |
| `backend/compose.yml`, `backend/.env`, `backend/deploy/` | < 100 K | **Có** |

Các lực ràng buộc:

1. **Compose đang build từ source tại chỗ.** `backend/compose.yml` khai báo
   `build: context: .` (api, worker, image-cache-init) và
   `build: context: ..`, `dockerfile: Dockerfile.frontend` (frontend). Không thể
   chỉ để lại `compose.yml` mà bỏ mã nguồn đi — trừ khi đổi sang image dựng sẵn.
2. **Compose file đang nằm sai chỗ.** `deploy/backup-postgres.sh:6` và
   `deploy/apply-env.sh:12` đều mặc định `COMPOSE_FILE=$STACK_DIR/compose.yml`,
   tức là **gốc stack**, trong khi file thật nằm ở `backend/compose.yml`.
   Hai script này đang chạy được là nhờ biến override, không nhờ layout.
3. **State thật phải giữ nguyên.** Volume `blueflare_postgres18-data`,
   `blueflare_valkey-data` (gắn với `name: blueflare`), và bind mount
   `IMAGE_CACHE_HOST_DIR=/opt/docker/stacks/blueflare/backend/data/images`.
4. **Không có CI.** Repo không có `.github/workflows`; build đang chạy tay trên VPS.
5. **`backend/.env` chứa bí mật** (TMDB_API_KEY, POSTGRES_PASSWORD,
   IMAGE_SIGNING_SECRET, METRICS_TOKEN) và phải ở lại phía runtime, không vào repo.

## Decision

Chuyển `/opt/docker/stacks/blueflare` thành **thư mục runtime thuần** — chỉ chứa
compose file, `.env`, script vận hành và dữ liệu bind-mount. Mã nguồn dời hẳn về
`/home/ubuntu/blueflare` và ở yên đó. Compose **build từ xa** bằng build context
trỏ tới codebase qua biến môi trường, chưa cần registry.

Layout đích của `/opt/docker/stacks/blueflare` (~114 M, gần như toàn bộ là cache ảnh):

```
/opt/docker/stacks/blueflare/
├── compose.yml            # dời từ backend/compose.yml, sửa build context
├── .env                   # dời từ backend/.env (chmod 600)
├── .env.example           # bản tham chiếu, symlink hoặc copy từ repo
├── deploy/                # apply-env.sh, backup-postgres.sh, *.caddy, cloudflare-*.json
└── data/images/           # bind mount cache ảnh (114 M, dời từ backend/data/images)
```

Codebase `/home/ubuntu/blueflare`: git clone đầy đủ, là **nguồn duy nhất** của
`Dockerfile.frontend`, `backend/Dockerfile`, `src/`, `backend/src/`, `migrations/`, `docs/`.

## Options Considered

### Option A: Registry — build ở nơi khác, VPS chỉ `pull`

`compose.yml` chỉ dùng `image: ghcr.io/o365serveronms/blueflare-{api,frontend}:<tag>`,
bỏ hẳn khối `build:`.

| Dimension | Assessment |
|---|---|
| Complexity | Cao — cần CI hoặc quy trình build/push tay, đăng nhập GHCR trên VPS |
| Cost | Free ở GHCR cho repo private ở mức hiện tại; thêm chi phí thời gian dựng CI |
| Scalability | Tốt nhất — nhiều host, rollback theo tag, build không chiếm CPU/RAM VPS |
| Team familiarity | Chưa có CI nào trong repo, tức là làm mới từ đầu |

**Pros:** tách bạch tuyệt đối; VPS không cần source lẫn toolchain; rollback bằng đổi tag; build không làm nghẽn VPS.
**Cons:** phải dựng CI hoặc thao tác push tay trước *mỗi* lần deploy; sửa nóng một dòng code cũng phải qua vòng build-push-pull; thêm secret registry cần quản lý.

### Option B: Build context tuyệt đối trỏ về codebase (khuyến nghị)

`compose.yml` ở gốc stack, khối `build:` giữ nguyên nhưng context trỏ ra ngoài:

```yaml
x-src: &src ${BLUEFLARE_SRC:-/home/ubuntu/blueflare}

  api:
    build:
      context: ${BLUEFLARE_SRC:-/home/ubuntu/blueflare}/backend
  frontend:
    build:
      context: ${BLUEFLARE_SRC:-/home/ubuntu/blueflare}
      dockerfile: Dockerfile.frontend
```

| Dimension | Assessment |
|---|---|
| Complexity | Thấp — sửa đường dẫn, dời 3 thứ, không thêm hạ tầng |
| Cost | 0 |
| Scalability | Đủ cho một host; muốn thêm host thứ hai thì nâng lên Option A |
| Team familiarity | Y hệt quy trình hiện tại, chỉ khác chỗ đứng |

**Pros:** đạt đúng mục tiêu (stack ~114 M, codebase ở `/home/ubuntu/blueflare`); giữ nguyên `docker compose up -d --build`; không secret mới; đường nâng cấp lên Option A sau này chỉ là thay `build:` bằng `image:`.
**Cons:** stack vẫn *phụ thuộc* vào codebase lúc build (không tự chứa); `compose.yml` gắn với đường dẫn của host này (đã giảm nhẹ bằng biến `BLUEFLARE_SRC`); build vẫn ăn CPU/RAM của VPS.

### Option C: Giữ nguyên layout, chỉ dọn rác

Xóa `.claude/worktrees` (3.9 G), `.next`, `node_modules`, `dist`, thêm vào `.gitignore`.

| Dimension | Assessment |
|---|---|
| Complexity | Rất thấp |
| Cost | 0 |
| Scalability | Không cải thiện |
| Team familiarity | Không đổi gì |

**Pros:** thu ngay 4.2 G → ~300 M trong vài phút, rủi ro gần bằng không.
**Cons:** **không đáp ứng yêu cầu** — codebase vẫn nằm trong thư mục stack, `.claude/worktrees` sẽ phình lại sau vài phiên làm việc, `.env` chứa secret vẫn nằm cạnh git tree.

## Trade-off Analysis

Trục quyết định thật sự là **mức độ tự chứa của thư mục stack** đổi lấy **độ ma sát khi deploy**.

Option A tự chứa hoàn toàn nhưng đặt một vòng build-push-pull vào giữa mỗi thay đổi — với một VPS đơn, một maintainer, chưa có CI, cái giá đó trả trước mà lợi ích (multi-host, rollback theo tag) thì chưa dùng đến.

Option C rẻ nhất nhưng không giải quyết vấn đề đã nêu; nó chỉ là *một phần* của A và B, nên xử lý như bước dọn dẹp bắt buộc chứ không phải phương án.

Option B lấy phần lớn giá trị của A — thư mục stack sạch, có thể backup và audit độc lập, secret tách khỏi git tree — với chi phí gần bằng C. Chỗ thỏa hiệp: stack không tự chạy lại được nếu mất `/home/ubuntu/blueflare`. Điều này chấp nhận được vì repo có remote trên GitHub, khôi phục bằng một lệnh `git clone`; còn thứ *không* clone lại được (Postgres volume, cache ảnh, `.env`) thì sau khi tách sẽ nằm gọn trong thư mục stack — chính là thứ cần backup.

Chốt **Option B**, và coi Option A là đích đến khi nào có host thứ hai hoặc có CI.

## Consequences

**Dễ hơn:**
- Backup thư mục stack = backup đúng thứ không tái tạo được (`.env`, `data/images`, `deploy/`), không lẫn 4 G rác.
- `.claude/worktrees` phình ra bao nhiêu cũng chỉ ảnh hưởng `/home/ubuntu`, không đụng `/opt/docker`.
- `deploy/apply-env.sh` và `backup-postgres.sh` hết lệch đường dẫn — `$STACK_DIR/compose.yml` cuối cùng cũng trỏ đúng file thật.
- Secret trong `.env` không còn nằm trong cùng cây thư mục với git working tree.

**Khó hơn:**
- Deploy thành hai chỗ: `git pull` ở `/home/ubuntu/blueflare`, rồi `docker compose up -d --build` ở `/opt/docker/stacks/blueflare`.
- `compose.yml` giờ tồn tại ở hai nơi (bản vận hành ở stack, bản tham chiếu trong repo) — phải chọn một bản là chính. Đề xuất: bản trong repo là nguồn, deploy bằng cách copy có chủ đích, ghi rõ trong README.
- Đường dẫn build context tuyệt đối làm `compose.yml` bớt tính di động.

**Cần xem lại:**
- Khi có host thứ hai hoặc CI → chuyển sang Option A.
- `image-cache-init` hiện `build: context: .` chỉ để chạy `mkdir`/`chown`; thay bằng `image: alpine:3` sẽ bỏ được một phụ thuộc build không cần thiết.
- `.astro/`, `.codex/`, `dist/`, `blueflare-*-ui-design/` là tàn dư của kiến trúc Astro cũ — cần xác nhận còn dùng không trước khi mang sang codebase mới.

## Action Items

Chưa thực thi gì — đây là bản đề xuất. Thứ tự dưới đây giữ cho stack luôn khởi động lại được ở mỗi bước.

1. [ ] **Dọn rác trước** (thu ~4 G, chưa đụng gì đang chạy):
       xóa `.claude/worktrees/`, `.next/`, `node_modules/`, `backend/node_modules/`, `dist/`, `.astro/`, `tsconfig.tsbuildinfo`;
       thêm `.claude/`, `.astro/`, `.codex/` vào `.gitignore`.
2. [ ] **Commit 2 file đang dở** (`README.md`, `backend/README.md` đang ở trạng thái `M`) rồi `git push` — đảm bảo GitHub có đủ trước khi dời.
3. [ ] **Backup Postgres** bằng `deploy/backup-postgres.sh`, và `tar` thư mục `backend/data/images` — chốt điểm quay lui.
4. [ ] **Clone codebase** về `/home/ubuntu/blueflare` từ remote (không phải `mv`, để bản cũ nguyên vẹn làm phao).
5. [ ] **Dựng layout runtime**: `mv backend/compose.yml` → gốc stack; `mv backend/.env` → gốc stack (`chmod 600`);
       `mv backend/deploy` → gốc stack; `mv backend/data` → gốc stack;
       cập nhật `IMAGE_CACHE_HOST_DIR=/opt/docker/stacks/blueflare/data/images` trong `.env`.
6. [ ] **Sửa `compose.yml`**: thêm `BLUEFLARE_SRC`, đổi `context` của `api`/`worker` thành `${BLUEFLARE_SRC}/backend`,
       của `frontend` thành `${BLUEFLARE_SRC}` với `dockerfile: Dockerfile.frontend`;
       đổi `image-cache-init` sang `image: alpine:3`.
       **Giữ nguyên `name: blueflare`** — đổi tên project sẽ làm compose tạo volume mới và mất dữ liệu Postgres.
7. [ ] **Kiểm tra khô**: `docker compose config` ở gốc stack, đối chiếu mọi đường dẫn và volume với bản đang chạy.
8. [ ] `docker compose up -d --build`, xác nhận cả 5 service `healthy` và ảnh trong cache vẫn phục vụ được.
9. [ ] **Chỉ khi xong bước 8** mới xóa mã nguồn còn lại trong thư mục stack.
10. [ ] Cập nhật `README.md` + `docs/FILE_MAP.md`: quy trình deploy hai chỗ, và bản `compose.yml` trong repo là nguồn.
