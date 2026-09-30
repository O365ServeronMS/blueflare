# PLAN-005 — Định danh TMDB cho phim chưa có `tmdb_id` verified

Trạng thái: **DỰ THẢO, chờ quyết định của Steve.** Chưa có dòng code nào được viết.
Ngày đo: 2026-09-30. Số liệu thô: `/tmp/plan005-evidence/` (mất khi reboot; số tổng hợp nằm ngay dưới).

## 1. Bài toán

49.158 phim `ready`. Chỉ 11.507 (23%) có `tmdb_id` verified (provider cấp, đã qua `fetchVerifiedTmdbImages`).
37.651 phim còn lại có `tmdb_identity_status='ineligible'` — provider không cấp id — và chia 3 nhóm:

| Nhóm | Số dòng | Hiện có gì |
|---|---:|---|
| Đã "đoán" theo tên (`tmdb_lookup_status='matched'`) | 15.060 | `tmdb_lookup_id` (chỉ dùng cho MDBList + rail gợi ý) |
| Không khớp / mơ hồ / chưa kiểm | 22.591 | không có gì |
| (trong đó có imdb_id nhưng không tmdb_id) | 32 | imdb_id — không đáng kể, bỏ qua |

Hậu quả: 62% catalog không có dải diễn viên, trang `/person/*` chỉ phủ 23% phim, và
`creditsForMovie`/`listPersonMovies` chỉ join theo `(tmdb_media_type, tmdb_id)` verified.

## 2. Đánh giá độ chính xác (đo thật, không ước đoán)

Phương pháp: **backtest** — chạy thuật toán lên phim đã verify (biết đáp án `tmdb_id`), 500 dòng
(250 movie + 250 tv, ngẫu nhiên), gọi TMDB thật. Cộng **audit production** 300 dòng chưa verify
(150 đang `matched`, 150 chưa) để kiểm tra kết quả backtest có đứng vững trên đúng tập cần làm.

### 2.1 Thuật toán hiện tại (`searchTmdbIdByTitle`: khớp đúng tên, duy nhất)

| Chỉ số | Kết quả |
|---|---|
| Precision | **91,2%** (186/204), 95% CI ≈ 86,5–94,4% |
| Recall | **37,2%** (186/500) — khớp với thực tế production: 15.060/37.651 = 40% |
| Precision movie / tv | 92,3% / 88,5% |
| Audit production (đối chiếu diễn viên) | 106/115 = **92,2%** giữ nguyên, 9 bị lật (7,8%) |

Lỗi điển hình: cùng tên khác phim (remake, series trùng tên, entry TMDB rác ít vote):
*A Werewolf Boy* 2012 đoán ra 1600510 thay vì 128246; *3% (Season 2)* đoán 201373 thay vì 68467.
⇒ ước tính **~1.200 dòng trong 15.060 đang mang id sai**. Đây là lỗi *đang chạy*: id đó cấp cho MDBList
(điểm Rotten Tomatoes sai) và rail gợi ý (gợi ý sai). Độc lập với việc có làm plan này hay không.

**Kết luận: 92% không đủ để gắn diễn viên lên trang chi tiết** (cứ ~12 phim có 1 phim hiện sai dàn diễn viên).
Đó là lý do bất biến hiện hành tách `tmdb_lookup_id` (đoán) khỏi `tmdb_id` (verified) là đúng.

### 2.2 Đề xuất: tìm ứng viên rồi **đối chiếu diễn viên** (≥ 2 tên trùng)

Lấy tối đa 6 ứng viên từ `/search`, lấy `/credits` từng ứng viên, so với cột `actors` của catalog
(tên Latin, có ở 82% dòng chưa verify; ≥3 diễn viên ở 77%).

| Chỉ số | Backtest 500 | Ghi chú |
|---|---|---|
| Chấp nhận | 341 (68%) | recall **67,4%** so với 37,2% hiện tại |
| Đúng | 337 | precision **98,8%**, 95% CI ≈ 97,0–99,5% |
| Sai | 4 | **cả 4 đều đáng ngờ là "đáp án" của provider sai**, không phải lựa chọn sai: vd *Icarus* 2017, 3 diễn viên trùng, 859 vote, so với id "đáp án" 1278506 |
| Trần lý thuyết (đáp án có trong top-6 search) | 445/500 = 89% | |

⇒ 98,8% là **cận dưới** của độ chính xác thật.

### 2.3 Trên đúng tập chưa verify (audit production, n=300)

| | Kết quả |
|---|---|
| Dòng đang `matched` kiểm chứng được bằng diễn viên | 115/150 (77%) |
| Dòng chưa khớp cứu được | 55/161 = **34%** |
| Âu Mỹ | 92/114 = **81%** kiểm chứng được |
| Nhật Bản / Trung Quốc / Hồng Kông | 9/40 (22%) / 8/44 (18%) / 1/14 (7%) |

