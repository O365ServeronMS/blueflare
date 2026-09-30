# PLAN-006 — Tài khoản, yêu thích đồng bộ, hàng "Phim đang xem"

Trạng thái: **ĐÃ CÀI ĐẶT (2026-09-30), CHƯA COMMIT/DEPLOY.** Phase 0–7 xong; `scripts/verify.sh` 11/11 qua.

> Phần tiến độ/resume/hàng "Phim đang xem" đã bị thay bởi PLAN-007 (lịch sử theo tập); phần tài khoản, yêu thích, đồng bộ vẫn giữ.
Chưa làm: chạy thử migration 020 trên DB tạm, áp rule `@account` vào Caddyfile đang chạy, kiểm thử trình duyệt thật (nav, form, vạch đỏ, resume), deploy. Backend gap đã bù bằng `GET /api/cards`.
Ngày lập: 2026-09-30.

## 1. Mục tiêu

Thay nút Settings bằng nút đăng nhập/đăng ký. User đăng nhập được lưu **yêu thích** và
**phim đang xem dở** trên server. Trang chủ hiện hàng "Phim đang xem" phía trên "Phim đang
được xem nhiều"; poster phim xem dở có vạch đỏ ở mép dưới thể hiện % đã xem, bấm vào để xem tiếp.

## 2. Quyết định đã chốt (Steve, 2026-09-30)

| Chủ đề | Quyết định |
|---|---|
| Đăng nhập | Email + mật khẩu, tự quản trong PostgreSQL, session cookie httpOnly |
| Dữ liệu localStorage cũ | Gộp vào tài khoản ở lần đăng nhập đầu; khách chưa login vẫn dùng localStorage |
| Đo tiến độ | Chỉ player đọc được thời gian (HLS/native). iframe embed: không vạch %, không resume |
| Phim bộ | Một thẻ mỗi phim, theo tập gần nhất; vạch đỏ = % tập đó; >=90% là xong -> gợi ý tập kế, hết bộ thì ẩn |

Đã chốt thêm: xoá trang `/settings`; toàn bộ phase dùng sonnet (việc nhẹ effort low).

Ngoài phạm vi: reset mật khẩu (cần SMTP), OAuth, Turnstile (cân nhắc sau).

## 3. Ràng buộc kiến trúc (từ CLAUDE.md)

- Trang chủ được cache (tag Next + Valkey); cache key **không được** phụ thuộc cookie ->
  hàng "Phim đang xem" là **client component** lấy dữ liệu sau hydrate, Server Component không đọc cookie.
- Mọi response `/api/auth/*`, `/api/me/*` phải `Cache-Control: no-store`, không qua Valkey/Cloudflare cache.
- Trình duyệt không gọi API trực tiếp; đi qua route handler Next cùng origin, cookie đặt trên `phim.bluesia.net`.
- Không autoplay/mount iframe trước khi user bấm Play (resume chỉ là gợi ý, vẫn chờ Play).
- Giữ `returnTo` đúng quy ước `lib/navigation.ts`; không thêm hash fragment.
- Thêm key vào `backend/.env.example` thì phải thêm vào `.env` của stack (`apply-env.sh`).
- Không deploy/restart/sync stack trừ khi Steve yêu cầu; agent không tự deploy được (hook).

## 4. Phân công theo phase (mô hình + effort)

Nguyên tắc: **lý luận tốn kém chỉ ở chỗ sai là mất tiền/bảo mật** (auth, migration, CSRF,
đường ghi tiến độ). Phần cơ học/UI/test/tài liệu dùng mô hình rẻ. Mỗi phase dùng agent
sẵn có; `model` được truyền khi gọi Agent, effort là mức suy luận đề xuất.

