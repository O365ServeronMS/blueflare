# PLAN-002 — Frontend design passes: 2 lỗi phát hiện + Tầng 2/3/4

Trạng thái: **chưa thực hiện**. Lập 2026-09-06.
Điểm xuất phát: commit `87cf8d6` trên branch `design/tier0-tier1-frontend-audit`.

Nguồn: audit frontend theo `.claude/skills/frontend-design/SKILL.md`.

---

# ĐỌC HẾT MỤC NÀY TRƯỚC KHI SỬA BẤT KỲ FILE NÀO

Plan này viết để thực hiện tuần tự, không cần suy luận thêm. Mọi phép sửa đều là
**chuỗi nguyên văn** hoặc **lệnh chạy được**. Nếu một chuỗi "tìm" không khớp
chính xác với file, **DỪNG và báo lại** — đừng đoán chuỗi gần đúng.

## Quy tắc bắt buộc

1. Làm đúng thứ tự Task 1 → 12. Không nhảy cóc, không gộp.
2. Mỗi Task có khối **Kiểm tra** với kết quả kỳ vọng. Sai kỳ vọng thì **DỪNG**,
   báo lại số thực tế. Không tự đi tìm cách sửa khác.
3. Mỗi Phase kết thúc bằng một commit. Commit message ghi rõ số đo nếu Task yêu cầu.
4. **Không** chạy: `deploy/sync-stack.sh`, `docker compose up/down/restart`,
   `systemctl reload caddy`, bất kỳ lệnh nào đụng `/opt/stacks/blueflare`.
   Plan này chỉ sửa codebase.
5. **Không** sửa file nào ngoài danh sách file mà Task nêu tên.
6. **Không** đổi tên biến/hàm, không refactor thêm, không "tiện tay dọn".
7. `cd backend && node --test` báo `providers.test.js` fail với
   `Cannot find package 'pg'` → **đã biết, không phải hồi quy**, đi tiếp.
8. Không thêm thư viện mới. Không thêm biến thể ảnh mới.

## Điều kiện DỪNG ngay lập tức

- `npm run build` thất bại.
- `npm test` có bất kỳ test nào fail.
- Một chuỗi "TÌM" trong plan không xuất hiện đúng nguyên văn trong file.
- Một khối **Kiểm tra** cho kết quả khác kỳ vọng.
- Task 10 (logo) — task đó **bắt buộc dừng** để người duyệt bằng mắt.

Khi DỪNG: báo lại Task số mấy, lệnh nào, output thực tế. Không tự chữa.

## Lệnh dùng lại nhiều lần

Gọi là **[GATE]** trong plan:

```bash
cd /home/ubuntu/blueflare && npm run build && npm test && git diff --check
```

Gọi là **[SMOKE]**:

```bash
cd /home/ubuntu/blueflare
PORT=3399 INTERNAL_CATALOG_URL=http://127.0.0.1:3200 node .next/standalone/server.js > /tmp/bf-smoke.log 2>&1 &
sleep 5
for p in "/" "/list/phim-le" "/list/phim-le?page=2" "/list/phim-le?page=3" \
         "/search?q=avengers" "/favorites" "/history" "/settings" "/healthz"; do
  printf "%-28s %s\n" "$p" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:3399$p")"
done
kill %1
```

Kỳ vọng [SMOKE]: cả 9 dòng đều `200`.

---

# PHASE A — Hai lỗi đã phát hiện

## Task 1 — Sửa lỗi 500 của bộ lọc quốc gia/thể loại

### Bối cảnh (không cần điều tra lại, đã truy xong)

`https://phim.bluesia.net/list/phim-le?country=han-quoc` trả HTTP 200 nhưng 0 phim.
Nguyên nhân ở backend:

```
PostgreSQL 42P18: could not determine data type of parameter $1
  backend/src/repository.js  listCanonical
  backend/src/viewmodels.js  buildCountry
```

`jsonb_build_object` là hàm variadic `"any"` nên PostgreSQL không suy được kiểu
của `$1`. Đã tái hiện và xác nhận cách chữa trên chính DB: thêm `::text`.

### 1.1 — File `backend/src/repository.js`

TÌM (nguyên văn):

```js
      "genres @> jsonb_build_array(jsonb_build_object('slug', ?))",
```

THAY BẰNG:

```js
      "genres @> jsonb_build_array(jsonb_build_object('slug', ?::text))",
```

TÌM (nguyên văn):

```js
      "countries @> jsonb_build_array(jsonb_build_object('slug', ?))",
```

THAY BẰNG:

```js
      "countries @> jsonb_build_array(jsonb_build_object('slug', ?::text))",
```

> Vì sao đúng: hàm `addListFilter` thay **dấu `?` đầu tiên** bằng `$N`, nên
> `?::text` trở thành `$1::text`.

### 1.2 — Thêm hàm tra tên vào `backend/src/repository.js`

TÌM (nguyên văn — đây là cuối hàm `taxonomy`):

```js
  return result.rows;
}

export async function providerHealth() {
```

THAY BẰNG:

```js
  return result.rows;
}

/**
 * Tên hiển thị của một slug taxonomy. Trả lại chính slug nếu không tra được,
 * để trang danh sách luôn có gì đó để hiện thay vì rỗng.
 */
export async function taxonomyName(field, slug) {
  if (!['genres', 'countries'].includes(field)) throw new Error('Invalid taxonomy field');
  if (!slug) return '';
  const result = await pool.query(
    "SELECT item->>'name' AS name FROM movies, jsonb_array_elements(" + field + ') item ' +
    "WHERE item->>'slug' = $1::text LIMIT 1",
    [slug]
  );
  return result.rows[0]?.name || slug;
}

export async function providerHealth() {
```

