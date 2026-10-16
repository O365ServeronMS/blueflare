# Kế hoạch: làm sạch catalog hằng tuần bằng AI + vá lỗi trộn mùa

Plan đang thực thi; xoá file này khi xong (git giữ lịch sử).

## Audit (2026-10-17, số đo trên DB production)

### Lỗi gốc: trộn mùa qua `imdb_id`

`nha-ngoai-giao-phan-4` (The Diplomat S4) hiển thị dữ liệu Phần 2:

1. KKPhim `nha-ngoai-giao-phan-4` về với `tmdb 203857 / tv / season 4`. `findStrongIdentity`
   không thấy row nào có `(203857, tv, 4)`.
2. `findIdentity` (`repository.js`) khớp **trước tiên theo `imdb_id`**. IMDb id của phim bộ là
   cấp series (`tt17491088` dùng chung cho Phần 1/2/3), `LIMIT 1` không `ORDER BY` nên trúng
   row Phần 2.
3. `persistTmdbIdentity` ghi đè `tmdb_season_number` 2 → 4 trên row đó, không log vào
   `tmdb_identity_changes`. Row Phần 2 ôm stream Phần 4, slug KKPhim `phan-4` resolve về nó.
   NguonC Phần 4 về sau tạo row riêng không có TMDB (`ineligible`).

Phụ: alias `nha-ngoai-giao-phan-3` trỏ về row Phần 1 (slug cũ còn sót từ lần tách mùa
`seasonSplit` 10-01, bị duplicate merge biến thành alias).

### Phạm vi

| Chỉ số | Số |
| --- | --- |
| Row tv chứa nguồn KKPhim nhiều mùa | 10 (có row ôm 4 mùa) |
| Row có `(Season N)` trong tên gốc ≠ `tmdb_season_number` | 58 |
| Row có nguồn mâu thuẫn mùa (tmdb_season / slug `phan-N` / tên gốc) | 76 |
| Nhóm dùng chung `imdb_id` | 866 nhóm / 2.881 row |
| Ready có TMDB id | 34.693 / 41.761 (83%; movie 87,1%, tv 78,7%) |
| tv mang TMDB id loại *movie* (không phải tv id thiếu season; tv id thiếu season = 0) | 1.204 |
| AI match: số lần thử mỗi phim | không có trần; 1.233 phim thử ≥ 4 lần, tối đa 13 |
| AI match lỗi `model-refused` | 22.085 lượt (dừng từ 10-09) |

Hiện **không có** bước AI nào quyết định gộp/tách: `duplicateMerge.js` và `seasonSplit.js`
là luật cố định; AI module chỉ có role `TRANSLATE` và `MATCH`.

## Quyết định đã chốt với Steve

- Node trong worker (không Python), loop thứ 5 chu kỳ 7 ngày, checkpoint trong DB.
- AI đề xuất → cổng tất định duyệt → apply + log undo được. Mặc định `dry-run`.
- Phạm vi: tách mùa trộn, gộp row trùng cùng mùa, alias/slug sai, TMDB id sai, sai loại
  lẻ/bộ, số tập lệch, row mồ côi/nguồn chết (ẩn, không xoá), năm lệch giữa nguồn.
- Mục tiêu cuối: tối đa độ phủ TMDB id; phim hiếm (VN, TH…) bỏ qua sau 3 lần thử.
- 76 row hiện tại: lượt đầu dry-run → báo cáo → bật apply.
- Dữ liệu user theo mùa đúng (gộp: chuyển sang row giữ; tách: theo mùa nếu xác định được).
- Role AI mới `DEDUPE` dùng lại model/key của `MATCH`, cap trả phí riêng.

## Thiết kế

### Phase 0 — vá đường ingest (tất định, có test)

- `findIdentity`: với tv, khớp `imdb_id` chỉ khi mùa không mâu thuẫn (mùa của nguồn — tmdb
  season, `(Phần N)`/`(Season N)`, slug `phan-N` — bằng mùa của row hoặc cả hai không có);
  mọi `LIMIT 1` có `ORDER BY` ổn định.
- `upsertCanonical`: không bao giờ dùng row có TMDB tuple khác (id/media/season) với tuple
  nguồn mang theo; khi đó tạo row mới. Đường provider không ghi đè season khác null nữa.
- Mọi thay đổi TMDB tuple của row đã có giá trị trên đường provider ghi vào
  `tmdb_identity_changes` (source `provider`).

### Phase 1 — `catalogAudit` loop (worker)

Env `CATALOG_AUDIT_MODE=off|dry-run|apply` (mặc định `dry-run`), `CATALOG_AUDIT_INTERVAL_MS`
(7 ngày), `CATALOG_AUDIT_BATCH`, `CATALOG_AUDIT_MAX_ACTIONS` (trần apply mỗi lượt).

1. **Trích xuất (`catalogAuditExtract.js`)**: SQL + detector thuần JS → danh sách *nhóm nghi
   vấn*, mỗi nhóm là JSON gọn: row (id, slug, title, original, year, type, tmdb tuple, imdb,
   quốc gia, episode_total, số tập thật trong streams, aliases, số favorites/history), từng
   nguồn (provider, slug, tmdb season, year, mùa trong tên/slug, số tập, last_success,
   not_found), và với nhóm cần TMDB: facts `/tv/{id}` (số mùa, năm từng mùa, số tập) — chỉ
   worker gọi TMDB.
2. **Detector** (mã lý do cố định): `multi-season`, `season-marker`, `dup-same-season`,
   `alias-wrong`, `slug-season`, `tmdb-mismatch`, `type-mismatch`, `episode-mismatch`,
   `orphan`, `year-spread`, `tv-no-season`.
3. **AI (`role DEDUPE`)**: nhận nhóm, trả hành động từ từ vựng cố định, chỉ tham chiếu id có
   trong input: `split_source`, `merge_rows`, `set_season`, `fix_alias`, `set_media_type`,
   `clear_tmdb`, `hide_row`, `none` + lý do ngắn.
4. **Cổng tất định** mỗi loại hành động (ví dụ `split_source` chỉ khi mùa nguồn có ≥2 tín hiệu
   đồng ý; `merge_rows` dùng lại điều kiện `duplicateMerge` + cùng mùa; `set_season` khớp năm
   ±1 và số tập TMDB; `hide_row` chỉ khi mọi nguồn chết > N ngày). Trượt cổng → báo cáo.
5. **Apply** một transaction / nhóm, bảng mới `catalog_audit_actions` (snapshot before,
   undo), `scripts/catalog-audit-undo.mjs <id>`, `scripts/catalog-audit-report.mjs` (CSV).
   Tách/gộp dùng lại `duplicateMergeRepository` và đường ingest đã vá; invalidate cache đúng
   phần đổi.

### Phase 2 — độ phủ TMDB

- Trần 3 lần thử thật (`none`/`unverifiable`, không tính `error`) cho AI match → đánh dấu bỏ
  qua; mở lại khi title/year/original của row đổi.
- Row vừa được tách/sửa mùa được đưa lại vào hàng đợi match/season-infer.