| Phase | Việc | Agent | Mô hình | Effort | Lý do |
|---|---|---|---|---|---|
| 0 | Chốt hợp đồng API (JSON shape, mã lỗi) ghi vào mục 6 của file này | (điều phối/Steve duyệt) | sonnet | medium | Một lần, quyết định giao diện giữa 3 phase sau |
| 1 | Migration 020 + `auth.js` + endpoint auth/me + test backend | `backend-implementer` | **sonnet** | **high** | Băm mật khẩu, session, rate-limit: sai là lỗ hổng |
| 2 | Route handler Next proxy `/api/auth/*`, `/api/me/*`, cookie, kiểm tra Origin | `frontend-implementer` | **sonnet** | **medium** | Bảo mật vừa phải, khuôn mẫu rõ, đã có hợp đồng ở Phase 0 |
| 3 | UI: đổi nút Settings -> User icon + menu, trang `/login`, `/signup` | `frontend-implementer` | **sonnet** | low | Form + điều hướng theo mẫu có sẵn |
| 4 | Lớp lưu trữ 2 backend (localStorage/API) thay `LocalMovieActions`, import lần đầu, `/favorites`, `/history` | `frontend-implementer` | **sonnet** | medium | Logic đồng bộ + gộp dữ liệu dễ sai tinh vi |
| 5 | Ghi tiến độ trong `HlsVideo`/native (timeupdate, debounce, beacon), gợi ý resume | `frontend-implementer` | **sonnet** | **high** | Vòng đời trình duyệt (pagehide, seek, đổi tập) khó; ảnh hưởng playback |
| 6 | `ContinueWatchingRow` + prop `progress` trên `MovieCard` (vạch đỏ #e4312a) | `frontend-implementer` | **sonnet** | low | Thuần trình bày; không đổi cấu trúc tải ảnh |
| 7a | Chạy `scripts/verify.sh`, báo lỗi | `verifier` | sonnet | low | Chỉ chạy lệnh và đọc kết quả |
| 7b | Duyệt invariant (cache, cookie, ảnh, playback) | `invariant-reviewer` | sonnet | medium | Cần phán đoán đúng/sai so với quy tắc |
| 7c | Rà tài liệu bị lệch | `doc-drift-auditor` | sonnet | low | So khớp văn bản |
| 7d | Sửa tài liệu theo báo cáo 7c (CLAUDE.md, backend/README, FILE_MAP, CLOUDFLARE_CACHE) | `claude` | sonnet | low | Chỉnh văn bản |
| 7e | Commit/merge/push (khi Steve bảo) | `git-committer` | sonnet | low | Quy trình cố định |

Thứ tự và song song:
- Phase 0 -> Phase 1 -> (Phase 2 và Phase 4 phần lớp lưu trữ chạy song song sau khi 1 xong hợp đồng) -> Phase 3 -> Phase 5 -> Phase 6 -> Phase 7.
- Phase 3 và Phase 6 chỉ chạm UI nên có thể chạy song song với Phase 5 (khác file).
- Sau **Phase 1** và **Phase 5**, dừng lại cho Steve/`invariant-reviewer` xem trước khi đi tiếp (hai điểm rủi ro nhất).

Ước lượng token: Phase 1, 5 chiếm phần lớn (~60%) chi phí; Phase 3, 6, 7a, 7c–e dùng sonnet low nên vẫn rẻ.
Toàn bộ kế hoạch dùng sonnet, không dùng haiku (Steve chốt 2026-09-30); việc nhẹ dùng effort low.

## 5. Chi tiết từng phase

### Phase 1 — Backend tài khoản và session
- `backend/migrations/020_users_sessions.sql`:
  - `users(id uuid pk, email citext unique, password_hash, created_at)`
  - `sessions(id, user_id, token_hash, expires_at, created_at)` — chỉ lưu hash token
  - `user_favorites(user_id, movie_id, created_at)` pk `(user_id, movie_id)`
  - `user_watch_progress(user_id, movie_id, episode_key, position_sec, duration_sec, completed, updated_at)` pk `(user_id, movie_id)`
- `backend/src/auth.js`: `crypto.scrypt` (không thêm dependency), token 32 byte, kiểm tra session, rate-limit theo IP + email.
- `server.js`: `POST /auth/register|login|logout`, `GET /me`, `GET/PUT/DELETE /me/favorites`,
  `PUT /me/progress`, `GET /me/continue-watching` (tối đa 20, ẩn phim đã xong và < ~2%),
  `POST /me/import` (tối đa 100 mục mỗi loại, kiểm tra slug, bỏ trùng, idempotent).
- Test `node --test`: băm/kiểm tra mật khẩu, hết hạn session, import idempotent, ngưỡng 90%, giới hạn 20.
- Bảng nằm trong PostgreSQL nên `pg_dump` của service `backup` đã bao phủ.

### Phase 2 — Proxy frontend
- Route handler `/api/auth/*`, `/api/me/*` -> `INTERNAL_CATALOG_URL`; cookie `bf_session` (httpOnly, Secure, SameSite=Lax).
- Kiểm tra `Origin` với request đổi dữ liệu. `no-store` mọi response.
- Kiểm tra Caddy/Cloudflare không cache hai prefix này; cập nhật `docs/CLOUDFLARE_CACHE.md` nếu thêm rule.

### Phase 3 — UI đăng nhập
- `components/GlobalNav.tsx`: thay `Settings` bằng icon `User` (lucide) khi chưa login; `CircleUser`/chữ cái đầu khi đã login; menu: Yêu thích, Lịch sử, Đăng xuất.
- Route `/login`, `/signup` (form Server Component, giữ `returnTo`). **Xoá trang `/settings`** (Steve đã chốt): xoá `src/app/settings/page.tsx`, gỡ `/settings` khỏi `lib/navigation.ts` và `lib/navigation.test.ts`, không để link chết.

### Phase 4 — Đồng bộ yêu thích/lịch sử
- Viết lại `components/LocalMovieActions.tsx` thành lớp lưu trữ 2 backend: khách -> localStorage; đã login -> API + cache cục bộ.
- Sau login lần đầu gọi `/me/import` một lần, đánh dấu đã import.
- `WatchRecorder`, `/favorites`, `/history` đọc qua lớp này.

### Phase 5 — Đo tiến độ
- `HlsVideo.tsx` + native: `timeupdate` debounce 10–15 s; ghi thêm khi `pause`, `visibilitychange`, `pagehide` (`sendBeacon`); gửi `position/duration/episode`.
- Trang phát có tiến độ: hiện "Xem tiếp từ mm:ss", vẫn chờ user bấm Play.
- iframe: chỉ ghi lịch sử.

### Phase 6 — Hàng và vạch đỏ
- `ContinueWatchingRow` (client) đặt trên hàng "Phim đang được xem nhiều" trong `src/app/page.tsx`; chỉ render khi login và có dữ liệu.
- `MovieCard.tsx` nhận `progress?: number` (0–1): vạch đỏ `#e4312a` cao 3px ở mép dưới poster, giữ tỉ lệ ảnh, ảnh vẫn lazy.
- Bấm thẻ -> mở đúng tập + gợi ý resume; >=90% -> tập kế; hết bộ -> ẩn.

### Phase 7 — Kiểm thử, tài liệu
- vitest cho lớp lưu trữ, tính %, ngưỡng; test trình duyệt các luồng đăng ký, đăng nhập, xem dở, vạch đỏ.
- `scripts/verify.sh`, `invariant-reviewer`, `doc-drift-auditor`; cập nhật CLAUDE.md, `backend/README.md`, `docs/FILE_MAP.md`.
- Deploy qua `scripts/deploy.sh` do Steve chạy/cho phép.

## 6. Hợp đồng API (điền ở Phase 0, chưa chốt)

Chốt ở Phase 0 (2026-09-30). Nguyên tắc chung:

- API backend (`/api/auth/*`, `/api/me/*`) **không set cookie**. Đăng nhập trả `token`; route handler Next đặt cookie `bf_session` và gắn `Authorization: Bearer <token>` khi gọi API. Trình duyệt không bao giờ gọi API trực tiếp.
- Mọi response: `Cache-Control: no-store`, JSON UTF-8, không đi qua Valkey. CORS của API giữ nguyên (chỉ GET); các route này chỉ dùng qua Docker network.
- Body JSON tối đa 32 KB. Lỗi: `{ "error": "<code>" }` với mã HTTP tương ứng.
- Phim luôn được định danh bằng `slug` (= `movies.canonical_slug`); không lộ `movies.id`. Tập định danh bằng `episodeKey` (= `episodeWatchKey` trong `lib/episodes.ts`).
- Mật khẩu: 8–128 ký tự. Email chuẩn hoá lowercase + trim. Session sống 30 ngày, trượt (gia hạn khi dùng, tối đa mỗi 1 giờ một lần ghi).

| Endpoint | Request | Response |
|---|---|---|
| `POST /api/auth/register` | `{email,password}` | 201 `{token,expiresAt,user:{id,email}}`; 409 `email_taken`; 422 `invalid_email`/`weak_password` |
| `POST /api/auth/login` | `{email,password}` | 200 như trên; 401 `invalid_credentials` (không phân biệt sai email/mật khẩu) |
| `POST /api/auth/logout` | (Bearer) | 204; xoá session |
| `GET /api/me` | (Bearer) | 200 `{user:{id,email},imported:boolean}`; 401 `unauthorized` |
| `GET /api/me/favorites` | — | 200 `{items:[{slug,savedAt}]}` (mới nhất trước, tối đa 500) |
| `PUT /api/me/favorites/:slug` | — | 204 (idempotent); 404 `unknown_movie` |
| `DELETE /api/me/favorites/:slug` | — | 204 (idempotent) |
| `PUT /api/me/progress` | `{slug,episodeKey,positionSec,durationSec}` | 204; 404 `unknown_movie`; 422 `invalid_progress`. Server tự tính `completed = position/duration >= 0.9`; upsert theo `(user,movie)`; bỏ qua ghi cũ hơn (`updated_at` chỉ tăng) |
| `DELETE /api/me/progress/:slug` | — | 204 (xoá khỏi hàng "đang xem") |
| `GET /api/me/continue-watching` | — | 200 `{items:[{movie:MovieCard,episodeKey,positionSec,durationSec,progress:0..1,updatedAt}]}`; tối đa 20, mới nhất trước; loại bản ghi `progress<0.02`; phim `completed` chỉ hiện nếu còn tập kế thì trả tập kế với `progress:0`, hết bộ thì bỏ |
| `GET /api/me/history` | — | 200 `{items:[{slug,watchedAt}]}` (tối đa 100; lịch sử xem, gồm cả phim iframe không có tiến độ) |
| `PUT /api/me/history/:slug` | — | 204; ghi/đẩy lên đầu |
| `POST /api/me/import` | `{favorites:[{slug,savedAt?}],history:[{slug,savedAt?}]}` (tối đa 100 mỗi loại) | 200 `{favorites:n,history:n,skipped:n}`; idempotent; bỏ slug không tồn tại; đặt `imported=true` |

`MovieCard` trong `continue-watching` cùng shape với thẻ phim của `/api/list` để tái dùng `MovieCard.tsx`.
Cần thêm bảng `user_history(user_id, movie_id, watched_at)` pk `(user_id, movie_id)` vào migration 020 và cột `users.imported_at`.
Rate-limit: đăng nhập 10 lần/15 phút mỗi (IP, email), đăng ký 5 lần/giờ mỗi IP; vượt -> 429 `rate_limited` + `Retry-After`. Sau 5 lần sai liên tiếp, thêm độ trễ đơn điệu, không khoá tài khoản.

## 7. Rủi ro

1. Phần lớn nguồn phát là iframe -> vạch đỏ ban đầu chỉ có ở một phần phim. **Đo tỉ lệ nguồn HLS/native trong catalog trước Phase 5** để kỳ vọng đúng.
2. Đăng ký mở dễ bị spam -> rate-limit ở Phase 1; cân nhắc Turnstile (skill `turnstile-spin`) sau.
3. VPS từng thiếu RAM/CPU (xem memory) -> ghi tiến độ là một `UPSERT` đơn giản mỗi 10–15 s, không qua Valkey.
4. Lớp lưu trữ 2 backend (Phase 4) dễ lệch trạng thái giữa localStorage và server -> test import idempotent và đăng xuất/đăng nhập lại.

## 8. Việc cần Steve quyết

- Duyệt kế hoạch và bảng phân công mô hình ở mục 4.
- (Đã chốt: xoá `/settings`, làm trong Phase 3.)
- Có triển khai ngay từ Phase 0 không.