### 1.3 — File `backend/src/viewmodels.js`

TÌM (nguyên văn):

```js
  recommendations,
  taxonomy
} from './repository.js';
```

THAY BẰNG:

```js
  recommendations,
  taxonomy,
  taxonomyName
} from './repository.js';
```

TÌM (nguyên văn):

```js
export async function buildGenre(slug, page) {
  const result = await listCanonical({ genre: slug, page, limit: 24 });
  return listResponse(result, slug);
}

export async function buildCountry(slug, page) {
  const result = await listCanonical({ country: slug, page, limit: 24 });
  return listResponse(result, slug);
}
```

THAY BẰNG:

```js
export async function buildGenre(slug, page) {
  const [result, name] = await Promise.all([
    listCanonical({ genre: slug, page, limit: 24 }),
    taxonomyName('genres', slug)
  ]);
  return listResponse(result, name);
}

export async function buildCountry(slug, page) {
  const [result, name] = await Promise.all([
    listCanonical({ country: slug, page, limit: 24 }),
    taxonomyName('countries', slug)
  ]);
  return listResponse(result, name);
}
```

> Hai endpoint này đã bọc `cachedJson(..., 300)` nên truy vấn thêm chỉ chạy
> mỗi 5 phút cho mỗi khoá. Không cần lo hiệu năng.

### 1.4 — File `src/app/list/[type]/page.tsx`

TÌM (nguyên văn):

```tsx
  const heading = typeTitles[type] || data.title;
  const activeFilter = country || category;
  const gridLabel = activeFilter ? `${heading}, lọc theo ${activeFilter}` : heading;
```

THAY BẰNG:

```tsx
  const activeFilter = country || category;
  // Khi có bộ lọc, `data.title` là tên bộ lọc chứ không phải tên danh mục, nên
  // tiêu đề phải lấy từ typeTitles trước và chỉ rơi về data.title khi không lọc.
  const heading = typeTitles[type] || (activeFilter ? "Danh sách phim" : data.title);
  const activeFilterLabel = activeFilter ? (data.title || activeFilter) : "";
  const gridLabel = activeFilter ? `${heading}, lọc theo ${activeFilterLabel}` : heading;
```

TÌM (nguyên văn):

```tsx
            <span className="bf-tag bf-tag-outline" aria-current="true">{activeFilter}</span>
```

THAY BẰNG:

```tsx
            <span className="bf-tag bf-tag-outline" aria-current="true">{activeFilterLabel}</span>
```

### Kiểm tra Task 1

```bash
cd /home/ubuntu/blueflare/backend && node --test 2>&1 | tail -5
cd /home/ubuntu/blueflare && npm run build && npm test
```

Kiểm chứng logic SQL trực tiếp trên DB (chỉ đọc, không đụng container app):

```bash
docker exec blueflare-postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -t -c \
  "SELECT count(*) FROM movies WHERE countries @> jsonb_build_array(jsonb_build_object('"'"'slug'"'"', '"'"'han-quoc'"'"'::text));"'
```

Kỳ vọng: một số **≥ 3000**. Nếu ra `0` hoặc lỗi → DỪNG.

> Endpoint `/api/country` chỉ thật sự hết 503 sau khi build lại image `api` và
> restart container. Việc đó **không** thuộc plan này. Ghi câu này vào commit message.

## Task 2 — Xoá 4 component chết

Bốn file dưới đây không được file nào import, và không có `dynamic()`/`lazy()`
nào trỏ tới. Đã xác nhận trước khi lập plan.

### 2.1 — Xác nhận lại trước khi xoá

```bash
cd /home/ubuntu/blueflare
for c in ListIsland HomeIsland SearchResults MovieDetailIsland; do
  echo "$c -> $(grep -rl "$c" --include='*.tsx' --include='*.ts' . | grep -v node_modules | tr '\n' ' ')"
done
```

Kỳ vọng: mỗi dòng chỉ liệt kê **đúng một file — chính nó**. Ví dụ:
`ListIsland -> components/ListIsland.tsx`.
Nếu có file thứ hai → **DỪNG**, đừng xoá.

### 2.2 — Xoá

```bash
cd /home/ubuntu/blueflare
git rm components/ListIsland.tsx components/HomeIsland.tsx \
       components/SearchResults.tsx components/MovieDetailIsland.tsx
```

### Kiểm tra Task 2

```bash
cd /home/ubuntu/blueflare
grep -rn "ListIsland\|HomeIsland\|SearchResults\|MovieDetailIsland" \
  --include='*.tsx' --include='*.ts' . | grep -v node_modules
```

Kỳ vọng: **không ra gì**.

Rồi chạy **[GATE]**.

> `CLAUDE.md` và `docs/FILE_MAP.md` không liệt kê 4 file này nên không cần sửa
> doc. Chúng chỉ xuất hiện trong `docs/archive/` — tài liệu lưu trữ, theo quy ước
> `CLAUDE.md` thì **không viết lại**. Để nguyên.

## Commit Phase A

```bash
git add -A
git commit
```

Message: `fix(catalog): sửa 42P18 ở bộ lọc quốc gia/thể loại, xoá 4 component chết`
Nội dung nêu: nguyên nhân `jsonb_build_object` variadic thiếu ép kiểu; đã xác nhận
trên DB; endpoint cần rebuild image `api` mới hết 503.

---

# PHASE B — Tầng 2: hệ thống hoá

## Task 3 — Gom 8 kích thước H1 về 2 vai trò

Hiện có 14 thẻ tiêu đề với 8 giá trị desktop khác nhau cho cùng một vai trò.
Chuẩn hoá còn **đúng hai**:

| Vai trò | Chuỗi lớp chuẩn |
| --- | --- |
| `hero` (home hero, chi tiết phim) | `text-[34px] sm:text-[46px] md:text-[56px] lg:text-[64px]` |
| `page-title` (mọi trang còn lại) | `text-[32px] sm:text-[44px]` |

Chạy đúng khối này:

```bash
cd /home/ubuntu/blueflare

# hero: trang chi tiết phim khớp với home hero
sed -i 's/text-\[38px\] font-black leading-\[0\.98\] tracking-\[-0\.035em\] text-white sm:text-\[52px\] lg:text-\[64px\]/text-[34px] font-black leading-[0.98] tracking-[-0.035em] text-white sm:text-[46px] md:text-[56px] lg:text-[64px]/' \
  'src/app/movie/[slug]/page.tsx'

# page-title: 34/48 -> 32/44
sed -i 's/text-\[34px\] font-black tracking-tight text-white sm:text-\[48px\]/text-[32px] font-black tracking-tight text-white sm:text-[44px]/' \
  src/app/favorites/page.tsx src/app/history/page.tsx src/app/settings/page.tsx

# page-title: 36 (không có breakpoint) -> 32/44
sed -i 's/text-\[36px\] font-black text-chalk-white/text-[32px] font-black text-chalk-white sm:text-[44px]/' \
  src/app/not-found.tsx src/app/error.tsx

# EmptyState h2: 42 -> 44
sed -i 's/text-\[32px\] font-black tracking-tight text-white sm:text-\[42px\]/text-[32px] font-black tracking-tight text-white sm:text-[44px]/' \
  components/LocalMovieActions.tsx
```

### Kiểm tra Task 3

```bash
cd /home/ubuntu/blueflare
grep -rhoE 'text-\[(2[0-9]|3[0-9]|4[0-9]|5[0-9]|6[0-9])px\][^"]*' components src/app \
  | grep -oE 'text-\[[0-9]+px\]' | sort -u | tr '\n' ' '
```

Kỳ vọng đúng bốn giá trị, không hơn: `text-[32px] text-[34px] text-[44px] text-[46px] text-[56px] text-[64px]`
(sáu giá trị, tạo thành hai vai trò). Nếu xuất hiện `38px`, `42px`, `48px`,
`52px`, `36px`, `28px`, `26px` → DỪNG.

## Task 4 — Khai báo thang chữ và bỏ giá trị tuỳ biến

Hiện có **23 kích thước `text-[Npx]` tuỳ biến**, trong khi thang chữ khai báo ở
`@theme` được dùng **0 lần**.

### 4.1 — Thay khối thang chữ trong `src/styles/globals.css`

TÌM (nguyên văn, 12 dòng liền nhau):

```css
  --text-caption: 13px;
  --leading-caption: 1.5;
  --text-body: 16px;
  --leading-body: 1.5;
  --text-subheading: 20px;
  --leading-subheading: 1.25;
  --text-heading-sm: 24px;
  --leading-heading-sm: 1.2;
  --text-heading: 56px;
  --leading-heading: 1.17;
  --text-display: 100px;
  --leading-display: 1;
```

THAY BẰNG:

```css
  /* Thang chữ đặt tên theo vai trò, không theo cỡ, để đổi giá trị mà không phải
     đụng call site. Cố ý không đè lên text-xs/sm/base của Tailwind. Tầng display
     (32-64px) không nằm ở đây: nó chỉ có hai vai trò và được viết thẳng trong
     lớp của thẻ tiêu đề. */
  --text-micro: 11px;
  --text-caption: 12px;
  --text-control: 13px;
  --text-body: 15px;
  --text-subheading: 17px;
  --text-heading-sm: 20px;
  --text-heading: 24px;
```

### 4.2 — Quy đổi toàn bộ giá trị tuỳ biến

Chạy đúng khối này, đúng thứ tự:

```bash
cd /home/ubuntu/blueflare
FILES=$(git ls-files 'components/*.tsx' 'src/app/**/*.tsx' 'src/app/*.tsx')

sed -i 's/text-\[10px\]/text-micro/g;      s/text-\[11px\]/text-micro/g'      $FILES
sed -i 's/text-\[12px\]/text-caption/g'                                        $FILES
sed -i 's/text-\[13px\]/text-control/g'                                        $FILES
sed -i 's/text-\[14px\]/text-body/g; s/text-\[15px\]/text-body/g; s/text-\[16px\]/text-body/g' $FILES
sed -i 's/text-\[17px\]/text-subheading/g'                                     $FILES
sed -i 's/text-\[20px\]/text-heading-sm/g'                                     $FILES
sed -i 's/text-\[24px\]/text-heading/g'                                        $FILES

# utility mặc định Tailwind còn sót, đổi cho nhất quán
sed -i 's/\btext-sm\b/text-control/g' components/HlsVideo.tsx
```

### 4.3 — Cùng phép quy đổi trong CSS

Trong `src/styles/globals.css`, thay các cỡ chữ viết cứng:

| TÌM | THAY BẰNG |
| --- | --- |
| `  font-size: 13px;` (trong `.bf-play-cta, .bf-secondary-cta, .bf-icon-cta`) | `  font-size: var(--text-control);` |
| `.bf-icon-cta { font-size: 14px; }` (trong `@media (min-width: 768px)`) | `.bf-icon-cta { font-size: var(--text-body); }` |
| `  font-size: 11px;` (trong `.bf-tag`) | `  font-size: var(--text-micro);` |
| `  font-size: 12px;` (trong `.bf-score-row`) | `  font-size: var(--text-caption);` |

