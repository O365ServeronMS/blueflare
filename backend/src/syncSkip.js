export function itemModifiedMs(item) {
  const raw = item?.modified?.time ?? item?.modified;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// stored: rows { provider_slug, provider_updated_at } đã có streams. Trả về Set
// slug mà list item không đổi so với bản lưu, không cần gọi lại detail.
export function unchangedSlugs(items, stored) {
  const storedMs = new Map();
  for (const row of stored) {
    const ms = row.provider_updated_at ? new Date(row.provider_updated_at).getTime() : null;
    if (ms !== null) storedMs.set(row.provider_slug, ms);
  }
  const unchanged = new Set();
  for (const item of items) {
    const modified = itemModifiedMs(item);
    if (modified !== null && storedMs.get(item.slug) === modified) unchanged.add(item.slug);
  }
  return unchanged;
}

// Detail lỗi thì có được ghi bản tóm tắt (không stream) từ trang danh sách không. Không bao giờ
// đè nguồn đã có stream. NguonC: item danh sách không có id và category, nên bản tóm tắt chỉ được
// làm mới một hàng tóm tắt đã có, không được tạo movie/nguồn mới (lúc NguonC đổi slug nó sinh ra
// movie rác kiểu series, id = slug, rồi va UNIQUE (provider, provider_movie_id) khi detail trở lại).
export function allowSummaryFallback(providerName, slug, { goodSlugs, streamlessSlugs }) {
  if (goodSlugs.has(slug)) return false;
  if (providerName === 'nguonc') return streamlessSlugs.has(slug);
  return true;
}
