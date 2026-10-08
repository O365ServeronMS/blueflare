# Blueflare File Map

This map describes the current Next.js frontend and repository-owned Docker
origin. Historical static/Worker notes live only in git history.

## Root and configuration

The Next.js app lives in `frontend/`; frontend paths below are relative to it.

- `package.json`: Next.js/React commands and runtime dependencies.
- `next.config.ts`: standalone output, render-cache mode, and response headers.
- `frontend/Dockerfile`: Node 26 production image: `src/server/cluster.mjs` balancer plus the Next standalone workers.
- `tsconfig.json`, `postcss.config.mjs`: TypeScript and Tailwind/PostCSS setup.
- `CLAUDE.md`: authoritative architecture and implementation guide.

## Frontend routes

- `src/app/page.tsx`: server-rendered home and hero/section data.
- `src/app/list/[type]/page.tsx`: paginated list route with country/category filters.
- `src/app/search/page.tsx`: no-store search route with pagination.
- `src/app/movie/[slug]/page.tsx`: server-rendered detail/player shell and episode state.
- `src/app/person/[slug]/page.tsx`: paginated filmography for a verified TMDB cast/director identity.
- `src/app/favorites/page.tsx`, `history/page.tsx`: browser-local libraries.
- `src/app/login/`, `signup/`: account forms (`AuthForm`).
- `src/app/not-found.tsx`, `error.tsx`: information/recovery screens.
- `src/app/healthz/route.ts`: container health probe.
- `src/app/api/internal/revalidate/route.ts`: secret-protected targeted render-cache invalidation.
- `src/app/api/auth/*`, `api/me/*`: same-origin account proxy routes (uncached) via `lib/account-proxy.ts`.

## Frontend components and libraries

- `components/`: GlobalNav, HeroSlider, SectionRow, MovieCard, CastStrip, Pagination,
  ReviewsSection, ReviewList, MoviePlayer, HlsVideo, IframePlayerFacade, local actions/grids, and shared UI.
- `lib/catalog.ts`: browser-safe catalog client.
- `lib/catalog-server.ts`: cached server API helpers and cache tags.
- `lib/navigation.ts`: `returnTo` and category-context policy.
- `lib/reviews.ts`: helper hiển thị review (chữ cái đầu, ngày, review dài). `ReviewList.tsx` hiện bản dịch `contentVi` mặc định, có nút chuyển về bản gốc.
- `lib/playback.ts`: centralized device/source priority and URL validation.
- `lib/account-proxy.ts`: proxy to the API (`bf_session` cookie, Origin check, real client IP, hardcoded Cloudflare IP ranges).
- `lib/movie-sync.ts`, `movie-store.ts`: favorites/history sync, including the last watched episode per movie (PLAN-007).
- `components/` account pieces: AuthForm, LastWatchedBadge, useAccount.
- `lib/episodes.ts`, `lib/types.ts`, `lib/utils.ts`: shared helpers and models.

## Docker backend and deployment

Runtime sống ở `/opt/stacks/blueflare`, không nằm trong repo — xem
`docs/adr/ADR-001-tach-stack-runtime-khoi-codebase.md`. Các file dưới đây là **bản chuẩn**
trong git; thư mục stack giữ bản copy, đồng bộ bằng `infra/scripts/sync-stack.sh`.

- `infra/compose.yml`: frontend, API, worker, PostgreSQL, Valkey, one-shot `image-cache-init`, và service `backup`. Build context
  trỏ về codebase qua `${BLUEFLARE_SRC:-/home/ubuntu/blueflare}`.