> Trong `@media (min-width: 768px)` dòng đó viết là
> `  .bf-play-cta,\n  .bf-secondary-cta,\n  .bf-icon-cta { font-size: 14px; }` —
> chỉ đổi phần `14px` thành `var(--text-body)`.

### 4.4 — Dọn cặp breakpoint thừa

Sau quy đổi, một số chỗ thành `text-body ... sm:text-body` (thừa). Liệt kê:

```bash
cd /home/ubuntu/blueflare
grep -rnE '(text-micro|text-caption|text-control|text-body|text-subheading|text-heading-sm|text-heading)[^"]*\bsm:(text-micro|text-caption|text-control|text-body|text-subheading|text-heading-sm|text-heading)\b' components src/app
```

Với mỗi dòng hiện ra: nếu tên token trước và sau `sm:` **giống hệt nhau**, xoá
phần `sm:<token>` (kèm một dấu cách). Nếu **khác nhau**, để nguyên.

### Kiểm tra Task 4

```bash
cd /home/ubuntu/blueflare
# 1. Không còn cỡ chữ tuỳ biến dưới 32px
grep -rnoE 'text-\[([0-9]|[12][0-9]|3[01])px\]' components src/app
```
Kỳ vọng: **không ra gì**.

```bash
# 2. Chỉ còn tầng display
grep -rhoE 'text-\[[0-9]+px\]' components src/app | sort -u | tr '\n' ' '
```
Kỳ vọng: `text-[32px] text-[34px] text-[44px] text-[46px] text-[56px] text-[64px]`

```bash
# 3. Build rồi xác nhận Tailwind thật sự sinh ra utility mới
npm run build
CSS=$(ls .next/static/chunks/*.css | head -1)
for t in text-micro text-caption text-control text-body text-subheading text-heading-sm text-heading; do
  printf "%-18s %s\n" "$t" "$(grep -c "\.$t" "$CSS")"
done
```
Kỳ vọng: **mọi dòng đều ≥ 1**. Có dòng nào `0` → DỪNG (nghĩa là token không sinh
utility, hoặc không chỗ nào dùng).

Rồi chạy **[GATE]** và **[SMOKE]**.

## Task 5 — Viết lại copy lỗi và trạng thái rỗng

Nguyên tắc: nói **cái gì hỏng** + **làm gì tiếp**. Không xin lỗi, không tả cơ chế
hệ thống, không văn vẻ.

### 5.1 — `src/app/error.tsx`

TÌM:
```tsx
        <h1 className="mt-3 text-[32px] font-black text-chalk-white sm:text-[44px]">Rạp phim đang tạm nghỉ.</h1>
        <p className="mt-3 max-w-md text-body leading-6 text-silver">Blueflare chưa thể tải danh mục lúc này. Bạn có thể thử lại sau.</p>
        <button type="button" onClick={() => reset()} className="mt-6 min-h-11 rounded bg-chalk-white px-5 text-body font-bold text-deep-space">Thử lại</button>
```

THAY BẰNG:
```tsx
        <h1 className="mt-3 text-[32px] font-black text-chalk-white sm:text-[44px]">Không tải được danh mục phim.</h1>
        <p className="mt-3 max-w-md text-body leading-6 text-silver">Máy chủ danh mục không phản hồi. Thử lại, hoặc mở phim bạn đã lưu.</p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button type="button" onClick={() => reset()} className="bf-play-cta">Thử lại</button>
          <a href="/favorites" className="bf-secondary-cta">Phim đã lưu</a>
        </div>
```

> Nếu chuỗi trên không khớp vì Task 4 đã đổi token khác dự đoán: mở file, giữ
> nguyên mọi lớp, **chỉ đổi phần chữ tiếng Việt** và thêm khối hai nút. Nếu vẫn
> không chắc → DỪNG.

### 5.2 — `src/app/not-found.tsx`

TÌM: `Đường dẫn này không còn tồn tại hoặc nội dung đã được chuyển.`
THAY BẰNG: `Đường dẫn này không còn tồn tại. Quay về trang chủ hoặc tìm phim theo tên.`

### 5.3 — `components/StoredMovieGrid.tsx`

TÌM (nguyên văn):
```tsx
    return <EmptyState title={type === "favorites" ? "Chưa có phim yêu thích" : "Chưa có lịch sử xem"} description="Dữ liệu này được lưu cục bộ trong trình duyệt của bạn, không gửi lên máy chủ." />;
```

THAY BẰNG:
```tsx
    return (
      <EmptyState
        title={type === "favorites" ? "Chưa có phim yêu thích" : "Chưa có lịch sử xem"}
        description={type === "favorites"
          ? "Bấm biểu tượng trái tim ở bất kỳ phim nào để lưu vào đây."
          : "Phim bạn mở trình phát sẽ được ghi lại ở đây."}
      />
    );
```

### 5.4 — `src/app/settings/page.tsx`

TÌM: `Blueflare là giao diện khám phá phim render trên VPS, tối ưu cho tốc độ và trải nghiệm xem liền mạch.`
THAY BẰNG: `Blueflare là nơi tìm và xem phim, không cần tài khoản.`

TÌM (cả thẻ `<section>` "Nguồn dữ liệu", nguyên văn):
```tsx
        <section><h2 className="text-body font-bold text-white">Nguồn dữ liệu</h2><p className="mt-3 break-all text-control leading-6 text-silver">https://img.bluesia.net/api/*</p><p className="mt-2 text-control leading-6 text-ash">Catalog, metadata, tập phim và ảnh ký sẵn được phục vụ bởi catalog-api. Frontend không proxy video.</p></section>
```