Vì sao châu Á thấp: catalog ghi diễn viên bằng **tên Hán-Việt** ("Đậu Trí Khổng", "Lộ Hân"),
TMDB ghi pinyin/kanji ⇒ không so chuỗi được. Đây là giới hạn cứng của phương pháp, không phải lỗi tham số.

### 2.4 Ngoại suy (sai số lớn: mỗi mẫu ~150 dòng ⇒ ±7 điểm %)

| | Hôm nay | Sau plan |
|---|---:|---:|
| Phim có định danh đáng tin | 11.507 (23%) | ~30.700 (**~62%**) |
| — trong đó thêm từ nhóm đang `matched` | | ~11.500 |
| — trong đó thêm từ nhóm chưa khớp | | ~7.700 |
| Còn lại không cứu được (chủ yếu Hoa/HK/Nhật, <2 diễn viên) | 37.651 | ~18.400 |

### 2.5 Thiên lệch cần biết

- Backtest chạy trên phim *đã* verify (thường phổ biến hơn) ⇒ recall trên tập chưa verify thấp hơn
  (đã thấy: 68% → ~34–77% tuỳ nhóm). Precision cũng có thể thấp hơn một chút; đó là lý do Phase 0 đo lại lớn hơn.
- "Đáp án" của provider không hoàn hảo (xem 4 ca ở 2.2).
- Mẫu nhỏ; chưa có CI cho từng quốc gia.

## 3. Khuyến nghị

1. **Làm**, nhưng theo hướng *bằng chứng* (đối chiếu diễn viên), **không** nâng "đoán theo tên" thành verified.
2. **Không ghi vào `movies.tmdb_id`.** Ghi vào bộ cột mới `tmdb_match_*`. Lý do: `tmdb_id` đổi ⇒ `tmdb_identity_status→'pending'`
   ⇒ pipeline ảnh (`fetchVerifiedTmdbImages`) sẽ kéo poster TMDB đè lên ảnh hiện có cho ~19.000 phim. Blast radius quá lớn cho một tính năng metadata.
3. **Tách việc sửa 1.200 id sai ra khỏi việc thêm diễn viên** (Phase 4, tuỳ chọn, cần quyết định riêng vì đụng ngân sách MDBList).
4. **Không làm** tầng "khớp tên + năm, không diễn viên" cho phim châu Á ở thời điểm này (xem Phase 5): chưa có số đo.

## 4. Kế hoạch

Ràng buộc kế thừa từ PLAN-004: nhánh riêng `feat/tmdb-identity-evidence`, 1 commit/phase, `cd backend && node --test` xanh 100%,
không thư viện mới, không biến thể ảnh mới, không key cache/tag phụ thuộc returnTo/cookie/UA, không ghi thẳng PG/Valkey production ngoài migration và worker.

### Phase 0 — Đo lớn hơn, chốt ngưỡng (không đổi code sản phẩm)
- Script backtest chạy 2.000 dòng verified (chia theo quốc gia × movie/tv) + 1.000 dòng chưa verify; lưu vào `scripts/` hoặc `docs/`.
- Quyết định bằng số: ngưỡng overlap (2 hay 3), có thêm cổng năm cho movie (±1) không, xử lý phim <2 diễn viên.
- **Cổng quyết định:** cận dưới 95% CI của precision ≥ 97%. Không đạt ⇒ dừng, không sang Phase 1.
- Tài nguyên: ~8 call TMDB/dòng; đo được ~3,3 dòng/giây ở concurrency 4 ⇒ 3.000 dòng ≈ 15 phút.

### Phase 1 — Migration `019_tmdb_match.sql` + repository
- Cột mới trên `movies`: `tmdb_match_id bigint`, `tmdb_match_media_type text CHECK IN ('movie','tv')`,
  `tmdb_match_status text CHECK IN ('verified','conflict','unverifiable','none','error')`,
  `tmdb_match_evidence jsonb` (overlap, số ứng viên, chênh năm, vote), `tmdb_match_checked_at timestamptz`.
- Index từng phần `(tmdb_match_media_type, tmdb_match_id) WHERE tmdb_match_status='verified'`.
- `IF NOT EXISTS` toàn bộ, không backfill trong migration, chạy dưới `pg_advisory_lock(742019)` như hiện hành. Bảng 49k dòng ⇒ khoá <1s (đã đo ở PLAN-004).
- `listTmdbMatchCandidates` / `recordTmdbMatch` / `recordTmdbMatchFailure` theo đúng mẫu bộ ba hiện có; TTL: `verified` không xét lại, `none/unverifiable` thử lại 30 ngày, `error` 6 giờ.
- Test: mock `pg`, kiểm SQL tham số, kiểm không bao giờ ghi `tmdb_id`.

