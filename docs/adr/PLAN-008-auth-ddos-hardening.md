# PLAN-008 — Chống DDoS/lạm dụng cho login và signup

Trạng thái: **ĐANG CÀI ĐẶT (2026-09-30).** Phát sinh từ audit cùng ngày. Chưa deploy.

## 1. Bằng chứng (đo trên VPS 4 nhân)

- 1 lần scrypt = 56 ms; tối đa ~76 lần/giây cho cả máy.
- Trong lúc 200 verify đồng thời chạy, `fs.stat` chờ **2,6 s**: scrypt dùng chung threadpool libuv (4 luồng)
  với đọc/ghi image cache và `sharp`, nên flood login làm đứng luôn ảnh của `img.bluesia.net`.
- Khoá `loginLimiter` là `IP|email`: một IP đổi email liên tục không bị chặn; nhiều IP thử một email cũng không bị chặn chung.

## 2. Các lỗ hổng cần đóng

| # | Mức | Vấn đề | Cách đóng | Ai làm |
|---|---|---|---|---|
| 1 | Cao | Không giới hạn số lần hash chạy đồng thời | Semaphore cho hash/verify, hàng đợi có hạn, đầy thì 503 + `Retry-After` ngay; `UV_THREADPOOL_SIZE=8` cho api | Phase 1 |
| 2 | TB | Không đếm theo IP riêng, không đếm theo email | Thêm limiter IP-only (login) và email-only (login, toàn cục); giữ limiter `IP\|email` | Phase 1 |
| 3 | TB | Cloudflare chưa có luật cho `/api/auth/*`; 443 mở thẳng | Luật rate limit Cloudflare (file JSON + hướng dẫn, Steve áp); Caddy chỉ nhận `/api/auth/*` từ dải Cloudflare | Phase 3 (file/script), Steve (áp) |
| 4 | Thấp | Đăng ký spam làm đầy `users` | Trần đăng ký toàn cục/giờ (429), email tối đa 254 ký tự đã có; Turnstile để dành (cần key của Steve) | Phase 1 |
| 5 | Thấp | Bộ đếm mất khi restart; login sai giữ kết nối tới 5 s | Đếm bằng Valkey (INCR+EXPIRE), rơi về bộ nhớ khi Valkey lỗi (fail-open có log); thay `sleep` bằng khoá 429 + `Retry-After` không giữ kết nối | Phase 1 |

## 3. Thiết kế chi tiết

### 3.1 Giới hạn hash đồng thời (`backend/src/auth.js`)
- `HashGate`: tối đa `AUTH_HASH_CONCURRENCY` (mặc định 2) hash chạy cùng lúc, hàng đợi tối đa `AUTH_HASH_QUEUE` (mặc định 16).
- Hàng đợi đầy hoặc chờ quá 3 s: ném lỗi `overloaded` -> `meApi` trả `503 {"error":"busy"}` + `Retry-After: 2`.
- Bọc `hashPassword`, `verifyPassword`, `dummyVerify` (qua một hàm dùng chung); đường không hash (session GET) không bị ảnh hưởng.
- `UV_THREADPOOL_SIZE=8` thêm vào `environment:` của `api` trong `deploy/compose.yml`. Thêm biến `AUTH_*` vào `backend/.env.example` **và** `.env` của stack (`apply-env.sh` bắt buộc); đặt mặc định trong code để không hỏng khi thiếu.

### 3.2 Bộ đếm (`backend/src/authLimits.js`, mới)
Giao diện: `take(bucket, key, limit, windowSec) -> {allowed, retryAfterSeconds}`.
- Backend Valkey: `INCR` + `EXPIRE` lần đầu (cửa sổ cố định), khoá `auth:rl:<bucket>:<sha256(key)>` (không lưu email/IP thô).
- Lỗi Valkey hoặc timeout >100 ms: dùng `RateLimiter` trong bộ nhớ hiện có (fail-open có log), không được làm hỏng login.
- Các bucket: `login-ip` 30/15 phút; `login-email` 20/giờ (toàn cục, key = sha256 email chuẩn hoá); `login-ip-email` 10/15 phút (giữ); `register-ip` 5/giờ (giữ); `register-global` 300/giờ (`AUTH_REGISTER_GLOBAL_PER_HOUR`).
- Khoá theo email chỉ đếm khi có lần **sai** để kẻ phá không khoá được chủ tài khoản bằng request đúng; nhưng vì kẻ tấn công chọn được email nạn nhân, đặt trần đủ cao (20/giờ) và luôn cho đăng nhập đúng từ IP đã từng thành công thì phức tạp, nên **không** làm; chấp nhận rủi ro khoá tạm 1 giờ, ghi vào tài liệu.
- Thay `sleep` trong `login` bằng: sau 5 lần sai liên tiếp của `IP|email`, trả 429 + `Retry-After` theo `failureDelayMs` mà không giữ kết nối.
- Lưu ý `Cache-Control: no-store` giữ nguyên trên mọi phản hồi 429/503.

