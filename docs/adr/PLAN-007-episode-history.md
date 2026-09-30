# PLAN-007 — Bỏ "xem tiếp theo thời gian", lưu lịch sử theo đúng tập

Trạng thái: **ĐÃ DUYỆT (2026-09-30), ĐANG CÀI ĐẶT.**
Thay thế phần "tiến độ %/resume" của PLAN-006; phần tài khoản, yêu thích, đồng bộ giữ nguyên.

## 1. Vì sao

Nguồn phát ép dùng iframe embed. Iframe cross-origin không cho đọc `currentTime`, nên
`user_watch_progress` luôn rỗng (production: 0 dòng), vạch đỏ và "Xem tiếp từ mm:ss" không bao giờ hiện.
Đã thử ưu tiên HLS cho user đăng nhập và đã revert (đổi hành vi player, nhiều nguồn không có m3u8).
Kết luận: bỏ hẳn phần đo thời gian. Cái đo được và có ích là **phim nào, tập nào, server nào**.

## 2. Có lưu chính xác link được không?

Không nên lưu `linkEmbed`/`linkM3u8` của provider: đó là URL do provider sync ghi đè, đổi
khi nguồn đổi CDN, và nằm trong `movie_provider_sources.streams`, không thuộc user.
Lưu **định danh tập trong site**, đủ để dựng lại đúng link phát:

| Trường | Ví dụ | Ghi chú |
|---|---|---|
| `slug` | `house` | đã có (movie.canonical_slug) |
| `server_name` | `Vietsub #1` | tên server, **không** dùng chỉ số: `?server=N` lệch khi provider thêm/bớt server |
| `episode_key` | `tap-5` | đúng `episodeWatchKey()` trong `lib/episodes.ts`, cùng khoá đang dùng ở `?ep=` |
| `episode_name` | `Tập 5` | nhãn hiển thị, để card không phải tải lại chi tiết phim |
| `at` | thời điểm bấm Play | sắp xếp hàng |

Dựng link xem tiếp: `/movie/{slug}?server={index tìm theo server_name}&ep={episode_key}&play=1#player`
(giữ `hrefWithReturnTo`). Nếu server_name không còn: thử server đầu có `episode_key` đó; nếu tập
không còn: rơi về trang phim (không lỗi). `findEpisodeByWatchKey` đã có sẵn logic khớp mềm.

## 3. Khi nào coi là "đang xem tập X"

`WatchRecorder` hiện chạy khi mở khu player, chưa chắc user đã bấm Play. Đề xuất ghi tập **khi user bấm Play**
trong `IframePlayerFacade` (`onClick` → `setIsPlaying(true)`, đã là hành động tường minh theo CLAUDE.md),
và khi mở HLS. Đổi tập = ghi tập mới, ghi đè tập cũ. Không cần biết xem bao lâu.

Hệ quả cần chấp nhận: không biết đã xem xong hay chưa -> không có "tập kế tiếp tự động", không ẩn phim đã hết bộ.

## 4. Dữ liệu

Không tạo bảng mới cho mức tối thiểu; mở rộng `user_history` (một dòng/user/phim, đã có):

```sql
-- 021_history_episode.sql
ALTER TABLE user_history
  ADD COLUMN IF NOT EXISTS server_name  text,
  ADD COLUMN IF NOT EXISTS episode_key  text,
  ADD COLUMN IF NOT EXISTS episode_name text;
DROP TABLE IF EXISTS user_watch_progress;   -- 0 dòng ở production, xác nhận trước khi deploy
```

Cột null = phim lẻ hoặc lịch sử cũ chưa có tập. `ADD COLUMN` nullable an toàn khi api cũ còn chạy.
Tuỳ chọn (Phase 5, cần bạn chọn): bảng `user_episode_watched(user_id, movie_id, server_name, episode_key, watched_at)`
để tô dấu "đã xem" trên các chip tập. Không bắt buộc.

Khách chưa đăng nhập: `StoredMovie` trong localStorage thêm `ep?: { server, key, name }`
(trường tuỳ chọn, dữ liệu cũ vẫn đọc được). Import lần đầu mang theo `ep`.

## 5. Phạm vi gỡ bỏ (xem tiếp / %)

Xoá hẳn, không để code chết:

- Frontend: `lib/progress.ts`, `progress-report.ts`, `continue-watching.ts` (+ test), `components/useProgressReporter.ts`,
  `useContinueItem.ts`, `ResumeActions.tsx`, `ContinueWatchingRow.tsx` (thay ở Phase 3); prop `progress`/`startAtSec` ở `HlsVideo`,
  prop `progress` ở `MovieCard`, `resume=1` và `resumeRequested` ở `MoviePlayer` và `movie/[slug]/page.tsx`.
- Backend (`meApi.js`, `meRepository.js`, `server.js`): `PUT/DELETE /api/me/progress`, `GET /api/me/continue-watching`,
  `upsertProgress`, `deleteProgress`, `listContinueRows`, `streamsForMovies`. Giữ `/api/cards` (hàng lịch sử vẫn cần).
- Migration 021 drop `user_watch_progress`; test `accounts.test.js` bỏ các ca progress.
- Tài liệu: CLAUDE.md, AGENTS.md, FILE_MAP, blueflare-ui-v2, backend/README, backend-architecture, PLAN-006 (thêm dòng "phần tiến độ bị thay bởi PLAN-007").

## 6. Hiển thị (đã chốt)

- **Bỏ hẳn hàng "Phim đang xem"** trên trang chủ (`ContinueWatchingRow` và chỗ gắn ở `src/app/page.tsx`). Trang chủ lại thuần Server Component như trước.
- Trang **Lịch sử**: thẻ phim bộ có nhãn nhỏ "Tập N" (từ `episode_name`), bấm thẻ dẫn thẳng tới đúng tập
  (`?server=&ep=&play=1#player`, vẫn chờ user bấm Play). Phim lẻ không nhãn.
- Trang phim: chip tập xem gần nhất có nhãn "Đang xem" (không tự phát).
- Chỉ lưu tập gần nhất mỗi phim; không có bảng "đã xem" từng tập (Phase 5 bỏ).
- Khách dùng localStorage (`ep` trong `StoredMovie`), user đăng nhập dùng `user_history`. `/api/cards` giữ lại cho trang Lịch sử/Yêu thích.

## 7. Phân công phase (tất cả sonnet)

| Phase | Việc | Agent | Effort |
|---|---|---|---|
| 1 | Backend: migration 021, `touchHistory` nhận `{server_name, episode_key, episode_name}`, `listHistory`/import trả thêm trường, xoá progress/continue, cập nhật test | backend-implementer | medium |
| 2 | Frontend gỡ progress/resume (danh sách ở mục 5), giữ build/test xanh | frontend-implementer | low |
| 3 | Ghi tập khi bấm Play (`IframePlayerFacade`, `HlsVideo`), `movie-store`/`movie-sync` mang `ep`, hàng "Phim đang xem" + nhãn "Tập N" + link đúng tập, chip "Đang xem" | frontend-implementer | medium |
| 4 | Review invariant (cache key không theo user, `returnTo`, không autoplay) và bảo mật đường ghi mới (validate độ dài/ký tự `server_name`, `episode_key`, `episode_name`) | invariant-reviewer | low |
| 5 | Tài liệu + `scripts/verify.sh` + doc-drift-auditor | doc-drift-auditor, verifier | low |

Deploy: `scripts/deploy.sh` (frontend + api, có migration 021, rollback không hoàn tác migration).

## 8. Rủi ro và giới hạn

- Không biết thời điểm trong tập, chỉ biết tập nào. Đây là giới hạn vì iframe, không phải vì thiếu code.
- Provider đổi `slug` tập -> link cũ rơi về tập đầu server; chấp nhận, không lỗi.
- Bấm Play nhưng thoát ngay vẫn tính là "đã xem tập đó". Chấp nhận (cùng độ chính xác với lịch sử hiện nay).
- Mỗi lần đổi tập là 1 request ghi; phim bộ xem liên tục không đáng kể.
- Drop `user_watch_progress` không đảo ngược; hiện 0 dòng nên không mất dữ liệu, kiểm lại `count(*)` ngay trước khi deploy.

## 9. Quyết định của Steve (2026-09-30)

1. Bỏ hàng "Phim đang xem". 2. Dừng ở tập gần nhất. 3. Đồng ý drop `user_watch_progress`.