### Phase 2 — Worker: `refreshTmdbMatches()` (thuần logic, có test)
- Hàm thuần `pickCastVerifiedMatch(candidates, catalogActors, {year, mediaType, season})` trong `backend/src/tmdb.js`: chuẩn hoá tên (dùng lại `comparableTitle`), đếm trùng, chọn ứng viên overlap cao nhất, hoà ⇒ `unverifiable`.
- TV theo mùa: bỏ hậu tố `(Season N)` khi tìm; cổng năm dùng `first_air_date ≤ year` và `N ≤ number_of_seasons`, **không** so năm bằng (đã thấy 36/300 mẫu lệch năm chỉ vì phim bộ theo mùa).
- Dòng `matched` cũ mà ứng viên verified ≠ id cũ ⇒ status `conflict` (ghi cả hai vào evidence, chưa sửa gì).
- Gọi TMDB tối đa 2 search + 6 credits/dòng, `mapLimit`, giới hạn/chu kỳ qua env mới `TMDB_MATCH_*` (thêm cả vào `backend/.env.example` **và** stack `.env` — `apply-env.sh` sẽ fail deploy nếu thiếu).
- Gắn vào `syncCycle` sau `refreshTmdbCredits`, bọc `.catch` như các pass khác; **tắt mặc định** (`TMDB_MATCH_ENABLED=false`) để deploy code không tự bật gọi TMDB.
- Tận dụng credits đã tải: khi verified, ghi luôn `movie_credits` cho id đó (không gọi lại).

### Phase 3 — Đọc: dải diễn viên + trang người cho phim đã match
- `creditsForMovie` / `listPersonMovies` join theo `COALESCE(m.tmdb_id, m.tmdb_match_id)` và `COALESCE(m.tmdb_media_type, m.tmdb_match_media_type)`, chỉ tính `tmdb_match_status='verified'`. Giữ `DISTINCT ON` gộp mùa.
- Backend test cho cả hai nhánh `role='all'` và lọc; kiểm số tham số `$N`.
- Không đổi cache key/tag; API `movie.people` giữ nguyên shape ⇒ frontend không cần đổi.
- Thêm dấu hiệu nguồn (`people.source: 'verified'|'matched'`) **chỉ ở API, không hiển thị** — để đo và rollback về sau.

### Phase 4 (tuỳ chọn, quyết định riêng) — Sửa ~1.200 `tmdb_lookup_id` sai
- Với `conflict`: ghi `tmdb_lookup_id = tmdb_match_id`, đặt lại `mdblist_status` để nạp lại điểm RT.
- **Rủi ro cần duyệt:** tốn ngân sách MDBList theo ngày (theo key); phải giới hạn tốc độ và kiểm `keys=` trong log trước.
- Điểm RT đã lưu từ id sai vẫn nằm đó tới khi nạp lại ⇒ cần quyết định xoá hay giữ tạm.

### Phase 5 (chỉ khi có số đo) — Phim châu Á không có diễn viên trùng
- Chưa làm. Ứng viên: tên đúng-duy-nhất + năm ±1 (movie đo được 97,1%, n=136) — nhưng recall cụ thể của nhóm Hoa/HK/Nhật chưa đo.
- Cần Phase 0 mở rộng đo riêng nhóm này; nếu <97% thì loại hẳn.

### Verify / deploy
- `smoke()` trong `scripts/lib/stack.sh` đã phủ trang chi tiết + trang người; thêm 1 probe cho slug thuộc nhóm `matched` nếu có.
- Deploy 2 nhịp: (a) code + migration với `TMDB_MATCH_ENABLED=false`, (b) bật cờ, theo dõi log `tmdb match checked=… verified=… conflict=…`.
- Tốc độ backfill: 300 dòng/chu kỳ, ~37.000 dòng ⇒ >120 chu kỳ; nếu quá chậm, tăng limit sau khi xem CPU steal (xem memory: worker từng treo vì steal 84%).
- Rollback: tắt cờ ⇒ Phase 3 join vẫn chạy nhưng `tmdb_match_status` không đổi; muốn gỡ hẳn thì `UPDATE … SET tmdb_match_status='none'` (ghi PG — cần Steve duyệt).

## 5. Rủi ro tồn dư (báo, không tự sửa)
1. Vẫn ~1,2% (CI trên 3%) phim match hiển thị sai dàn diễn viên.
2. Hơn một nửa phần còn lại là phim Hoa/HK/Nhật, không cứu được bằng phương pháp này.
3. TMDB có entry trùng cho cùng phim ⇒ hai bản catalog có thể trỏ hai id khác nhau; ảnh hưởng: trang người có thể liệt kê thiếu.
4. Phase 4 chạm ngân sách MDBList.
5. Thêm ~300.000 call TMDB cho lần backfill đầu; chưa kiểm hạn mức key.

