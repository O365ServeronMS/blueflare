# PLAN-003 — "Có thể bạn cũng thích" trên trang chi tiết phim

Trạng thái: **chưa thực hiện**. Lập 2026-09-12.
Điểm xuất phát: `main` tại commit `6930b06`.

Dùng TMDB `/recommendations` + `/similar` để chọn phim gợi ý, chỉ hiện những
phim có trong catalog NguonC/KKPhim **và Play được**; thiếu thì bù bằng phim
cùng thể loại.

---

# ĐỌC HẾT MỤC NÀY TRƯỚC KHI SỬA BẤT KỲ FILE NÀO

## Quyết định đã chốt với Steve — không bàn lại

1. Chỉ hiện phim Play được. Phim TMDB gợi ý mà catalog không có thì **bỏ**,
   không hiện poster TMDB, không làm trang cho phim ngoài nguồn.
2. Ghép id TMDB với catalog qua **cả ba cột**: `tmdb_id` (đã xác minh),
   `tmdb_lookup_id`, `tmdb_image_fallback_id`. Không ghép được đủ thì bù bằng
   phim cùng thể loại.
3. Bấm thẻ → mở trang chi tiết phim đó (hành vi `MovieCard` sẵn có). Không nút
   Phát riêng, không autoplay.
4. TMDB chỉ được gọi từ **worker**. API chỉ đọc PostgreSQL. Không có call TMDB
   nào trên đường request.

## Số đo làm mốc (2026-09-11, 30 phim ngẫu nhiên, trang 1 của mỗi endpoint)

| | chỉ `tmdb_id` | cả ba cột id |
|---|---|---|
| phim lẻ (15) | 5,7 phim Play được | **12,4** |
| phim bộ (15) | 9,9 | **13,3** |

23/30 phim có ≥ 8 gợi ý, 1/30 có 0. Catalog: 48.925 phim `ready`, 11.293 có
`tmdb_id`, thêm 15.054 chỉ có `tmdb_lookup_id`.

## Quy tắc bắt buộc

1. Đọc `CLAUDE.md` trước. Nó thắng mọi tài liệu khác.
2. Làm trên branch `feat/recommendations` tạo từ `main`. Làm đúng thứ tự
   Task 1 → 12. Mỗi Phase kết thúc bằng **một commit** (xem mục Commit).
   **Không push, không merge.**
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
   `returnTo`, cookie hay user agent.
8. Code mới viết theo đúng giọng file xung quanh: chuỗi SQL nối bằng `+` như
   `repository.js`, comment tiếng Anh ngắn giải thích *vì sao*.

---

# Phase 1 — Backend: lưu danh sách id TMDB

## Task 1. Migration

Tạo `backend/migrations/015_tmdb_recommendations.sql`:

```sql
-- TMDB recommendation id lists, keyed by the TMDB identity rather than by a
-- catalog row: every season of a series shares one list, so one fetch serves
-- all of them. Only ids are stored; they are matched to playable catalog rows
-- at read time, so titles synced later appear without a refetch.
CREATE TABLE IF NOT EXISTS tmdb_recommendations (
  media_type text NOT NULL CHECK (media_type IN ('movie', 'tv')),
  tmdb_id bigint NOT NULL CHECK (tmdb_id > 0),
  recommended_ids bigint[] NOT NULL DEFAULT '{}',
  similar_ids bigint[] NOT NULL DEFAULT '{}',
  status text NOT NULL CHECK (status IN ('ok', 'empty', 'not_found', 'error')),
  last_error text,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (media_type, tmdb_id)
);

-- Read-time matching looks recommended ids up through the two guessed-id
-- columns as well as tmdb_id; neither had an index usable for that.
CREATE INDEX IF NOT EXISTS movies_tmdb_lookup_id_idx
  ON movies (tmdb_lookup_id)
  WHERE tmdb_id IS NULL AND tmdb_lookup_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS movies_tmdb_image_fallback_id_idx
  ON movies (tmdb_image_fallback_id)
  WHERE tmdb_id IS NULL AND tmdb_image_fallback_id IS NOT NULL;
```

