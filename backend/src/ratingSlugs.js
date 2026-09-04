function itemsOf(source) {
  // 'trending' is the home hero array; every other bucket is a list payload.
  // Read explicitly rather than deep-scanning: the home payload also carries
  // the phimBo/hoatHinh rows, which would silently defeat the type filter.
  if (source?.bucket === 'trending') {
    return Array.isArray(source?.payload?.heroMovies) ? source.payload.heroMovies : [];
  }
  const items = source?.payload?.data?.items;
  return Array.isArray(items) ? items : [];
}

/**
 * Flatten the configured surfaces into one ordered, de-duplicated slug list.
 *
 * Order is load-bearing: it is the order the budget is spent in, so the hero
 * comes before page 1 of a list, which comes before page 2.
 */
export function collectRatingSlugs(sources) {
  const slugs = [];
  const seen = new Set();
  for (const source of Array.isArray(sources) ? sources : []) {
    for (const item of itemsOf(source)) {
      const slug = String(item?.slug || '').trim();
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      slugs.push(slug);
    }
  }
  return slugs;
}