THAY BẰNG:
```tsx
        <section><h2 className="text-body font-bold text-white">Nguồn dữ liệu</h2><p className="mt-3 text-control leading-6 text-silver">Thông tin phim và ảnh do Blueflare tự lưu và phục vụ.</p><p className="mt-2 text-control leading-6 text-ash">Video phát trực tiếp từ nguồn bên thứ ba. Blueflare không lưu và không trung chuyển tệp video.</p></section>
```

> Nếu tên lớp trong chuỗi trên khác thực tế (do Task 4), giữ nguyên lớp thực tế,
> chỉ đổi phần chữ.

TÌM: `<header className="max-w-3xl">`
THAY BẰNG: `<header className="max-w-2xl">`

> Vì sao: `text-body` (15px) trong `max-w-3xl` (768px) cho ~100 ký tự mỗi dòng.
> Skill đặt ngưỡng dưới 80.

### Kiểm tra Task 5

```bash
cd /home/ubuntu/blueflare
grep -rn "render trên VPS\|img.bluesia.net/api\|catalog-api\|Rạp phim đang tạm nghỉ\|lưu cục bộ trong trình duyệt" src components
```
Kỳ vọng: **không ra gì**.

Rồi **[GATE]**.

## Task 6 — Hero: bỏ remount, làm crossfade thật

`key={active.slug}` khiến `<img>` bị remount mỗi 7 giây, kéo `.bf-reveal`
(`opacity 0 → translateY(8px)`) chạy lại vô hạn — đúng cái "fade-and-slide-up
entrance" mà skill gọi là dấu hiệu generic. Nó cũng khiến crossfade **không thể**
xảy ra vì remount huỷ ảnh cũ.

### 6.1 — Nâng `heroImage` lên trước early return

**Đây là bước dễ sai nhất trong plan. Đọc kỹ.**

React cấm gọi hook sau một `return` có điều kiện. Hiện tại:

```
  const active = slides[visibleIndex];                    ← dòng ~54
  const { isFavorite, toggle } = useFavoriteToggle(...);  ← hook cuối cùng
  if (!slides.length) return null;                        ← early return
  const heroImage = active.poster || active.thumb;        ← nằm SAU early return
```

Effect mới cần đọc `heroImage`, nên `heroImage` phải chuyển lên **trước** early return.

Trong `components/HeroSlider.tsx`, TÌM (nguyên văn):

```tsx
  const active = slides[visibleIndex];
  const { isFavorite, toggle: toggleFavorite } = useFavoriteToggle(active || EMPTY_MOVIE);

  if (!slides.length) return null;
  const heroImage = active.poster || active.thumb;
```

THAY BẰNG:

```tsx
  const active = slides[visibleIndex];
  // `active` là undefined khi slides rỗng, nên phải guard: dòng này chạy trước
  // early return để effect crossfade bên dưới đọc được.
  const heroImage = active ? active.poster || active.thumb : "";

  // Giữ ảnh đang đi ra thêm một nhịp để lần đổi slide đọc ra là hoà hình chứ
  // không phải nháy đen. Tối đa 2 lớp cùng lúc.
  useEffect(() => {
    if (!heroImage) return;
    setImageStack((current) => {
      const top = current[current.length - 1];
      if (top === heroImage) return current;
      return top ? [top, heroImage] : [heroImage];
    });
  }, [heroImage]);

  const { isFavorite, toggle: toggleFavorite } = useFavoriteToggle(active || EMPTY_MOVIE);

  if (!slides.length) return null;
```

### 6.2 — Thêm state

TÌM (nguyên văn):

```tsx
  const [interactionPaused, setInteractionPaused] = useState(false);
```

THAY BẰNG:

```tsx
  const [interactionPaused, setInteractionPaused] = useState(false);
  const [imageStack, setImageStack] = useState<string[]>([]);
```

### 6.3 — Thay thẻ `<img>` bằng hai lớp

TÌM (nguyên văn, cả thẻ):

```tsx
      <img
        key={active.slug}
        src={heroImage}
        alt=""
        width={1280}
        height={720}
        loading={visibleIndex === 0 ? "eager" : "lazy"}
        fetchPriority={visibleIndex === 0 ? "high" : "auto"}
        decoding="async"
        className="absolute inset-0 h-full w-full object-cover object-center bf-reveal"
        data-movie-poster
        data-fallback-src={active.thumb || undefined}
        data-original-src={heroImage || undefined}
        data-placeholder-src="/image-placeholder.svg"
      />
```

THAY BẰNG:

```tsx
      {imageStack.map((src, index) => (
        <img
          key={src}
          src={src}
          alt=""
          width={1280}
          height={720}
          loading={imageStack.length === 1 ? "eager" : "lazy"}
          fetchPriority={imageStack.length === 1 ? "high" : "auto"}
          decoding="async"
          className={index === imageStack.length - 1 ? "bf-hero-layer is-active" : "bf-hero-layer"}
          data-movie-poster
          data-fallback-src={active.thumb || undefined}
          data-original-src={src}
          data-placeholder-src="/image-placeholder.svg"
        />
      ))}
```

### 6.4 — CSS

Trong `src/styles/globals.css`, TÌM (nguyên văn):

```css
@keyframes bf-reveal {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.bf-reveal { animation: bf-reveal 420ms ease both; }
```

THAY BẰNG:

```css
/* Hai lớp ảnh chồng nhau cho hero. `:only-child` giữ khung hình đầu tiên hiện
   ngay ở opacity 1 — nếu để nó fade vào thì LCP bị tính trễ đúng bằng thời
   lượng transition. */
.bf-hero-layer {
  position: absolute;
  inset: 0;
  height: 100%;
  width: 100%;
  object-fit: cover;
  object-position: center;
  opacity: 0;
  transition: opacity 600ms ease;
}
.bf-hero-layer.is-active { opacity: 1; }
.bf-hero-layer:only-child { opacity: 1; transition: none; }

@media (prefers-reduced-motion: reduce) {
  .bf-hero-layer { transition: none; }
}
```