Cả `api` và `worker` đều gọi `migrate()` khi khởi động, không cần làm gì thêm.

**Kiểm tra:** `ls backend/migrations | tail -2` in ra `014_tmdb_lookup_id.sql`
và `015_tmdb_recommendations.sql`.

## Task 2. Config và `.env.example`

`backend/src/config.js`: ngay sau dòng `tmdbLookupRetryMs: …`, thêm:

```js
  // TMDB recommendation/similar id lists for the detail-page rail. Keyed by
  // TMDB identity, refreshed slowly: the lists barely move week to week.
  tmdbRecommendationsEnabled: boolean('TMDB_RECOMMENDATIONS_ENABLED', true),
  tmdbRecommendationsLimit: integer('TMDB_RECOMMENDATIONS_LIMIT', 300, 1),
  tmdbRecommendationsConcurrency: integer('TMDB_RECOMMENDATIONS_CONCURRENCY', 3, 1),
  tmdbRecommendationsRefreshMs: integer('TMDB_RECOMMENDATIONS_REFRESH_MS', 14 * 24 * 60 * 60 * 1000, 60 * 60 * 1000),
  tmdbRecommendationsRetryMs: integer('TMDB_RECOMMENDATIONS_RETRY_MS', 6 * 60 * 60 * 1000, 60 * 1000),
```

`backend/.env.example`: ngay sau dòng `TMDB_LOOKUP_RETRY_MS=2592000000`, thêm:

```
# TMDB recommendation/similar id lists for the "Có thể bạn cũng thích" rail.
# Fetched by the worker only; the API reads them from PostgreSQL. Rows per sync
# cycle are distinct TMDB identities, two TMDB calls each.
TMDB_RECOMMENDATIONS_ENABLED=true
TMDB_RECOMMENDATIONS_LIMIT=300
TMDB_RECOMMENDATIONS_CONCURRENCY=3
# A fetched list is refreshed after 14 days; a failed fetch is retried after 6 hours.
TMDB_RECOMMENDATIONS_REFRESH_MS=1209600000
TMDB_RECOMMENDATIONS_RETRY_MS=21600000
```

Compose nạp `.env` bằng `env_file`, nên **không** sửa `deploy/compose.yml`.

**Kiểm tra:** `cd backend && node -e "import('./src/config.js').then(({config})=>console.log(config.tmdbRecommendationsLimit, config.tmdbRecommendationsRefreshMs))"`
in ra `300 1209600000`.

## Task 3. `fetchTmdbRecommendations` trong `backend/src/tmdb.js`

Thêm vào cuối file (dùng `fetchTmdb`, `validMovieId`, `validMediaType` sẵn có):

```js
function resultIds(body) {
  const ids = [];
  const seen = new Set();
  for (const result of Array.isArray(body?.results) ? body.results : []) {
    const id = validMovieId(result?.id);
    if (id && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * First page of TMDB's recommendations and similar lists for one identity.
 * A 404 propagates with `error.status === 404` so the caller can record the
 * identity as not found instead of retrying it like a transient failure —
 * a guessed lookup id that TMDB no longer knows is the usual cause.
 */
export async function fetchTmdbRecommendations(identity, options = {}) {
  const tmdbId = validMovieId(identity?.tmdbId);
  const mediaType = validMediaType(identity?.mediaType);
  if (!tmdbId || !mediaType) throw new Error('TMDB identity is incomplete');
  const base = '/' + mediaType + '/' + tmdbId;
  const recommended = resultIds(await fetchTmdb(base + '/recommendations?page=1', options));
  const similar = resultIds(await fetchTmdb(base + '/similar?page=1', options));
  return { recommended, similar };
}
```

## Task 4. Module thuần `backend/src/recommendations.js`

File mới, **không import gì từ DB/config**, để test được không cần PostgreSQL:

```js
export const RECOMMENDATION_LIMIT = 16;
export const RECOMMENDATION_MINIMUM = 4;

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * The TMDB identity a catalog row's recommendations are fetched for.
 *
 * A verified tmdb_id wins. The two guessed ids come next: they may be wrong,
 * but a wrong guess only costs this row a less relevant rail — it is never
 * written back to tmdb_id, so it cannot merge titles.
 */
export function recommendationSource(row) {
  if (!row) return null;
  const verified = positiveId(row.tmdb_id);
  if (verified && (row.tmdb_media_type === 'movie' || row.tmdb_media_type === 'tv')) {
    return { mediaType: row.tmdb_media_type, tmdbId: verified };
  }
  if (row.media_type !== 'movie' && row.media_type !== 'tv') return null;
  const guessed = positiveId(row.tmdb_lookup_id) || positiveId(row.tmdb_image_fallback_id);
  return guessed ? { mediaType: row.media_type, tmdbId: guessed } : null;
}

/** Recommendations first, then similar, deduplicated, never the source itself. */
export function mergeRecommendationIds(recommended, similar, excludeId) {
  const exclude = positiveId(excludeId);
  const ids = [];
  const seen = new Set();
  for (const value of [...(recommended || []), ...(similar || [])]) {
    const id = positiveId(value);
    if (id && id !== exclude && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * TMDB-ranked rows first, then genre fill, one card per catalog row, capped.
 * Fewer than the minimum reads as an empty rail, not a sparse one.
 */
export function combineRecommendationRows(ranked, fill, options = {}) {
  const limit = options.limit ?? RECOMMENDATION_LIMIT;
  const minimum = options.minimum ?? RECOMMENDATION_MINIMUM;
  const rows = [];
  const seen = new Set();
  for (const row of [...(ranked || []), ...(fill || [])]) {
    if (!row?.id || seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
    if (rows.length >= limit) break;
  }
  return rows.length >= minimum ? rows : [];
}
```

## Task 5. Test Phase 1

Tạo `backend/test/recommendations.test.js` theo giọng `tmdb-fallback.test.js`
(`node:test` + `assert/strict`). Tối thiểu các test sau:

- `recommendationSource`: `tmdb_id` + `tmdb_media_type='tv'` → dùng `tmdb_id`
  kể cả khi có `tmdb_lookup_id`; không có `tmdb_id` → dùng `tmdb_lookup_id`
  với `media_type`; chỉ có `tmdb_image_fallback_id` → dùng nó; id dạng chuỗi
  `'123'` (pg trả bigint là chuỗi) → `123`; `media_type='hoathinh'` không có
  `tmdb_id` → `null`; không có id nào → `null`.
- `mergeRecommendationIds`: giữ thứ tự recommended trước similar; bỏ trùng; bỏ
  `excludeId`; bỏ `0`, `-1`, `'abc'`.
- `combineRecommendationRows`: ranked đứng trước fill; row trùng `id` chỉ giữ
  một; cắt ở `limit`; ít hơn `minimum` → `[]`.
- `fetchTmdbRecommendations` với `fetchImpl` giả, truyền
  `{ apiKey: 'k', baseUrl: 'https://tmdb.test/3', fetchImpl }`:
  - gọi đúng hai path `/tv/42/recommendations` và `/tv/42/similar`
    (kiểm `url.pathname` và `url.searchParams.get('page') === '1'`);
  - trả `{ recommended, similar }` đã bỏ trùng và bỏ id không hợp lệ;
  - response `status: 404` → promise reject với `error.status === 404`;
  - `mediaType: 'hoathinh'` → reject `TMDB identity is incomplete`.

**Kiểm tra:** `cd backend && node --test` xanh 100%, số test tăng đúng bằng số
test mới.

## Task 6. Repository: đọc/ghi danh sách và chọn ứng viên

Trong `backend/src/repository.js`:

**6a.** Thêm ngay sau `recordTmdbLookup`:

```js
/**
 * TMDB identities whose recommendation lists are missing or due. Never-fetched
 * identities go first, newest catalog rows first, so the pages visitors reach
 * soonest get a rail soonest.
 */
export async function listTmdbRecommendationCandidates(limit = config.tmdbRecommendationsLimit) {
  const result = await pool.query(
    'WITH keys AS (' +
    '  SELECT DISTINCT ON (k.media_type, k.tmdb_id) k.media_type, k.tmdb_id, m.catalog_sort_at FROM movies m ' +
    '  CROSS JOIN LATERAL (SELECT ' +
    "    CASE WHEN m.tmdb_id IS NOT NULL AND m.tmdb_media_type IN ('movie','tv') THEN m.tmdb_media_type ELSE m.media_type END AS media_type, " +
    "    CASE WHEN m.tmdb_id IS NOT NULL AND m.tmdb_media_type IN ('movie','tv') THEN m.tmdb_id " +
    '         ELSE COALESCE(m.tmdb_lookup_id::bigint, m.tmdb_image_fallback_id) END AS tmdb_id) k ' +
    "  WHERE m.catalog_state='ready' AND k.tmdb_id IS NOT NULL AND k.media_type IN ('movie','tv') " +
    '  ORDER BY k.media_type, k.tmdb_id, m.catalog_sort_at DESC NULLS LAST' +
    ') ' +
    'SELECT keys.media_type, keys.tmdb_id FROM keys ' +
    'LEFT JOIN tmdb_recommendations r ON r.media_type=keys.media_type AND r.tmdb_id=keys.tmdb_id ' +
    'WHERE r.tmdb_id IS NULL ' +
    "  OR (r.status <> 'error' AND r.fetched_at < now() - ($1::bigint * interval '1 millisecond')) " +
    "  OR (r.status = 'error' AND r.fetched_at < now() - ($2::bigint * interval '1 millisecond')) " +
    'ORDER BY (r.tmdb_id IS NULL) DESC, keys.catalog_sort_at DESC NULLS LAST LIMIT $3',
    [config.tmdbRecommendationsRefreshMs, config.tmdbRecommendationsRetryMs, Math.max(1, Math.floor(limit))]
  );
  return result.rows;
}

/**
 * Record one fetch. A failed fetch keeps the ids from the last good one, so a
 * TMDB outage degrades to a stale rail rather than an empty one.
 */
export async function recordTmdbRecommendations(mediaType, tmdbId, status, lists = null, message = null) {
  if (status === 'error') {
    await pool.query(
      'INSERT INTO tmdb_recommendations (media_type, tmdb_id, status, last_error, fetched_at) ' +
      "VALUES ($1,$2,'error',$3,now()) ON CONFLICT (media_type, tmdb_id) DO UPDATE SET " +
      "status='error', last_error=EXCLUDED.last_error, fetched_at=now()",
      [mediaType, tmdbId, String(message || 'unknown error').slice(0, 500)]
    );
    return;
  }
  const allowed = ['ok', 'empty', 'not_found'].includes(status) ? status : 'empty';
  await pool.query(
    'INSERT INTO tmdb_recommendations (media_type, tmdb_id, recommended_ids, similar_ids, status, last_error, fetched_at) ' +
    'VALUES ($1,$2,$3::bigint[],$4::bigint[],$5,NULL,now()) ON CONFLICT (media_type, tmdb_id) DO UPDATE SET ' +
    'recommended_ids=EXCLUDED.recommended_ids, similar_ids=EXCLUDED.similar_ids, ' +
    'status=EXCLUDED.status, last_error=NULL, fetched_at=now()',
    [mediaType, tmdbId, lists?.recommended || [], lists?.similar || [], allowed]
  );
}
```

**Kiểm tra (chỉ đọc, trên DB thật):** chạy phần `WITH keys AS (…) SELECT count(*) FROM keys`
qua `.claude/skills/db-query/q.sh`. Đo ngày 2026-09-12: 21.632 identity (14.572
movie, 7.060 tv). Kỳ vọng: **20.000–24.000**.
Ngoài khoảng đó → DỪNG, báo con số. (Bảng `tmdb_recommendations` chưa tồn tại
trên DB thật, nên không chạy nguyên câu có `LEFT JOIN`.)