- `infra/scripts/sync-stack.sh`: copy compose + script vận hành từ repo sang thư mục stack.
- `infra/scripts/apply-env.sh`: validate `.env` rồi tạo lại container, không rebuild.
- `infra/scripts/backup-postgres.sh`: wrapper mỏng chạy một lần service `backup` (`compose run --rm backup --once`).
- `infra/backup/`: image + script của service backup (dump, verify, upload S3-compatible, prune).
- `backend/src/`: provider sync, canonical merge, ViewModels, cache, image cache origin.
  Job nền: `prewarm.js` (worker làm ấm cache ảnh), `imageCacheSweep.js` (API dọn/evict cache), `tmdbMatchAiLoop.js` (vòng nền thứ tư của worker: OpenRouter xếp hạng ứng viên TMDB, chạy mỗi `TMDB_MATCH_AI_LOOP_MS`).
  Định danh TMDB: `tmdbMatch.js` (khớp xác minh bằng diễn viên), `tmdbMatchAi.js` (ứng viên, prompt, cổng 2 bậc), `tmdbMatchRotation.js` + `openrouter.js` (xoay key/model OpenRouter, trần token/ngày UTC, dùng chung với dịch review), `tmdbMatchAiSync.js` (engine pass, `tmdb_match_ai_runs`), `tmdbIdentity.js` (gán/gộp/nâng/hoàn tác `tmdb_id`, log `tmdb_identity_changes`), `aiQuotaLedger.js` + `aiQuotaStore.js` (sổ cái quota theo key+model, bảng `ai_quota_ledger`); migration `028_tmdb_id_source_and_match_runs.sql`, `029_tmdb_match_ai_outcome.sql`, `030_tmdb_identity_changes.sql`, `031_gemini_quota_ledger.sql`, `032_ai_quota_ledger_rename.sql`.
  `people.js`: slug/identity thuần cho metadata cast/director lấy từ TMDB.
  Review TMDB: `tmdbReviews.js` (chuẩn hoá về plain text, điểm, cờ spoiler), `tmdbReviewsSync.js` (pass của worker), `reviewSpoiler.js`, `reviewOrder.js` (thứ tự hiển thị + khoá cache); dịch review en->vi: `translate.js` (chia đoạn + provider OpenRouter và gtx + chuỗi provider), `reviewTranslateSync.js` (pass của worker, sau pass review); migration `025_tmdb_reviews.sql`, `026_review_translation.sql`, `027_review_translation_provider.sql`.
  Tài khoản: `auth.js` (hash mật khẩu + session + `HashGate` giới hạn scrypt đồng thời), `authLimits.js` (bộ đếm rate limit auth: Valkey, rơi về bộ nhớ), `meApi.js` (`/api/auth/*`, `/api/me/*`, không cache), `meRepository.js`; migration `020_users_sessions.sql`, `021_history_episode.sql` (thêm cột tập vào `user_history`, bỏ `user_watch_progress`).
- `backend/scripts/`: công cụ chạy tay cho định danh TMDB. `tmdb-identity-report.mjs` (báo cáo CSV chỉ-đọc để duyệt mẫu), `tmdb-identity-undo.mjs <changeId>` (hoàn tác một dòng `tmdb_identity_changes`; sau đó phải invalidate slug), và các script dev `tmdb-ai-backtest.mjs`, `tmdb-ai-classify.mjs`, `tmdb-ai-dryrun.mjs` (+ `lib/`). `backend/tools/` giữ các công cụ merge/backtest cũ.
- `infra/scripts/bootstrap-vps.sh`: dựng VPS trắng; hai site block Caddy (`phim` → 3100,
  `img` → 3200, kèm rule `@account` trả 404 cho `/api/auth/*` và `/api/me*`; phía `phim` có `@authdirect` trả 403 cho `/api/auth/*` nếu không đến từ dải Cloudflare) nằm inline trong script, không còn file `.caddy` riêng.
- `infra/cloudflare/cloudflare-auth-ratelimit-rule.json`: Cloudflare rate-limit rule cho `/api/auth/*` (Steve áp tay, xem `docs/CLOUDFLARE_CACHE.md`).
- `infra/cloudflare/cloudflare-frontend-static-rule.json`: optional normal Cloudflare cache rule for immutable `/_next/static/` assets.
- `scripts/deploy.sh`: deploy `main` đã push — chỉ build service mà diff chạm tới, tag
  image cũ thành `:prev`, tạo lại container, chờ healthy + smoke, tự rollback nếu hỏng.
- `scripts/rollback.sh`: đổi `:latest` ↔ `:prev` cho service rồi chạy cùng health gate;
  chạy lần hai là roll forward.
- `scripts/lib/stack.sh`: helper chung của hai script trên (health wait, smoke, swap image).
- `scripts/verify.sh`: checklist kiểm chứng trong CLAUDE.md, một dòng PASS/FAIL mỗi mục.

Chỉ tồn tại ở thư mục stack, **không** trong git: `.env` (secret),
`.env.example` (bản copy của `backend/.env.example`, đồng bộ bằng `sync-stack.sh`),
`.last-deploy` (rev đang chạy, do `scripts/deploy.sh` ghi),
`data/images/` (cache ảnh), `backups/postgres/` (dump local, bản offsite nằm trên R2).

## Fast search hints

- UI/media: `rg -n "HeroSlider|SectionRow|MovieCard|GlobalNav" components src`
- Catalog contract: `rg -n "getHome|getMovie|normalizeCard|CATALOG_BASE" lib components src`
- Routing/pagination: `rg -n "returnTo|hrefWithPage|Pagination" src components lib`
- Playback: `rg -n "resolvePlaybackSource|hls.light|IframePlayerFacade|location.replace" lib components`
- Cache/images: `rg -n "cacheTag|revalidateTag|getOrBuild|imageUrl|prewarm|sweep" src lib backend/src`
