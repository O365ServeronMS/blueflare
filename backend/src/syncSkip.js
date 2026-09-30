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