## Task 7. Worker pass

Trong `backend/src/worker.js`:

- Thêm `fetchTmdbRecommendations` vào import từ `./tmdb.js`, và
  `listTmdbRecommendationCandidates`, `recordTmdbRecommendations` vào import từ
  `./repository.js`.
- Thêm hàm ngay sau `refreshTmdbLookups()`:

```js
/**
 * Fetch TMDB recommendation/similar id lists for the detail-page rail.
 *
 * Runs after the lookup pass because that pass is what gives most rows an id
 * to fetch for. Returns nothing: the rail is matched to the catalog at read
 * time and its response carries its own TTL, so nothing here needs purging.
 */
async function refreshTmdbRecommendations() {
  if (!config.tmdbEnabled || !config.tmdbRecommendationsEnabled || !config.tmdbApiKey) return;
  const candidates = await listTmdbRecommendationCandidates();
  if (!candidates.length) return;

  const counts = { ok: 0, empty: 0, not_found: 0, error: 0 };
  await mapLimit(candidates, config.tmdbRecommendationsConcurrency, async (candidate) => {
    const mediaType = candidate.media_type;
    const tmdbId = Number(candidate.tmdb_id);
    try {
      const lists = await fetchTmdbRecommendations({ mediaType, tmdbId });
      const status = lists.recommended.length || lists.similar.length ? 'ok' : 'empty';
      counts[status] += 1;
      await recordTmdbRecommendations(mediaType, tmdbId, status, lists);
    } catch (error) {
      const status = error.status === 404 ? 'not_found' : 'error';
      counts[status] += 1;
      await recordTmdbRecommendations(mediaType, tmdbId, status, null, error.message).catch(() => {});
    }
  });

  console.log('[worker] tmdb recommendations checked=' + candidates.length +
    ' ok=' + counts.ok + ' empty=' + counts.empty +
    ' not_found=' + counts.not_found + ' error=' + counts.error);
}
```

- Trong `syncCycle()`, ngay sau dòng `if (!stopping) await refreshTmdbLookups();` thêm:

```js
  if (!stopping) {
    await refreshTmdbRecommendations().catch((error) => {
      console.warn('[worker] tmdb recommendations pass failed', error.message);
    });
  }
```

**Kiểm tra:** `cd backend && node --test` xanh 100%;
`node --check src/worker.js` không lỗi.

## Commit Phase 1

`feat(recommendations): worker lưu danh sách gợi ý TMDB theo identity` — gồm
Task 1–7 và chính file plan này.

---

# Phase 2 — Backend: API đọc gợi ý

## Task 8. Resolver trong `backend/src/repository.js`

Thêm `import { mergeRecommendationIds, recommendationSource, combineRecommendationRows, RECOMMENDATION_LIMIT } from './recommendations.js';`
ở đầu file.

**Thay toàn bộ** hàm `export async function recommendations(mediaType, tmdbId, limit = 16) { … }`
bằng:

```js
const imagePresent = (alias) =>
  'COALESCE(' + alias + '.tmdb_thumb_asset_id, ' + alias + '.thumb_asset_id, ' + alias + '.poster_asset_id) IS NOT NULL';

/**
 * Catalog rows matching a ranked TMDB id list, one row per TMDB id (a series
 * resolves to its latest season), in TMDB's order. Matches through the two
 * guessed-id columns only on rows without a verified tmdb_id, the same
 * precedence `recommendationSource` uses.
 */
async function rankedRecommendationRows(ids, mediaType, sourceMovieId) {
  if (!ids.length) return [];
  const result = await pool.query(
    'WITH ranked(tmdb_id, position) AS (SELECT * FROM unnest($1::bigint[]) WITH ORDINALITY), ' +
    'hits AS (' +
    '  SELECT m.*, ranked.position FROM ranked JOIN movies m ON m.tmdb_id=ranked.tmdb_id AND m.tmdb_media_type=$2 ' +
    '  UNION ALL ' +
    '  SELECT m.*, ranked.position FROM ranked JOIN movies m ON m.tmdb_lookup_id=ranked.tmdb_id AND m.tmdb_id IS NULL AND m.media_type=$2 ' +
    '  UNION ALL ' +
    '  SELECT m.*, ranked.position FROM ranked JOIN movies m ON m.tmdb_image_fallback_id=ranked.tmdb_id AND m.tmdb_id IS NULL AND m.media_type=$2' +
    '), ' +
    'best AS (' +
    '  SELECT DISTINCT ON (hits.position) hits.* FROM hits ' +
    "  WHERE hits.catalog_state='ready' AND hits.canonical_slug<>'' AND hits.id<>$3 " +
    '  AND ' + imagePresent('hits') + ' AND ' + playableSourceExists('hits') +
    '  ORDER BY hits.position, hits.tmdb_season_number DESC NULLS LAST, hits.catalog_sort_at DESC NULLS LAST' +
    ') ' +
    'SELECT * FROM best ORDER BY position LIMIT $4',
    [ids, mediaType, sourceMovieId, RECOMMENDATION_LIMIT]
  );
  return result.rows;
}

/** Newest playable titles sharing the source's first genre and media family. */
async function genreFillRows(movie, excludeIds, limit) {
  const values = [movie.media_type, excludeIds, limit];
  let genreFilter = '';
  const genre = movie.genres?.[0]?.slug;
  if (genre) {
    values.push(genre);
    genreFilter = " AND genres @> jsonb_build_array(jsonb_build_object('slug', $4::text))";
  }
  let seriesFilter = '';
  if (movie.tmdb_id) {
    values.push(movie.tmdb_id);
    seriesFilter = ' AND tmdb_id IS DISTINCT FROM $' + values.length + '::bigint';
  }
  const result = await pool.query(
    "SELECT * FROM movies WHERE catalog_state='ready' AND canonical_slug<>'' AND media_type=$1 " +
    'AND NOT (id = ANY($2::uuid[]))' + genreFilter + seriesFilter +
    ' AND ' + imagePresent('movies') + ' AND ' + playableSourceExists('movies') +
    ' ORDER BY catalog_sort_at DESC NULLS LAST LIMIT $3',
    values
  );
  return result.rows;
}

export async function recommendationsForSlug(slug) {
  const target = await pool.query(
    "SELECT * FROM movies WHERE catalog_state='ready' AND canonical_slug=$1 LIMIT 1",
    [slug]
  );
  const movie = target.rows[0];
  if (!movie) return [];

  let ranked = [];
  const source = recommendationSource(movie);
  if (source) {
    const stored = await pool.query(
      'SELECT recommended_ids, similar_ids FROM tmdb_recommendations WHERE media_type=$1 AND tmdb_id=$2',
      [source.mediaType, source.tmdbId]
    );
    const lists = stored.rows[0];
    if (lists) {
      const ids = mergeRecommendationIds(lists.recommended_ids, lists.similar_ids, source.tmdbId);
      ranked = await rankedRecommendationRows(ids, source.mediaType, movie.id);
    }
  }

  const fill = ranked.length >= RECOMMENDATION_LIMIT
    ? []
    : await genreFillRows(movie, [movie.id, ...ranked.map((row) => row.id)], RECOMMENDATION_LIMIT - ranked.length);
  return combineRecommendationRows(ranked, fill);
}
```

**Kiểm tra (chỉ đọc):** chạy câu SQL của `genreFillRows` qua `q.sh` với một slug
thật (lấy bằng `select canonical_slug, media_type, genres->0->>'slug' from movies where catalog_state='ready' order by catalog_sort_at desc limit 1;`),
thay tham số bằng giá trị cụ thể, thêm `EXPLAIN ANALYZE`. Kỳ vọng: ra ≥ 4 dòng,
thời gian < 200 ms. Chậm hơn → DỪNG, báo plan.