### 3.3 Proxy Next (`lib/account-proxy.ts`)
- Chuyển tiếp `Retry-After` và mã 429/503 của api tới trình duyệt (kiểm tra hiện đã làm chưa). Form (`AuthForm`) hiện thông báo tiếng Việt cho 429 ("Thử quá nhiều lần, thử lại sau N giây") và 503 ("Hệ thống đang bận, thử lại sau ít giây"). Không thêm giới hạn nào ở tầng Next (Cloudflare và api đã đủ).

### 3.4 Hạ tầng (Steve áp, agent chỉ chuẩn bị file)
- `deploy/cloudflare-auth-ratelimit-rule.json`: rate limit `http.host eq "phim.bluesia.net" and starts_with(http.request.uri.path, "/api/auth/")`, 10 request/phút/IP, chặn 10 phút. Kèm hướng dẫn 5 dòng trong `docs/CLOUDFLARE_CACHE.md` và bật Bot Fight Mode.
- Caddy trong `deploy/bootstrap-vps.sh` (khối `phim.bluesia.net`): matcher `@authdirect { path /api/auth/* ; not remote_ip <dải Cloudflare> }` -> `respond 403`. Chỉ áp cho `/api/auth/*` để dải IP lỗi thời không làm sập cả site. Dải IP lấy từ danh sách đã hardcode trong `lib/account-proxy.ts`. **Không reload Caddy live**; Steve yêu cầu riêng (Caddyfile đang chạy phải sửa tay như lần `@account`).
- Firewall cổng 443 chỉ cho Cloudflare cần sudo: chỉ ghi vào tài liệu như khuyến nghị, không làm.

## 4. Phân công (mô hình + effort)

| Phase | Việc | Agent | Mô hình / effort |
|---|---|---|---|
| 1 | `HashGate`, `authLimits.js` (Valkey + fallback), limiter mới, bỏ sleep, trần đăng ký toàn cục, `UV_THREADPOOL_SIZE`, env, test (gồm test tải: 200 verify đồng thời thì `fs.stat` không chờ quá 500 ms) | backend-implementer | sonnet / high (đường xác thực, sai là mất bảo mật) |
| 2 | `account-proxy` chuyển tiếp 429/503 + `Retry-After`, `AuthForm` thông báo, test | frontend-implementer | sonnet / low |
| 3 | Rule Cloudflare JSON, khối Caddy `@authdirect` trong `bootstrap-vps.sh`, tài liệu hướng dẫn Steve | claude | sonnet / low |
| 4 | Rà bảo mật đường mới (fail-open có bị lợi dụng không, khoá email có bị lạm dụng không, không lộ email/IP trong Valkey/log) | invariant-reviewer + skill `security-review` | sonnet / medium |
| 5 | Tài liệu (CLAUDE.md, backend/README, docs/OBSERVABILITY nếu có metric), verify | doc-drift-auditor, verifier | sonnet / low |

Phase 1 và 2 chạy song song (không chung file); 3 chạy song song với chúng; 4 và 5 chạy sau cùng.

## 5. Deploy và việc của Steve
- `scripts/deploy.sh` (api + frontend); có biến env mới nên `apply-env.sh` yêu cầu `.env` của stack có đủ key.
- Steve: áp rule Cloudflare, bật Bot Fight Mode, và yêu cầu riêng khi muốn agent sửa Caddyfile live rồi reload.

## 6. Rủi ro
- Fail-open khi Valkey lỗi: mất bộ đếm chia sẻ nhưng còn bộ đếm bộ nhớ và `HashGate`; chấp nhận.
- Khoá theo email cho phép kẻ xấu khoá tạm tài khoản người khác 1 giờ; đổi lại chặn được tấn công phân tán. Chấp nhận, ghi tài liệu.
- Trần đăng ký toàn cục có thể chặn người dùng thật khi bị spam; trần 300/giờ đủ rộng với quy mô hiện tại.
- `HashGate` làm login chậm hơn khi tải cao nhưng luôn có trần chờ 3 s.