### Kiểm tra Task 6

```bash
cd /home/ubuntu/blueflare
grep -rn "bf-reveal" components src/app src/styles
```
Kỳ vọng: **không ra gì**.

```bash
# Mọi hook phải nằm trên early return
awk '/if \(!slides.length\) return null/{stop=NR} /useState|useEffect|useFavoriteToggle|useRef|useMemo/{if(stop && NR>stop) print "HOOK SAU EARLY RETURN dòng " NR}' components/HeroSlider.tsx
```
Kỳ vọng: **không ra gì**. Có dòng nào → DỪNG.

Rồi **[GATE]** và **[SMOKE]**.

```bash
# hero phải render đúng 1 lớp ở lần tải đầu
curl -s http://127.0.0.1:3399/ | grep -o 'bf-hero-layer' | wc -l
```
Kỳ vọng: `1`.

## Commit Phase B

Message: `refactor(ui): thang chữ theo vai trò, copy chỉ đường, hero crossfade`
Ghi vào message: 23 cỡ chữ tuỳ biến → 7 token + 2 vai trò display.

---

# PHASE C — Tầng 3: typeface và mật độ thẻ

## Task 7 — Đổi Inter → Be Vietnam Pro (phần chữ nội dung)

Đã verify trên Google Fonts API: Be Vietnam Pro có subset `vietnamese` thật, và
đủ cả 4 weight đang dùng (400/500/700/900 — đều trả HTTP 200).

> **Be Vietnam Pro không phải variable font.** Bắt buộc khai `weight` tường minh.
> Nó tải 4 file tĩnh thay vì 1 file variable như Inter. Đây là đánh đổi đã chấp
> nhận; Task 12 sẽ đo lại.

### 7.1 — `src/app/layout.tsx`

TÌM (nguyên văn):

```tsx
import { Inter } from "next/font/google";
```

THAY BẰNG:

```tsx
import { Be_Vietnam_Pro } from "next/font/google";
```

TÌM (nguyên văn):

```tsx
// Netflix Sans stand-in named by DESIGN.md. Self-hosted by next/font, so the
// real weight 900 is available — without it the browser synthesizes a faux
// bold from the system fallback and heavy type (the Top-10 numerals) is wrong.
const inter = Inter({
  subsets: ["latin", "vietnamese"],
  variable: "--font-inter",
  display: "swap"
});
```

THAY BẰNG:

```tsx
// Be Vietnam Pro: dấu thanh tiếng Việt được vẽ chủ đích thay vì chắp thêm, quan
// trọng với giao diện toàn tiếng Việt có nhiều tiêu đề nén chặt. Không phải
// variable font nên weight phải liệt kê tường minh — 900 là bắt buộc, thiếu nó
// thì numeral Top-10 và H1 hero bị trình duyệt tổng hợp faux-bold.
const bodyFont = Be_Vietnam_Pro({
  subsets: ["latin", "vietnamese"],
  weight: ["400", "500", "700", "900"],
  variable: "--font-bf",
  display: "swap"
});
```

TÌM: `className={inter.variable}`
THAY BẰNG: `className={bodyFont.variable}`

### 7.2 — `src/styles/globals.css`

Có **hai** dòng cần đổi, cả hai đều chứa `var(--font-inter), Inter, Roboto,`.

```bash
cd /home/ubuntu/blueflare
sed -i 's/var(--font-inter), Inter, Roboto, ui-sans-serif/var(--font-bf), "Be Vietnam Pro", ui-sans-serif/g' \
  src/styles/globals.css
```

Kiểm tra ngay:
```bash
grep -c 'var(--font-bf)' src/styles/globals.css
```
Kỳ vọng: `2`. Khác → DỪNG.

### Kiểm tra Task 7

```bash
cd /home/ubuntu/blueflare
grep -rn "font-inter\|\bInter\b" src components --include='*.tsx' --include='*.css'
```
Kỳ vọng: **chỉ còn 4 dòng trong `components/logo/`** (xử lý ở Task 10). Nếu còn
dòng nào ngoài `components/logo/` → DỪNG.

```bash
npm run build
ls .next/static/media/*.woff2 | wc -l
```
Ghi lại con số này vào commit message (số file font sau khi đổi).

Rồi **[GATE]** và **[SMOKE]**.

## Task 8 — Gom mật độ thẻ phim

Một thẻ rộng ~190px đang gánh 6 lớp: số hạng Top-10, tag đỏ trạng thái, tag vàng
điểm, 🍅%, 🍿%, tiêu đề — cộng dòng `year · country`.

Quyết định đã chốt: **trên ảnh chỉ giữ số hạng Top-10; tất cả phần còn lại gom
vào đúng một dòng meta dưới tiêu đề.**

### 8.1 — `components/MovieCard.tsx`, nhánh poster

TÌM (nguyên văn):

```tsx
          {status ? (
            <span className="bf-tag bf-tag-accent absolute left-2 top-2">{status}</span>
          ) : null}
          {displayRating ? (
            <span className="bf-tag bf-tag-gold absolute right-2 top-2">{displayRating.score.toFixed(1)}</span>
          ) : null}
        </div>
        <ScoreBadges movie={movie} className="mt-2" />
        <Title className={compact ? "mt-1 line-clamp-1 text-control font-medium text-chalk-white" : "mt-1 line-clamp-1 text-body font-medium text-chalk-white"}>{movie.name}</Title>
        {!compact ? (
          <p className="mt-1 line-clamp-1 text-caption text-silver">{[movie.year, movie.country].filter(Boolean).join(" · ")}</p>
        ) : null}
```