## Task 9. Viewmodel, route, observability

`backend/src/viewmodels.js`:
- Trong import từ `./repository.js`: thay `recommendations` bằng `recommendationsForSlug`.
- **Thay** hàm `buildRecommendations(mediaType, tmdbId)` bằng:

```js
export async function buildRecommendations(slug) {
  return {
    items: (await recommendationsForSlug(slug)).map(card)
  };
}
```

`backend/src/server.js`: **thay** nguyên khối `const recommendationMatch = … return; }`
(route `/api/recommendation/(movie|tv)/(\d+)`) bằng:

```js
  const recommendationMatch = url.pathname.match(/^\/api\/recommendations\/([^/]+)$/);
  if (recommendationMatch) {
    const slug = decodeURIComponent(recommendationMatch[1]);
    await cachedJson(
      request,
      response,
      'recommendations:' + slug,
      () => buildRecommendations(slug),
      3600
    );
    return;
  }
```

`backend/src/observability.js`: thay dòng `/api/recommendation/` bằng
`if (pathname.startsWith('/api/recommendations/')) return '/api/recommendations/:slug';`

`backend/src/worker.js`, trong `invalidateForSlugs()`: ngay sau dòng
`for (const movieSlug of changedSlugs) keys.push('movie:' + movieSlug);` thêm
`for (const movieSlug of changedSlugs) keys.push('recommendations:' + movieSlug);`
— để khi Next xoá tag `movie:<slug>`, lần fetch lại không bị Valkey trả bản cũ.

**Kiểm tra:** `grep -rn "api/recommendation/\|buildRecommendations(media\|recommendations(mediaType" backend/src`
không ra dòng nào. `cd backend && node --test` xanh 100%.

## Commit Phase 2

`feat(recommendations): API /api/recommendations/:slug ghép gợi ý TMDB với catalog`

---

# Phase 3 — Frontend: rail trên trang chi tiết

## Task 10. Hàm server và bỏ hàm cũ

`lib/catalog-server.ts`: thêm `MovieCard` vào import type từ `@/lib/types`, rồi
thêm cuối file:

```ts
export async function getRecommendationsServer(slug: string): Promise<MovieCard[]> {
  "use cache";
  const safeSlug = String(slug || "").trim();
  cacheLife({ stale: 900, revalidate: 3600, expire: 86400 });
  // Same tag as the detail page, so a changed title refreshes its rail too.
  cacheTag(`movie:${safeSlug}`);
  const payload = await fetchCatalog<any>(`/api/recommendations/${encodeURIComponent(safeSlug)}`);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  return items.map(normalizeCard).filter((movie: MovieCard) => movie.slug);
}
```

`lib/catalog.ts`: **xoá** khối comment `/** "Bạn cũng có thể thích" … */` và hàm
`getRecommendation` (dòng ~204–217). Không nơi nào gọi hàm này.

## Task 11. `SectionRow` cho phép không có `href`, và component rail

`components/SectionRow.tsx`:
- Trong kiểu props: `href: string;` → `href?: string;`
- Thay khối `<a href={href} className="group inline-flex min-w-0 items-center gap-2"> … </a>`
  bằng: nếu có `href` thì giữ nguyên khối `<a>` cũ; nếu không có thì chỉ render
  `<div className="inline-flex min-w-0 items-center gap-2">` bọc **đúng thẻ `<h2>` cũ**,
  không có chữ "Khám phá", không có `ChevronRight`. Không đổi class nào khác.

Tạo `components/RecommendationRail.tsx` (Server Component — **không** có `"use client"`):

