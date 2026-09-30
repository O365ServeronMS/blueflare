# PLAN-004 — Đạo diễn & diễn viên: metadata người từ TMDB + trang `/person/<slug>`

Trạng thái: **chưa thực hiện**. Lập 2026-09-22.
Điểm xuất phát: `main` tại commit `520ab41`.
Người thực hiện dự kiến: Sonnet (medium).

Mục tiêu: bấm vào tên một đạo diễn hoặc diễn viên trên trang chi tiết phim →
mở trang liệt kê các phim của người đó **có trong catalog và Play được**.

---

# ĐỌC HẾT MỤC NÀY TRƯỚC KHI SỬA BẤT KỲ FILE NÀO

## Quyết định đã chốt với Steve — không bàn lại

1. **Person là thực thể riêng, khóa bằng `tmdb_person_id`.** Không bao giờ ghép
   người bằng tên. Bằng chứng trong catalog hiện tại: `Đang cập nhật` xuất hiện
   ở 79 phim (placeholder, không phải người); `Maryam d&#x27;Abo` chưa decode
   HTML entity; `Fleur GeffrierTomohisa YamashitaTom Wozniczka` dính liền không
   dấu phân cách; `Lưu Đức Hoa` (101 phim) chính là `Andy Lau` của TMDB.
2. **Giai đoạn 1 chỉ lấy credits cho identity TMDB đã xác minh** (`tmdb_id` +
   `tmdb_media_type`), **không** dùng `tmdb_lookup_id` / `tmdb_image_fallback_id`.
   Với rail gợi ý, đoán sai chỉ tốn một hàng kém liên quan; với credits, đoán sai
   là **in sai tên diễn viên lên trang phim**. Cột `confidence` vẫn được tạo sẵn
   để mở rộng sau mà không phải migrate lại.
3. **Credits của series lấy ở cấp series** (`/tv/{id}/credits`), không lấy từng
   season. Cùng lý do đã ghi trong comment của `fetchTmdbRecommendations` và
   migration 015: bảng khóa theo TMDB identity, nên một lần fetch phục vụ mọi
   season row dùng chung identity đó.
4. Trang person liệt kê **phim trong catalog**, join cục bộ. **Không** dùng
   `/person/{id}/combined_credits` — nó liệt kê cả phim site không có.
5. TMDB chỉ được gọi từ **worker**. API chỉ đọc PostgreSQL. Không có call TMDB
   nào trên đường request.
6. Không ghi `tmdb_person_id` hay id đoán vào `movies.tmdb_id`.
7. Avatar dùng lại biến thể ảnh `/i/m/` (480x720 = 2:3; TMDB `w500` profile là
   500x750 = 2:3). **Không tạo biến thể ảnh thứ ba.** `image.tmdb.org` đã nằm
   trong `IMAGE_ALLOWED_HOSTS` (`backend/src/config.js:108`).

## Ba cái bẫy đã xác minh — đọc kỹ, plan này đã né sẵn

1. **`slugify()` trong `identity.js` không ASCII-hoá.** Nó dùng `\p{L}` nên giữ
   nguyên CJK/Cyrillic: `千葉繁 → "千葉繁"`, `Ольга → "ольга"`. Có 2.294 tên
   riêng biệt trong catalog rơi vào nhóm này. Tag `person:千葉繁` **trượt**
   `TAG_PATTERN = /^[a-z0-9:_-]{1,128}$/` ở cả `backend/src/frontendRevalidation.js:5`
   lẫn `src/app/api/internal/revalidate/route.ts:4` — bị lọc **im lặng**.
   → Vì vậy Task 3 viết hàm slug riêng, ASCII-only, **luôn gắn `-<tmdbPersonId>`
   ở đuôi**. Không được gọi `slugify()` cho người.
2. **`slugify('')` trả về `'movie'`** (`identity.js:13`) — fallback dành cho
   phim. Nếu dùng cho người thì mọi tên không slug được sẽ đổ về `/person/movie`
   và đụng nhau.
3. **`character` là từ khoá kiểu dữ liệu trong PostgreSQL.** Đặt tên cột là
   `character_name`, không phải `character`.

## Khác với bản audit ngày 2026-09-22 — đọc để không làm thừa