THAY BẰNG:

```tsx
        </div>
        <Title className={compact ? "mt-2 line-clamp-1 text-control font-medium text-chalk-white" : "mt-2 line-clamp-1 text-body font-medium text-chalk-white"}>{movie.name}</Title>
        <p className="bf-card-meta">
          <ScoreBadges movie={movie} className="!text-caption" reserveSpace={false} />
          {displayRating ? <span className="font-bold text-luxury-gold">{displayRating.score.toFixed(1)}</span> : null}
          {status ? <span>{status}</span> : null}
          {movie.year ? <span>{movie.year}</span> : null}
        </p>
```

> Nếu chuỗi `text-control`/`text-body`/`text-caption` không khớp vì Task 4 cho
> kết quả khác, mở file và đối chiếu bằng mắt — cấu trúc cần đạt là: đóng `</div>`
> của khung ảnh, rồi `<Title>`, rồi đúng một `<p className="bf-card-meta">`.
> Hai khối `bf-tag` tuyệt đối phải biến mất. `{rank ? ... bf-rank ...}` phải giữ.

> `movie.country` bị bỏ khỏi thẻ có chủ đích: đó là thông tin ít ai quét trong
> lưới, và là chỗ cuối cùng còn dùng `join(" · ")` — một trong các dấu hiệu
> generic mà skill nêu đích danh.

### 8.2 — `src/styles/globals.css`

TÌM (nguyên văn, cả comment):

```css
/* The row of 🍅/🍿 percentages between a poster and its title. The height is
   reserved whether or not either badge is present: most rows carry no critic
   score, so an unreserved row would shift the grid on the few that do. */
```

THAY BẰNG:

```css
/* Hàng phần trăm 🍅/🍿. Chiều cao được giữ vô điều kiện khi hàng này đứng riêng
   (hero, thẻ landscape). Ở thẻ poster nó nằm lồng trong `.bf-card-meta`, và
   chính `.bf-card-meta` mới là thứ giữ cho lưới không xô. */
```

Rồi thêm khối mới ngay **sau** định nghĩa `.bf-tag-outline[aria-current="true"]`:

```css
/* Dòng meta duy nhất dưới tiêu đề thẻ poster. Chiều cao giữ vô điều kiện: phần
   lớn phim không có điểm phê bình, nên dòng co lại sẽ xô cả lưới ở đúng những
   thẻ có điểm. */
.bf-card-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 18px;
  margin-top: 4px;
  overflow: hidden;
  white-space: nowrap;
  font-size: var(--text-caption);
  line-height: 1;
  color: var(--color-silver);
}
```

### Kiểm tra Task 8

```bash
cd /home/ubuntu/blueflare && npm run build
```
Rồi **[SMOKE]**, và trong lúc server 3399 còn chạy:

```bash
curl -s http://127.0.0.1:3399/list/phim-le -o /tmp/grid.html
echo "thẻ phim:      $(grep -o 'bf-media-card' /tmp/grid.html | wc -l)"
echo "dòng meta:     $(grep -o 'bf-card-meta' /tmp/grid.html | wc -l)"
echo "tag đè lên ảnh: $(grep -o 'bf-tag bf-tag-accent absolute\|bf-tag bf-tag-gold absolute' /tmp/grid.html | wc -l)"
```

Kỳ vọng: `thẻ phim` và `dòng meta` **bằng nhau**; `tag đè lên ảnh` = **0**.
Lệch → DỪNG.

## Commit Phase C (phần chữ + thẻ)

Message: `feat(ui): Be Vietnam Pro thay Inter, gom meta thẻ phim về một dòng`

## Task 9 — Cập nhật `docs/blueflare-ui-v2.md`

TÌM: `- Typography: Inter, Roboto, system UI. One family, 400/500/700/900.`
THAY BẰNG: `- Typography: Be Vietnam Pro. One family, 400/500/700/900. Not a variable font — weights are loaded explicitly.`

TÌM: `- Hero crossfade: 500–700ms, with only the active image requested eagerly.`
THAY BẰNG: `- Hero crossfade: 600ms between two stacked layers; only the first image is requested eagerly.`

TÌM: `- Cards show minimal status; titles are visible where orientation and context require them.`
THAY BẰNG: `- Poster cards carry only the Top-10 numeral over the artwork; status, ratings and year share one meta line below the title.`

## Task 10 — LOGO: DỪNG BẮT BUỘC, CẦN NGƯỜI DUYỆT

**Không tự làm task này. Đọc rồi báo lại.**

`components/logo/BlueflareIcon.tsx` (3 chỗ) và `components/logo/BlueflareWordmark.tsx`
(1 chỗ) đang ghi:

```
fontFamily="var(--font-display), Archivo, var(--font-inter), sans-serif"
```

Hai vấn đề:

1. `--font-display` **chưa từng được định nghĩa ở đâu trong repo**, và Archivo
   không được load. Logo đang âm thầm rơi về Inter suốt từ đầu.
2. Sau Task 7, `--font-inter` cũng không còn. Logo sẽ rơi thẳng về `sans-serif`
   của hệ thống — khác nhau trên mỗi máy.

Ngoài ra logo dùng `font-stretch="72%"` (wordmark) và `font-stretch="70%"` (icon).
**Be Vietnam Pro không có trục width**, nên `font-stretch` sẽ bị bỏ qua và chữ sẽ
rộng ra, có thể tràn `viewBox="0 0 340 56"`.

Đây là thay đổi phải nhìn bằng mắt mới duyệt được, nên **dừng ở đây và báo lại**:

> "Task 10 cần duyệt bằng mắt: logo mất font-stretch khi đổi sang Be Vietnam Pro.
> Cần quyết định: (a) chấp nhận wordmark rộng hơn và chỉnh font-size/letter-spacing,
> (b) chuyển logo sang SVG path tĩnh, hay (c) load thêm một font có trục width
> riêng cho logo."

---

# PHASE D — Tầng 4: hiệu năng

## Task 11 — Đo trước

```bash
cd /home/ubuntu/blueflare && npm run build
PORT=3399 INTERNAL_CATALOG_URL=http://127.0.0.1:3200 node .next/standalone/server.js > /tmp/bf-smoke.log 2>&1 &
sleep 5
curl -s http://127.0.0.1:3399/ -o /tmp/home-before.html
echo "bytes: $(wc -c < /tmp/home-before.html)"
echo "img:   $(grep -o '<img' /tmp/home-before.html | wc -l)"
echo "rail:  $(grep -o 'aria-labelledby=\"rail-' /tmp/home-before.html | wc -l)"
kill %1
```

Số đo lúc lập plan, để đối chiếu: **251.440 bytes, 97 thẻ `<img>`, 5 rail**.
Ghi số thực tế của bạn lại, sẽ dùng ở Task 12.

## Task 12 — Hai sửa đổi hiệu năng

### 12.1 — `.bf-media-card` thiếu kích thước dự phòng

`src/styles/globals.css`, TÌM (nguyên văn):

```css
  transition: transform var(--bf-motion-media) ease, opacity var(--bf-motion-fast) ease;
  content-visibility: auto;
}
```

THAY BẰNG:

```css
  transition: transform var(--bf-motion-media) ease, opacity var(--bf-motion-fast) ease;
  content-visibility: auto;
  /* Thiếu dòng này thì nội dung bị bỏ qua render được tính chiều cao 0 và thanh
     cuộn giật khi cuộn nhanh qua rail. 300px xấp xỉ chiều cao một thẻ poster. */
  contain-intrinsic-size: auto 300px;
}
```

### 12.2 — Cắt số thẻ ở rail dưới màn hình đầu

`src/app/page.tsx`, TÌM (nguyên văn):

```tsx
            itemLimit={section.href === "/list/phim-moi-cap-nhat" ? 24 : features.homeSectionLimit}
```

THAY BẰNG:

```tsx
            // Chỉ rail đầu nằm trong tầm nhìn ban đầu. Rail sau cắt còn 12: người
            // cuộn tới cuối rail sẽ bấm tiêu đề để mở trang danh mục đầy đủ, nên
            // thẻ thứ 13 trở đi gần như không được nhìn tới mà vẫn tốn HTML.
            itemLimit={index === 0
              ? (section.href === "/list/phim-moi-cap-nhat" ? 24 : features.homeSectionLimit)
              : 12}
```

> **Không** đổi `HOME_SECTION_LIMIT` trong `.env` — giữ nó làm cần gạt vận hành.

### Đo sau và so sánh

```bash
cd /home/ubuntu/blueflare && npm run build
PORT=3399 INTERNAL_CATALOG_URL=http://127.0.0.1:3200 node .next/standalone/server.js > /tmp/bf-smoke.log 2>&1 &
sleep 5
curl -s http://127.0.0.1:3399/ -o /tmp/home-after.html
echo "bytes: $(wc -c < /tmp/home-before.html) -> $(wc -c < /tmp/home-after.html)"
echo "img:   $(grep -o '<img' /tmp/home-before.html|wc -l) -> $(grep -o '<img' /tmp/home-after.html|wc -l)"
kill %1
```

Ghi **cả hai cặp số** vào commit message.

Nếu bytes **không** giảm ít nhất 15% → **DỪNG và báo lại số thực tế**. Không tự
đi tìm chỗ tối ưu khác.

## Commit Phase D

Message: `perf(home): cắt thẻ ở rail dưới fold, thêm contain-intrinsic-size`
kèm hai cặp số đo.

---

# GATE CUỐI CÙNG

```bash
cd /home/ubuntu/blueflare
npm run build
npm test
cd backend && node --test          # providers.test.js fail là đã biết
cd /home/ubuntu/blueflare
BLUEFLARE_ENV_FILE=$PWD/backend/.env.example \
  docker compose -f deploy/compose.yml config --quiet
git diff --check
```

Rồi **[SMOKE]** cộng hai đường nữa:

```bash
PORT=3399 INTERNAL_CATALOG_URL=http://127.0.0.1:3200 node .next/standalone/server.js > /tmp/bf-smoke.log 2>&1 &
sleep 5
slug=$(curl -s http://127.0.0.1:3399/ | grep -oE 'href="/movie/[a-z0-9-]+' | head -1 | sed 's|href="/movie/||')
curl -s -o /dev/null -w "detail %{http_code}\n" "http://127.0.0.1:3399/movie/$slug"
curl -s -o /dev/null -w "filter %{http_code}\n" "http://127.0.0.1:3399/list/phim-le?country=han-quoc"
kill %1
```

Cả hai phải `200`.

# BÁO CÁO KHI XONG

Báo lại đúng các mục sau, kèm số thật:

1. Task nào đã xong, Task nào dừng và vì sao.
2. Kết quả `npm test` (số test pass) và `npm run build`.
3. Cặp số hiệu năng trước/sau ở Task 12.
4. Số file `.woff2` sau khi đổi font (Task 7).
5. Task 10 chưa làm — cần người duyệt.

**Không deploy.** Build image và restart stack là việc riêng, chỉ làm khi chủ dự
án yêu cầu trực tiếp.