```tsx
import { SectionRow } from "@/components/SectionRow";
import { getRecommendationsServer } from "@/lib/catalog-server";
import type { MovieCard } from "@/lib/types";

// A failed or empty rail must never cost the visitor the detail page.
export async function RecommendationRail({ slug, returnTo }: { slug: string; returnTo: string }) {
  let items: MovieCard[] = [];
  try {
    items = await getRecommendationsServer(slug);
  } catch {
    return null;
  }
  if (!items.length) return null;
  return <SectionRow title="Có thể bạn cũng thích" items={items} returnTo={returnTo} />;
}
```

`src/app/movie/[slug]/page.tsx`:
- Thêm `import { Suspense } from "react";` và
  `import { RecommendationRail } from "@/components/RecommendationRail";`
- Ngay sau thẻ `</div>` đóng khối `bf-content-width bf-page-gutter` chứa
  "Chọn nguồn Phát" (tức ngay trước `</article>`), thêm:

```tsx
      <Suspense fallback={null}>
        <RecommendationRail slug={movie.slug} returnTo={returnTo} />
      </Suspense>
```

Rail nằm cuối trang nên `fallback={null}` không gây xê dịch bố cục. Ảnh thẻ đã
`loading="lazy"` sẵn trong `MovieCard`. Không thêm hiệu ứng, không thêm nhãn.

**Kiểm tra:**
- `grep -rn "getRecommendation\b" lib components src` không ra dòng nào.
- `npm test` xanh; `npm run build` thành công.

## Commit Phase 3

`feat(detail): rail "Có thể bạn cũng thích" trên trang chi tiết phim`

---

# Phase 4 — Tài liệu và kiểm chứng

## Task 12. Tài liệu, rồi kiểm chứng toàn bộ

- `backend/README.md`, mục "API contract": thay dòng
  `- GET /api/recommendation/:movieOrTv/:tmdbId` bằng
  `- GET /api/recommendations/:canonicalSlug`.
- `CLAUDE.md`, mục Background jobs, gạch đầu dòng **Provider sync**: sau cụm
  "…under a per-key daily budget," thêm
  "refreshes TMDB recommendation/similar id lists for the detail-page rail,".
  Mục Source map: thêm `recommendations.js` vào danh sách `backend/src/` cạnh `repository.js`.
- `docs/FILE_MAP.md`: **không sửa** — file này không liệt kê từng file trong
  `backend/src/` (đã kiểm 2026-09-12).
- Chạy `scripts/verify.sh`. Mọi mục phải qua. Lưu ý: smoke test chạy frontend
  mới với API **đang chạy trên production**, nơi chưa có
  `/api/recommendations/`. Rail sẽ ẩn (endpoint trả 404, component trả `null`) —
  đó là kỳ vọng đúng, và cũng là bằng chứng rail hỏng không làm hỏng trang.
- `git diff --check main` không in gì.

## Commit Phase 4

`docs(recommendations): cập nhật API contract và background jobs`

---

# Sau khi xong — việc của Steve, agent KHÔNG làm

1. Thêm 5 key `TMDB_RECOMMENDATIONS_*` vào `/opt/stacks/blueflare/.env`
   (`deploy/apply-env.sh` chặn deploy nếu thiếu).
2. Merge `feat/recommendations` vào `main`, push, rồi deploy `api worker frontend`.
3. Sau 1–2 chu kỳ worker:
   - log worker có dòng `tmdb recommendations checked=300 ok=… error=…`, `error` ≈ 0;
   - `select status, count(*) from tmdb_recommendations group by 1;` tăng dần;
   - `curl -s http://127.0.0.1:3200/api/recommendations/<slug> | jq '.items|length'`
     ra 4–16 với một phim có `tmdb_id`.
4. Sau khoảng 1 ngày, chạy lại truy vấn mốc ở đầu plan (30 phim ngẫu nhiên) và
   so với 12,4 / 13,3.

**Rollback:** đặt `TMDB_RECOMMENDATIONS_ENABLED=false` để dừng gọi TMDB. API
vẫn đọc danh sách đã lưu và vẫn bù theo thể loại. Migration chỉ thêm bảng và
index, không đổi dữ liệu có sẵn.