- **Không có pass purge cache cho person.** Bản audit đề xuất worker gom tập
  person slug đã đổi rồi purge Valkey + tag Next. Bỏ hẳn phần đó, thay bằng
  TTL: đúng tiền lệ `refreshTmdbRecommendations()` (`worker.js:357-362`,
  "Returns nothing: … its response carries its own TTL, so nothing here needs
  purging"). Credits gần như bất động sau lần backfill đầu, còn phim mới khớp
  vào một person là chuyện join ở read time — TTL 1 giờ là đủ, và cách này loại
  bỏ hoàn toàn rủi ro lần backfill đầu bắn hàng nghìn lô revalidate.
- **Không thêm `person:*` vào `invalidateForSlugs()`.** Cast strip trên trang
  chi tiết xuất hiện theo TTL sẵn có của `movie:<slug>` (Valkey 300s, Next
  `cacheLife` revalidate 900s). Đây là quyết định có ý thức, không phải bỏ sót.
- **Không có chip lọc `role` trên UI ở giai đoạn 1.** Trang person hiện một
  danh sách gộp (`role=all`). Tham số `role` vẫn được API nhận và chuẩn hoá để
  hợp đồng có sẵn cho sau này.

## Việc KHÔNG làm ở giai đoạn này

- Không lấy `created_by` của series. `/tv/{id}/credits` hầu như không có crew
  `job='Director'`, nên **phần lớn phim bộ sẽ không có đạo diễn bấm được** —
  đúng với dữ liệu TMDB, không phải lỗi. Trường `director` chuỗi cũ vẫn hiển
  thị dạng text. Ghi nhận là khoảng trống đã biết, mở rộng sau.
- Không dùng `aggregate_credits`, không dùng `/person/{id}`.
- Không đụng `movies.actors` / `movies.directors` (jsonb chuỗi). Chúng vẫn là
  nguồn duy nhất cho 46% catalog không có identity TMDB.
- Không tạo trang cho người không có phim nào Play được (API trả 404).

## Số đo làm mốc (đo thật trên DB production, read-only, 2026-09-22)

| Chỉ số | Giá trị |
|---|---|
| movies `catalog_state='ready'` | 49.059 |
| có `actors` không rỗng | 41.938 |
| có `directors` không rỗng | 35.296 |
| tổng credit rows (jsonb chuỗi) | 260.273 |
| tên riêng biệt | 107.004 |
| `tmdb_id` đã xác minh | 11.422 rows → **11.297 identity riêng biệt** |
| `tmdb_lookup_id` (đoán, **không dùng ở giai đoạn 1**) | 15.089 |

**Dự toán tải:** 11.297 identity × 1 call TMDB = 11.297 call. Với
`TMDB_CREDITS_LIMIT=300`/cycle và `SYNC_INTERVAL_MS=900000` (96 cycle/ngày) →
backfill xong trong **~0,4 ngày**.
**Dự toán dung lượng:** 11.297 × ~13 hàng ≈ **147k hàng** `movie_credits` —
nhỏ hơn 260k hàng credit jsonb đang lưu.

## Quy tắc bắt buộc

1. Đọc `CLAUDE.md` trước. Nó thắng mọi tài liệu khác, kể cả file này.
2. Làm trên branch `feat/people-credits` tạo từ `main`. Làm đúng thứ tự
   Task 1 → 16. Mỗi Phase kết thúc bằng **một commit** (xem mục Commit cuối
   file). **Không push, không merge.**
3. Mỗi Task có khối **Kiểm tra**. Sai kỳ vọng → **DỪNG**, báo lại output thật.
   Không tự nghĩ cách khác.
4. **Không** chạy: `scripts/deploy.sh`, `scripts/rollback.sh`,
   `deploy/sync-stack.sh`, `docker compose up/down/restart`, reload Caddy, bất
   kỳ lệnh ghi nào vào `/opt/stacks/blueflare`, bất kỳ lệnh ghi nào vào
   PostgreSQL/Valkey. Plan này chỉ sửa codebase.
5. Chỉ sửa file mà Task nêu tên. Không đổi tên hàm có sẵn, không refactor thêm.
6. `cd backend && node --test` phải **xanh 100%**. Nếu `providers.test.js` báo
   `Cannot find package 'pg'` thì chạy `npm ci` trong `backend/` rồi chạy lại —
   không skip, không xoá test.
7. Không thêm thư viện. Không thêm biến thể ảnh. Không đổi cache key/tag theo
   `returnTo`, cookie, authorization, user agent hay tham số analytics.
8. Code mới viết theo đúng giọng file xung quanh: chuỗi SQL nối bằng `+` như
   `repository.js`, comment tiếng Anh ngắn giải thích *vì sao* (không giải
   thích *cái gì*).

---

# Phase 1 — Schema, config, module thuần

## Task 1. Migration `backend/migrations/016_people_and_credits.sql`

```sql
-- People and movie<->person edges, both keyed by TMDB ids rather than by the
-- provider name strings in movies.actors/movies.directors. Those strings carry
-- placeholders ('Dang cap nhat'), undecoded HTML entities and Han-Viet
-- transliterations of the same person, so they cannot key anything.
--
-- Edges are keyed by the TMDB identity exactly like tmdb_recommendations: every
-- season row of a series shares one identity, so one fetch serves all of them,
-- and a title synced later joins in at read time without a refetch.
CREATE TABLE IF NOT EXISTS people (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tmdb_person_id bigint NOT NULL UNIQUE CHECK (tmdb_person_id > 0),
  name text NOT NULL,
  -- Permalink. Written once, never recomputed on read: TMDB renames people.
  slug text NOT NULL UNIQUE,
  profile_asset_id uuid REFERENCES image_assets(id),
  profile_source_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS movie_credits (
  media_type text NOT NULL CHECK (media_type IN ('movie', 'tv')),
  tmdb_id bigint NOT NULL CHECK (tmdb_id > 0),
  person_id uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('cast', 'director')),
  -- 'character' is a PostgreSQL type keyword; the column is named around it.
  character_name text,
  ord integer NOT NULL DEFAULT 0,
  -- Only 'verified' is written today. The column exists so guessed lookup ids
  -- can be admitted later and filtered at display time, without a migration.
  confidence text NOT NULL DEFAULT 'verified' CHECK (confidence IN ('verified', 'guessed')),
  PRIMARY KEY (media_type, tmdb_id, person_id, role)
);

CREATE INDEX IF NOT EXISTS movie_credits_person_idx
  ON movie_credits (person_id, role, ord);

CREATE TABLE IF NOT EXISTS tmdb_credits_sync (
  media_type text NOT NULL CHECK (media_type IN ('movie', 'tv')),
  tmdb_id bigint NOT NULL CHECK (tmdb_id > 0),
  status text NOT NULL CHECK (status IN ('ok', 'empty', 'not_found', 'error')),
  last_error text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_type, tmdb_id)
);

-- The person page joins credits back to movies on (tmdb_id, tmdb_media_type)
-- with the media type as a bound parameter, so the existing partial indexes
-- (WHERE tmdb_media_type = 'movie' / 'tv') are not provable at plan time.
CREATE INDEX IF NOT EXISTS movies_tmdb_identity_lookup_idx
  ON movies (tmdb_id, tmdb_media_type)
  WHERE tmdb_id IS NOT NULL;
```

Cả `api` và `worker` đều gọi `migrate()` khi khởi động, không cần làm gì thêm.

**Kiểm tra:** `ls backend/migrations | tail -2` in ra `015_tmdb_recommendations.sql`
và `016_people_and_credits.sql`.

## Task 2. Config và `.env.example`

`backend/src/config.js`: ngay sau dòng `tmdbRecommendationsRetryMs: …`, thêm:

```js
  // TMDB cast/director credits, keyed by TMDB identity. Verified ids only:
  // a wrong guess here prints the wrong actor on a movie page.
  tmdbCreditsEnabled: boolean('TMDB_CREDITS_ENABLED', true),
  tmdbCreditsLimit: integer('TMDB_CREDITS_LIMIT', 300, 1),
  tmdbCreditsConcurrency: integer('TMDB_CREDITS_CONCURRENCY', 3, 1),
  tmdbCreditsCastLimit: integer('TMDB_CREDITS_CAST_LIMIT', 12, 1),
  tmdbCreditsRefreshMs: integer('TMDB_CREDITS_REFRESH_MS', 90 * 24 * 60 * 60 * 1000, 60 * 60 * 1000),
  tmdbCreditsRetryMs: integer('TMDB_CREDITS_RETRY_MS', 6 * 60 * 60 * 1000, 60 * 1000),
```

`backend/.env.example`: ngay sau dòng `TMDB_RECOMMENDATIONS_RETRY_MS=21600000`, thêm:

```
# TMDB cast/director credits behind /person/<slug> and the detail-page cast strip.
# Fetched by the worker only; the API reads them from PostgreSQL. One TMDB call
# per distinct verified TMDB identity per cycle.
TMDB_CREDITS_ENABLED=true
TMDB_CREDITS_LIMIT=300
TMDB_CREDITS_CONCURRENCY=3
# Top N billed cast per title, plus every crew member with job='Director'.
TMDB_CREDITS_CAST_LIMIT=12
# A fetched credit list is refreshed after 90 days; a failed fetch after 6 hours.
TMDB_CREDITS_REFRESH_MS=7776000000
TMDB_CREDITS_RETRY_MS=21600000
```

Compose nạp `.env` bằng `env_file`, nên **không** sửa `deploy/compose.yml`.

> `deploy/apply-env.sh` fail deploy nếu `.env` trên stack thiếu key mà
> `.env.example` có. Việc bổ sung 6 key vào `/opt/stacks/blueflare/.env` là
> **việc của Steve khi deploy**, không phải của agent — agent không được ghi vào
> `/opt/stacks`. Ghi rõ điều này trong phần báo cáo cuối.

**Kiểm tra:**
`cd backend && node -e "import('./src/config.js').then(({config})=>console.log(config.tmdbCreditsLimit, config.tmdbCreditsCastLimit, config.tmdbCreditsRefreshMs))"`
in ra `300 12 7776000000`.

## Task 3. Module thuần `backend/src/people.js`

File mới. **Không import gì từ `db.js` hay `config.js`** để test được mà không
cần PostgreSQL. Chỉ được import `normalizeTitle` từ `./identity.js`.

```js
import { normalizeTitle } from './identity.js';

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * ASCII-only slug body.
 *
 * `slugify()` in identity.js keeps CJK and Cyrillic (it matches on \p{L}), and
 * a person slug reaches the revalidation tag pattern /^[a-z0-9:_-]{1,128}$/ on
 * both sides, where a non-ASCII tag is dropped silently. 2.294 distinct names
 * in the catalog are affected, so this strips instead of transliterating.
 */
export function asciiSlugBody(name) {
  return normalizeTitle(name)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Permalink for one person.
 *
 * The TMDB id is always appended: it makes the slug deterministic and unique
 * without a retry loop, survives TMDB renaming the person, and keeps a name
 * that strips to nothing (CJK, 'Dang cap nhat') off a shared '/person/movie'
 * — which is where slugify()'s own empty-string fallback would send it.
 */
export function personSlug(name, tmdbPersonId) {
  const id = positiveId(tmdbPersonId);
  if (!id) return '';
  return (asciiSlugBody(name) || 'nguoi') + '-' + id;
}

/**
 * The TMDB identity a catalog row's credits are fetched for.
 *
 * Verified tmdb_id only, unlike `recommendationSource`. A wrong guessed id
 * costs the rail one weak row; here it would print a wrong actor on a movie
 * page, so guessed ids stay out until `movie_credits.confidence` is used.
 */
export function creditIdentity(row) {
  if (!row) return null;
  const tmdbId = positiveId(row.tmdb_id);
  if (!tmdbId) return null;
  if (row.tmdb_media_type !== 'movie' && row.tmdb_media_type !== 'tv') return null;
  return { mediaType: row.tmdb_media_type, tmdbId };
}

/** 'cast' | 'director' | 'all'; anything else reads as 'all'. */
export function normalizeCreditRole(value) {
  const role = String(value || '').trim().toLowerCase();
  return role === 'cast' || role === 'director' ? role : 'all';
}
```

## Task 4. Test `backend/test/people.test.js`

Theo khuôn `backend/test/recommendations.test.js` (`node:test` + `node:assert/strict`).
Bắt buộc có các case:

- `personSlug('Andy Lau', 1337)` → `'andy-lau-1337'`.
- `personSlug('Lưu Đức Hoa', 1337)` → `'luu-duc-hoa-1337'` (dấu tiếng Việt và
  `đ` bị hạ về ASCII).
- `personSlug('千葉繁', 88)` → `'nguoi-88'` — **không** chứa ký tự ngoài ASCII.
- `personSlug('Ольга', 5)` → `'nguoi-5'`.
- `personSlug('Đang cập nhật', 9)` → `'dang-cap-nhat-9'` (vẫn slug được; việc
  loại placeholder không thuộc tầng này — TMDB không trả ra nó).
- `personSlug('Andy Lau', 0)` và `personSlug('Andy Lau', null)` → `''`.
- **Mọi slug sinh ra phải khớp `/^[a-z0-9:_-]{1,128}$/`** — assert trực tiếp,
  đây là ràng buộc load-bearing với `frontendRevalidation.js`.
- `creditIdentity`: chỉ trả identity khi có cả `tmdb_id` và
  `tmdb_media_type ∈ {movie, tv}`; trả `null` khi chỉ có `tmdb_lookup_id`
  hoặc `tmdb_image_fallback_id` (đây là điểm khác `recommendationSource`, phải
  có test chứng minh).
- `normalizeCreditRole`: `'cast'`, `'director'`, `'CAST'` → `'cast'`,
  `''`/`'xyz'`/`undefined` → `'all'`.

**Kiểm tra Phase 1:** `cd backend && node --test` xanh 100%.

---

# Phase 2 — Lấy credits từ TMDB và lưu

## Task 5. `fetchTmdbCredits` trong `backend/src/tmdb.js`

Thêm vào **cuối file**, dùng `fetchTmdb`, `validMovieId`, `validMediaType`,
`imageSource` đã có sẵn trong file:

```js
function creditPerson(entry, imageBaseUrl) {
  const tmdbPersonId = validMovieId(entry?.id);
  const name = String(entry?.name || '').trim();
  if (!tmdbPersonId || !name) return null;
  return {
    tmdbPersonId,
    name,
    profileSourceUrl: imageSource(entry?.profile_path, 'w500', imageBaseUrl)
  };
}

/**
 * Billed cast and directors for one TMDB identity.
 *
 * Read at series level for tv, never per season: the credits table is keyed by
 * the TMDB identity like tmdb_recommendations, so one fetch serves every season
 * row sharing it. A 404 propagates with `error.status === 404` so the caller
 * records the identity as not found instead of retrying it forever.
 */
export async function fetchTmdbCredits(identity, options = {}) {
  const tmdbId = validMovieId(identity?.tmdbId);
  const mediaType = validMediaType(identity?.mediaType);
  if (!tmdbId || !mediaType) throw new Error('TMDB identity is incomplete');
  const castLimit = Math.max(1, Math.floor(options.castLimit ?? config.tmdbCreditsCastLimit));
  const body = await fetchTmdb('/' + mediaType + '/' + tmdbId + '/credits', options);

  const cast = [];
  const seenCast = new Set();
  for (const entry of Array.isArray(body?.cast) ? body.cast : []) {
    const person = creditPerson(entry, options.imageBaseUrl);
    // One actor can be billed twice for two characters; the first billing wins.
    if (!person || seenCast.has(person.tmdbPersonId)) continue;
    seenCast.add(person.tmdbPersonId);
    cast.push({
      ...person,
      characterName: String(entry?.character || '').trim() || null,
      order: Number.isInteger(entry?.order) ? entry.order : cast.length
    });
    if (cast.length >= castLimit) break;
  }

  const directors = [];
  const seenDirector = new Set();
  for (const entry of Array.isArray(body?.crew) ? body.crew : []) {
    if (entry?.job !== 'Director') continue;
    const person = creditPerson(entry, options.imageBaseUrl);
    if (!person || seenDirector.has(person.tmdbPersonId)) continue;
    seenDirector.add(person.tmdbPersonId);
    directors.push({ ...person, order: directors.length });
  }

  return { cast, directors };
}
```

Lưu ý: cắt `castLimit` **theo thứ tự TMDB trả về** (TMDB trả theo billing
order), không sort lại — giữ đúng như `resultIds()` làm với recommendations.

## Task 6. Test `backend/test/tmdb-credits.test.js`

Theo khuôn `recommendations.test.js`: truyền `fetchImpl` giả, `apiKey: 'k'`,
`baseUrl: 'https://tmdb.test/3'`, `imageBaseUrl: 'https://img.test/t/p'`.

- Parse đúng `cast` (name, characterName, order, profileSourceUrl) và `crew`
  lọc `job === 'Director'`.
- `castLimit: 2` chỉ giữ 2 người đầu; crew director **không** bị cắt.
- Diễn viên trùng `id` trong `cast` chỉ ra một lần.
- `profile_path: null` → `profileSourceUrl === null`, entry vẫn được giữ.
- Entry thiếu `id` hoặc `name` rỗng bị bỏ.
- Body `{}` → `{ cast: [], directors: [] }`.
- HTTP 404 → throw với `error.status === 404` (assert đúng thuộc tính này, worker
  dựa vào nó để ghi `not_found`).
- Identity thiếu `mediaType` → throw `'TMDB identity is incomplete'`.
- URL gọi đúng `/movie/<id>/credits` và `/tv/<id>/credits` (assert trên URL mà
  `fetchImpl` nhận được), **không** có `/season/`.

## Task 7. Repository trong `backend/src/repository.js`

Thêm `import { personSlug } from './people.js';` cạnh các import sẵn có.
Đặt các hàm mới **ngay sau** `recordTmdbRecommendations` (khoảng dòng 560).

### 7.1 `listTmdbCreditCandidates(limit = config.tmdbCreditsLimit)`

Bản rút gọn của `listTmdbRecommendationCandidates` (`repository.js:516`), khác ở
chỗ **chỉ nhận identity đã xác minh**:

```js
/**
 * Verified TMDB identities whose credits are missing or due. Never-fetched
 * identities go first, newest catalog rows first, so the pages visitors reach
 * soonest get a cast strip soonest.
 */
export async function listTmdbCreditCandidates(limit = config.tmdbCreditsLimit) {
  const result = await pool.query(
    'WITH keys AS (' +
    '  SELECT DISTINCT ON (m.tmdb_media_type, m.tmdb_id) m.tmdb_media_type AS media_type, ' +
    '    m.tmdb_id, m.catalog_sort_at FROM movies m ' +
    "  WHERE m.catalog_state='ready' AND m.tmdb_id IS NOT NULL " +
    "    AND m.tmdb_media_type IN ('movie','tv') " +
    '  ORDER BY m.tmdb_media_type, m.tmdb_id, m.catalog_sort_at DESC NULLS LAST' +
    ') ' +
    'SELECT keys.media_type, keys.tmdb_id FROM keys ' +
    'LEFT JOIN tmdb_credits_sync s ON s.media_type=keys.media_type AND s.tmdb_id=keys.tmdb_id ' +
    'WHERE s.tmdb_id IS NULL ' +
    "  OR (s.status <> 'error' AND s.fetched_at < now() - ($1::bigint * interval '1 millisecond')) " +
    "  OR (s.status = 'error' AND s.fetched_at < now() - ($2::bigint * interval '1 millisecond')) " +
    'ORDER BY (s.tmdb_id IS NULL) DESC, keys.catalog_sort_at DESC NULLS LAST LIMIT $3',
    [config.tmdbCreditsRefreshMs, config.tmdbCreditsRetryMs, Math.max(1, Math.floor(limit))]
  );
  return result.rows;
}
```

### 7.2 `recordTmdbCredits(mediaType, tmdbId, payload)`

**Một transaction**, đúng khuôn `recordTmdbImageFallback` (`repository.js:562`):

1. Gộp `payload.cast` (role `'cast'`) và `payload.directors` (role `'director'`)
   thành một danh sách phẳng `{ tmdbPersonId, name, characterName, order, role,
   profileSourceUrl }`.
2. Với mỗi người: `const assetId = await ensureImageAsset(client, profileSourceUrl);`
   (hàm đã có ở `repository.js:14`, tự lọc host qua `normalizeAllowedImageSourceUrl`),
   rồi upsert:

```js
'INSERT INTO people (tmdb_person_id, name, slug, profile_asset_id, profile_source_url, updated_at) ' +
'VALUES ($1,$2,$3,$4,$5,now()) ON CONFLICT (tmdb_person_id) DO UPDATE SET ' +
'name=EXCLUDED.name, ' +
// A person TMDB later drops a photo for keeps the one already cached.
'profile_asset_id=COALESCE(EXCLUDED.profile_asset_id, people.profile_asset_id), ' +
'profile_source_url=COALESCE(EXCLUDED.profile_source_url, people.profile_source_url), ' +
'updated_at=now() RETURNING id'
```

   **`slug` cố ý không nằm trong `DO UPDATE SET`** — nó là permalink; TMDB đổi
   tên hiển thị thì URL cũ vẫn phải sống. Viết comment đúng ý đó.
   Bỏ qua người có `personSlug(name, tmdbPersonId) === ''`.
3. `DELETE FROM movie_credits WHERE media_type=$1 AND tmdb_id=$2` rồi INSERT lại
   toàn bộ. Delete-then-insert để người bị TMDB gỡ khỏi danh sách cũng biến mất.
   `confidence` để mặc định `'verified'` (không truyền).
4. Upsert `tmdb_credits_sync` với `status`, `last_error=NULL`, `fetched_at=now()`.
5. `COMMIT`; `catch` → `ROLLBACK` + rethrow; `finally` → `client.release()`.

**Không** `UPDATE movies … updated_at=now()`. Không có gì thuộc hàng `movies`
thay đổi, và `updated_at` là tín hiệu "nội dung phim đổi" của pass đồng bộ.

### 7.3 `recordTmdbCreditsFailure(mediaType, tmdbId, status, message)`

Chỉ ghi `tmdb_credits_sync` (`status ∈ {'not_found','error'}`, `last_error`,
`fetched_at=now()`), **giữ nguyên các cạnh cũ** — TMDB chết thì cast strip cũ
đi chứ không rỗng. Cùng tinh thần `recordTmdbRecommendations` nhánh `error`.

### 7.4 `findPersonBySlug(slug)`

`SELECT * FROM people WHERE slug=$1 LIMIT 1` → `result.rows[0] || null`.

### 7.5 `creditsForMovie(mediaType, tmdbId)`

```sql
SELECT p.name, p.slug, p.profile_asset_id, c.role, c.character_name, c.ord
FROM movie_credits c JOIN people p ON p.id=c.person_id
WHERE c.media_type=$1 AND c.tmdb_id=$2
ORDER BY c.role ASC, c.ord ASC
```
(`role ASC` → `'cast'` trước `'director'`; viewmodel tự tách hai nhóm.)

### 7.6 `listPersonMovies(personId, options)`

`options`: `{ role = 'all', page = 1, limit = 24 }`. Trả **đúng shape**
`{ rows, page, limit, totalItems, totalPages }` như `listCanonical`
(`repository.js:840`) — đó là hợp đồng mà `listResponse()` đang dùng.

Dựng một chuỗi `hits` CTE **một lần** rồi dùng cho cả count lẫn page:

```js
const roleFilter = role === 'all' ? '' : ' AND c.role=$2';
const hits =
  'WITH hits AS (' +
  '  SELECT DISTINCT ON (c.media_type, c.tmdb_id) m.* FROM movie_credits c ' +
  '  JOIN movies m ON m.tmdb_id=c.tmdb_id AND m.tmdb_media_type=c.media_type ' +
  "  WHERE c.person_id=$1" + roleFilter +
  "    AND m.catalog_state='ready' AND m.canonical_slug<>'' " +
  '    AND ' + imagePresent('m') + ' AND ' + playableSourceExists('m') +
  '  ORDER BY c.media_type, c.tmdb_id, m.tmdb_season_number DESC NULLS LAST, ' +
  '    m.catalog_sort_at DESC NULLS LAST' +
  ') ';
```

- **`DISTINCT ON (c.media_type, c.tmdb_id)` là bắt buộc.** Không có nó, một
  series 6 mùa chiếm 6 ô giống hệt nhau trên trang người đó. Giữ mùa mới nhất,
  cùng quy tắc `rankedRecommendationRows` đang dùng (`repository.js:1069`).
- `imagePresent` và `playableSourceExists` là hàm module-scope sẵn có trong
  `repository.js` (dòng 1045 và 930) — **dùng lại, không viết lại**.
- Count: `hits + 'SELECT count(*)::integer AS count FROM hits'`.
- Page: `hits + 'SELECT * FROM hits ORDER BY catalog_sort_at DESC NULLS LAST, year DESC NULLS LAST, canonical_slug ASC LIMIT $n OFFSET $n+1'`
  (cùng thứ tự sắp xếp với `listCanonical`).
- `limit` kẹp `Math.min(64, Math.max(1, …))`, `page` kẹp
  `Math.min(requestedPage, totalPages)` — sao y `listCanonical`.

**Kiểm tra Task 7:** không có test DB trong repo này, nên kiểm tra bằng
`node --check backend/src/repository.js` và đọc lại chuỗi SQL. Nếu có nghi ngờ
về kế hoạch truy vấn, **báo lại cho Steve để anh chạy EXPLAIN**, không tự kết
nối DB.

## Task 8. Worker pass trong `backend/src/worker.js`

Thêm import `listTmdbCreditCandidates`, `recordTmdbCredits`,
`recordTmdbCreditsFailure` từ `./repository.js` và `fetchTmdbCredits` từ
`./tmdb.js`.

Thêm hàm **ngay sau** `refreshTmdbRecommendations()` (kết thúc ~dòng 386):

```js
/**
 * Fetch TMDB cast/director credits for the detail-page cast strip and the
 * person pages.
 *
 * Runs after the recommendations pass and uses the same shape. Returns nothing:
 * the person pages join credits to the catalog at read time and carry their own
 * TTL, and the detail payload picks the strip up on its existing movie:<slug>
 * expiry — so nothing here needs purging. That also keeps the first backfill,
 * which touches tens of thousands of people, from firing thousands of
 * revalidation batches at the frontend.
 */
async function refreshTmdbCredits() {
  if (!config.tmdbEnabled || !config.tmdbCreditsEnabled || !config.tmdbApiKey) return;
  const candidates = await listTmdbCreditCandidates();
  if (!candidates.length) return;

  const counts = { ok: 0, empty: 0, not_found: 0, error: 0 };
  await mapLimit(candidates, config.tmdbCreditsConcurrency, async (candidate) => {
    const mediaType = candidate.media_type;
    const tmdbId = Number(candidate.tmdb_id);
    try {
      const credits = await fetchTmdbCredits({ mediaType, tmdbId });
      const status = credits.cast.length || credits.directors.length ? 'ok' : 'empty';
      counts[status] += 1;
      await recordTmdbCredits(mediaType, tmdbId, { ...credits, status });
    } catch (error) {
      const status = error.status === 404 ? 'not_found' : 'error';
      counts[status] += 1;
      await recordTmdbCreditsFailure(mediaType, tmdbId, status, error.message).catch(() => {});
    }
  });

  console.log('[worker] tmdb credits checked=' + candidates.length +
    ' ok=' + counts.ok + ' empty=' + counts.empty +
    ' not_found=' + counts.not_found + ' error=' + counts.error);
}
```

Gọi trong vòng đồng bộ, **ngay sau** khối `refreshTmdbRecommendations()`
(worker.js ~dòng 462), trước `refreshMdblistBackfill()`:

```js
  if (!stopping) {
    await refreshTmdbCredits().catch((error) => {
      console.warn('[worker] tmdb credits pass failed', error.message);
    });
  }
```

**Kiểm tra Phase 2:** `cd backend && node --test` xanh 100%;
`node --check backend/src/worker.js` và `node --check backend/src/tmdb.js` sạch.

---

# Phase 3 — API

## Task 9. `people` trong `buildMovie` (`backend/src/viewmodels.js`)

Import `creditIdentity` từ `./people.js` và `creditsForMovie` từ `./repository.js`.

Thêm helper cạnh `card()`:

```js
function creditCard(row) {
  return {
    name: row.name,
    slug: row.slug,
    character: row.character_name || null,
    photo: imageUrl(row.profile_asset_id, 'm')
  };
}
```

Trong `buildMovie`, sau `const base = card(movie);`:

```js
  // Verified TMDB identities only, so most of the catalog has no rows here.
  // `actor`/`director` below stay in the payload for exactly that reason.
  const identity = creditIdentity(movie);
  const credits = identity
    ? await creditsForMovie(identity.mediaType, identity.tmdbId)
    : [];
```

và thêm vào object `movie` **bên cạnh** `actor`/`director` (không thay thế):

```js
      people: {
        cast: credits.filter((row) => row.role === 'cast').map(creditCard),
        directors: credits.filter((row) => row.role === 'director').map(creditCard)
      },
```

## Task 10. `buildPerson` + route `/api/person/:slug`

`backend/src/viewmodels.js` — import `findPersonBySlug`, `listPersonMovies` từ
`./repository.js` và `normalizeCreditRole` từ `./people.js`:

```js
/** Null means no such person; the route turns that into a 404. */
export async function buildPerson(slug, page, role) {
  const person = await findPersonBySlug(slug);
  if (!person) return null;
  const result = await listPersonMovies(person.id, {
    role: normalizeCreditRole(role),
    page
  });
  return {
    status: 'success',
    data: {
      titlePage: person.name,
      person: {
        name: person.name,
        slug: person.slug,
        photo: imageUrl(person.profile_asset_id, 'm')
      },
      items: result.rows.map(card),
      params: {
        pagination: {
          totalItems: result.totalItems,
          totalItemsPerPage: result.limit,
          currentPage: result.page,
          totalPages: result.totalPages
        }
      }
    }
  };
}
```

Envelope này **đúng bằng** cái `listResponse()` sinh ra, nên `toListPayload()`
ở `lib/catalog-server.ts:25` đọc được ngay, không sửa gì.

`backend/src/server.js` — thêm **ngay trước** khối `recommendationMatch`
(dòng ~287). Dùng `getOrBuild` + 404 tường minh chứ **không** dùng `cachedJson`:
`cachedJson` luôn trả 200, kể cả khi builder trả `null` (xem `server.js:86`).
Sao y khuôn của `movieMatch` (`server.js:262`):

```js
  const personMatch = url.pathname.match(/^\/api\/person\/([^/]+)$/);
  if (personMatch) {
    const slug = normalizeKeyPart(decodeURIComponent(personMatch[1]), 160);
    const role = normalizeCreditRole(url.searchParams.get('role'));
    const currentPage = page(url.searchParams.get('page'));
    const result = await getOrBuild(
      'person:' + slug + ':' + role + ':' + currentPage,
      () => buildPerson(slug, currentPage, role),
      { ttl: 3600 }
    );
    observeCache(result.cacheStatus);
    if (!result.data) {
      json(response, request, 404, { error: 'Person not found' }, {
        'cache-control': 'public, max-age=30, stale-while-revalidate=60'
      });
      return;
    }
    json(response, request, 200, result.data, {
      'cache-control': 'public, max-age=60, stale-while-revalidate=' + config.responseCacheStaleSeconds + ', stale-if-error=' + config.responseCacheStaleSeconds,
      'x-blueflare-cache': result.cacheStatus
    });
    return;
  }
```

Cache key **chỉ** gồm slug + role + page. Không `returnTo`, không cookie, không
user agent, không tham số analytics — invariant trong `CLAUDE.md`.

**Kiểm tra Phase 3:** `node --check` sạch cho `viewmodels.js` và `server.js`;
`cd backend && node --test` xanh 100%.

---

# Phase 4 — Cast strip trên trang chi tiết

## Task 11. Types + client trong `lib/`

`lib/types.ts`:

```ts
export type PersonCredit = {
  name: string;
  slug: string;
  character?: string;
  photo?: string;
};
```
Thêm vào `MovieDetail`: `people?: { cast: PersonCredit[]; directors: PersonCredit[] };`
(**giữ nguyên** `actor?: string[]` và `director?: string[]`).

Thêm:
```ts
export type PersonPayload = ListPayload & {
  person: { name: string; slug: string; photo?: string };
};
```

`lib/catalog-server.ts`:

- Trong `getMovieServer`, cạnh `actor`/`director`, map thêm:
```ts
    people: {
      cast: creditList(movieRaw?.people?.cast),
      directors: creditList(movieRaw?.people?.directors)
    },
```
  với helper module-scope cạnh `detailLabels`:
```ts
function creditList(value: unknown): PersonCredit[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry) => entry && entry.name && entry.slug)
    .map((entry) => ({
      name: String(entry.name),
      slug: String(entry.slug),
      character: entry.character || undefined,
      photo: entry.photo || undefined
    }));
}
```

- Thêm hàm mới ở cuối file:
```ts
export async function getPersonServer(slug: string, page = 1, role = "all"): Promise<PersonPayload> {
  "use cache";
  const safeSlug = String(slug || "").trim();
  const safePage = normalizePage(page);
  const safeRole = role === "cast" || role === "director" ? role : "all";
  cacheLife({ stale: 900, revalidate: 3600, expire: 86400 });
  cacheTag(`person:${safeSlug}`, `page:${safePage}`);
  const payload = await fetchCatalog<any>(
    `/api/person/${encodeURIComponent(safeSlug)}?page=${safePage}&role=${safeRole}`
  );
  const list = toListPayload(payload, "Người", safePage);
  const person = payload?.data?.person || {};
  return {
    ...list,
    person: {
      name: String(person?.name || list.title || ""),
      slug: String(person?.slug || safeSlug),
      photo: person?.photo || undefined
    }
  };
}
```

## Task 12. `components/CastStrip.tsx`

Server Component mới, khuôn theo `components/RecommendationRail.tsx`
(một lỗi ở đây **không được** làm hỏng trang chi tiết).

```tsx
import { hrefWithReturnTo } from "@/lib/navigation";
import type { PersonCredit } from "@/lib/types";

// Only rows with a verified TMDB identity have credits, so this is absent on
// most of the catalog. The plain actor/director text stays on the page either
// way; this strip is the clickable layer on top of it.
export function CastStrip({ cast, directors, returnTo, navSource }: {
  cast: PersonCredit[];
  directors: PersonCredit[];
  returnTo: string;
  navSource?: string;
}) { … }
```

Yêu cầu render:

- Không render gì (`return null`) khi cả hai mảng rỗng.
- Đặt trong `src/app/movie/[slug]/page.tsx` **ngay dưới** `</section>` của khối
  "Chọn nguồn Phát" (dòng ~141), vẫn trong `<div className="bf-content-width bf-page-gutter">`,
  **trên** `<RecommendationRail>`.
- Mỗi người: `<a href={hrefWithReturnTo('/person/' + credit.slug, returnTo, navSource)}>`,
  avatar `<img src={credit.photo} width={160} height={240} loading="lazy" decoding="async">`
  giữ tỉ lệ 2:3 (`aspect-[2/3] object-cover`), tên dưới ảnh, `character` là dòng
  phụ màu `text-silver`.
  **`loading="lazy"` bắt buộc** — hero đầu trang là ảnh eager duy nhất
  (invariant trong `CLAUDE.md`).
- Không có `photo` → ô placeholder bằng token màu sẵn có (`bg-graphite`), không
  vỡ layout.
- Đạo diễn hiện trước diễn viên, có nhãn phân nhóm nhỏ.
- Dùng token/class có sẵn trong `src/styles/globals.css`, không thêm màu mới.
  Accent đỏ `#e4312a` = `text-netflix-red`.

Truyền dữ liệu từ `page.tsx`:
```tsx
<CastStrip cast={movie.people?.cast || []} directors={movie.people?.directors || []} returnTo={returnTo} navSource={navSource} />
```
`CastStrip` là component đồng bộ (dữ liệu đã có trong `movie`), **không** cần
`<Suspense>`, không fetch thêm.

**Kiểm tra Phase 4:** `npm run build` và `npm test` xanh.

---

# Phase 5 — Trang `/person/[slug]`

## Task 13. `src/app/person/[slug]/page.tsx`

Server Component, khuôn **y hệt** `src/app/list/[type]/page.tsx`:

- `await connection();` ở đầu.
- `const page = normalizePage(first(query.page));`
- `const role = first(query.role) === "cast" || first(query.role) === "director" ? first(query.role) : "all";`
- `const data = await getPersonServer(slug, page, role);` — bọc `try/catch`,
  lỗi → `notFound()`.
- `currentSearch` giữ lại `role` (nếu ≠ `all`) và `page` (nếu > 1) → **query
  param phải được bảo toàn**, invariant.
- `const returnTo = createReturnToPath('/person/' + slug, currentSearch.toString()) || '/person/' + slug;`
- Header: avatar + `<h1>{data.person.name}</h1>`, dưới là số phim
  (`data.totalPages` có thì hiện, không bịa con số).
- Grid `MovieCard` **sao y** class grid của trang list, `headingLevel={2}`,
  `returnTo={returnTo}`. **Không** truyền `navSourceKey` — `/person/…` không
  thuộc 5 nav source, truyền vào là sai.
- `<Pagination currentPage={…} totalPages={data.totalPages} buildUrl={(nextPage) => hrefWithPage('/person/' + slug, filters.toString(), nextPage)} />`
  — dùng `hrefWithPage` sẵn có; thuật toán cửa sổ phân trang nằm trong
  `components/Pagination.tsx` (`docs/PAGINATION.md`), **không** viết lại.
- Rỗng → `<p>Chưa có phim nào của người này trên Blueflare.</p>`
- `generateMetadata` trả `title: \`${tên} — Blueflare\``; lỗi → title mặc định,
  đúng khuôn trang movie.

## Task 14. `lib/navigation.ts` + test

Sửa **đúng một chỗ**: trong `isChildRoute()` (~dòng 175):

```ts
function isChildRoute(pathname: string) {
  const path = normalizeNavPath(pathname);
  // /person/... is reached from a movie page and keeps that page's returnTo,
  // so the nav highlight has to follow the same rule.
  return path.startsWith("/movie/") || path.startsWith("/person/");
}
```

**Không** thêm `/person` vào `navSourceFromPath()` — nó phải tiếp tục trả `""`,
vì `/person` không phải một trong 5 nav source (`NAV_SOURCE_KEYS`).

Thêm case vào `lib/navigation.test.ts`:
- `getActiveNavKey('/person/andy-lau-1337', 'returnTo=%2Flist%2Fphim-le')` → `'phim-le'`.
- `navSourceFromPath('/person/andy-lau-1337')` → `''`.
- `hrefWithPage('/person/andy-lau-1337', '', 3)` → `'/person/andy-lau-1337?page=3'`
  và `…, '', 1` → `'/person/andy-lau-1337'`.
- `createReturnToPath('/person/andy-lau-1337', 'page=2')` → `'/person/andy-lau-1337?page=2'`.

**Kiểm tra Phase 5:** `npm run build` và `npm test` xanh.

---

# Phase 6 — Verify và tài liệu

## Task 15. `scripts/verify.sh`

Trong `check_smoke()` (dòng 86), thêm `/person/` vào danh sách probe **chỉ khi**
đã có ít nhất một person slug thật. Vì lúc merge chưa có dữ liệu, **đừng** thêm
một slug cứng sẽ fail. Thay vào đó thêm probe chấp nhận 200 **hoặc** 404:

```bash
# /person/<slug> is data-dependent: before the first credits backfill there is
# no person to probe, so a 404 here is a pass and only a 5xx is a failure.
```
Probe `"/person/khong-ton-tai-0"` và fail chỉ khi mã trả về ≥ 500.

## Task 16. Tài liệu (bắt buộc, không được bỏ)

- `CLAUDE.md`:
  - Mục **Background jobs** → bullet "Provider sync": thêm mệnh đề về pass
    credits (TMDB cast/director theo identity đã xác minh).
  - Mục **Source map** → `backend/src/`: thêm `people.js`; `components/`:
    thêm `CastStrip.tsx`; `src/app/`: thêm `/person/[slug]`.
- `docs/backend-architecture.md`: API contract cho `GET /api/person/:slug`
  (tham số `page`, `role`; envelope; 404) và trường `people` trong
  `GET /api/movie/:slug`.
- `docs/FILE_MAP.md`: các file mới.
- `backend/.env.example`: đã làm ở Task 2 — chỉ xác nhận lại.

**Kiểm tra cuối cùng:** chạy `scripts/verify.sh` (không `--changed`) và báo
nguyên văn phần thất bại nếu có. Kèm `git diff --check HEAD`.

---

# Commit

Mỗi Phase một commit, thông điệp tiếng Việt theo giọng repo
(`git log --oneline -8` để xem mẫu):

1. `feat(people): schema + module slug/identity cho metadata người từ TMDB`
2. `feat(people): worker lấy cast/director TMDB theo identity đã xác minh`
3. `feat(people): API /api/person/:slug và trường people trên /api/movie/:slug`
4. `feat(people): cast strip bấm được trên trang chi tiết phim`
5. `feat(people): trang /person/[slug] có phân trang`
6. `docs(people): cập nhật CLAUDE.md, API contract và file map`

Kết thúc mỗi commit bằng:

```
Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
```

**Không push, không merge, không deploy.** Báo lại cho Steve khi xong Task 16.

---

# Rủi ro đã biết — nêu trong báo cáo cuối, đừng tự xử lý

1. **`image_assets` phình ~100k hàng** (một hàng/ảnh profile). Bảng nhỏ, không
   lo; nhưng ảnh avatar **cạnh tranh chỗ trong `/data/images`** với poster dưới
   `IMAGE_CACHE_MAX_BYTES` (8 GiB). Sweep hàng giờ của `api` sẽ evict theo
   least-recently-read, nên về lý thuyết tự cân bằng. **Cần đo sau khi deploy**,
   không tối ưu trước.
2. **Phim bộ hầu như không có đạo diễn** — TMDB để creator ở `created_by` của
   series chứ không ở `crew` (xem mục "Việc KHÔNG làm").
3. **6 key env mới phải được thêm vào `/opt/stacks/blueflare/.env`** trước khi
   deploy, nếu không `deploy/apply-env.sh` sẽ fail. Agent không được ghi vào
   `/opt/stacks` — việc này là của Steve.
4. **Lần backfill đầu tốn ~11.3k call TMDB** chạy song song với pass lookup
   (concurrency 4) và recommendations (concurrency 3). Nếu TMDB bắt đầu trả 429,
   hạ `TMDB_CREDITS_CONCURRENCY` xuống 1 — không cần sửa code.