---

## 6. Kết quả Phase 0 (2026-09-30) — cổng ĐẠT

Quyết định của Steve: làm Phase 0–3 và Phase 4; **bỏ qua phim Hoa / Hồng Kông / Nhật** (để trống).
Mẫu Phase 0 đã loại ba quốc gia đó. Công cụ: `backend/tools/tmdb-match-backtest.mjs` (`collect` gọi TMDB một lần, `report` phát lại offline).

**Backtest 2.000 phim đã verify** (1.000 movie + 1.000 tv, ngẫu nhiên, ngoài 3 quốc gia):

| Policy | Chấp nhận | Đúng | Sai | Precision (CI95) | Recall |
|---|---:|---:|---:|---|---:|
| **overlap≥2 + cổng năm (movie), tie ⇒ từ chối — ĐÃ CHỌN** | 1255 | 1249 | 6 | **99,5%** (99,0–99,8) | 62,5% |
| overlap≥2, không cổng năm | 1241 | 1234 | 7 | 99,4% (98,8–99,7) | 61,7% |
| overlap≥3 | 1118 | 1115 | 3 | 99,7% (99,2–99,9) | 55,8% |
| overlap≥2, cho phép hoà | 1280 | 1274 | 6 | 99,5% (99,0–99,8) | 63,7% |
| overlap≥1 | 1440 | 1424 | 16 | 98,9% (98,2–99,3) | 71,2% |

- Cổng: cận dưới CI95 ≥ 97% ⇒ **đạt** (99,0%). movie 99,9% / tv 99,0%.
- Cổng năm loại thêm 7 ca, mất 15 ca đúng ⇒ giữ. Cho phép hoà: +1,2 điểm recall, không đổi số sai, nhưng bỏ bảo vệ cho ca hai bản trùng ⇒ giữ `requireUnique`.
- 6 ca sai: 4 ca là phần tiếp theo cùng dàn diễn viên (*Scream V* ↔ *Scream VI*, *Cars*, *Madagascar*, *Minions*) mà đáp án không nằm trong top-6 search; 2 ca còn lại có id đáp án trong ứng viên.
- Hàn Quốc và Thái Lan: precision 100% nhưng recall chỉ 15,8% / 41,0% — *Hàn Quốc thực tế gần như cũng để trống* (xem dưới).

**1.019 phim chưa verify thật** (ngoài 3 quốc gia): 640 (62,8%) verify được.
Theo quốc gia: Âu Mỹ 85,3%, Anh 66,7%, Canada 75,0%, Pháp 63,6%, Đức 68,4%, Ấn Độ 56,1%, Việt Nam 36,4%,
**Thái Lan 9,3%, Hàn Quốc 3,3%**. Hàn/Thái không nằm trong danh sách loại nhưng gần như không cứu được; pass sẽ tốn call cho chúng
(biến `TMDB_MATCH_SKIP_COUNTRIES`, mặc định `trung-quoc,hong-kong,nhat-ban,han-quoc,thai-lan`; Steve đã xác nhận thêm `han-quoc,thai-lan` vào mặc định).

**Chỉnh lại ước lượng Phase 4:** đo trực tiếp thuật toán đoán tên cũ trên phim trong phạm vi: **95,1% (558/587)**, không phải 92%
(con số 92% gồm cả Hoa/HK/Nhật). ⇒ khoảng 5% dòng `matched` trong phạm vi mang id sai, số tuyệt đối thấp hơn ước lượng ban đầu 1.200.
Ngoài ra chỉ *sửa được* những dòng cast-verify được (số 98,4% khớp chỉ đo trên các dòng đó nên thiên lệch lạc quan).

## 7. Triển khai (nhánh `feat/tmdb-identity-evidence`)

- Phase 1: migration `019_tmdb_match.sql`, khoá `TMDB_MATCH_*`, `listTmdbMatchCandidates` / `recordTmdbMatch` / `recordTmdbMatchFailure`.
- Phase 2: `refreshTmdbMatches()` trong worker, mặc định **tắt** (`TMDB_MATCH_ENABLED=false`). Khi verified, credits đã tải được ghi luôn.
- Phase 3: `creditIdentity`, `listTmdbCreditCandidates`, `listPersonMovies` đọc thêm `tmdb_match_*` (chỉ khi `tmdb_id IS NULL`, `status='verified'`).
- Phase 4: `correctGuessedLookupIds()` ghi đè `tmdb_lookup_id` sai bằng id đã verify, xoá điểm MDBList cũ và xếp hàng lấy lại (chỉ dòng không có `imdb_id`), tối đa 200 dòng/chu kỳ.
- Chưa đo `EXPLAIN` của join `listPersonMovies` (không có DB thử); làm read-only sau khi migration lên production.
