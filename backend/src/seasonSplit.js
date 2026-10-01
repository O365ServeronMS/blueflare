/**
 * Plans the one-off repair of KKPhim sources that were collapsed into a single
 * movie row before season-aware identity existed.
 *
 * Input rows: one per KKPhim source that carries a TMDB season, as
 * { movie_id, canonical_slug, row_season, provider_slug, source_season }.
 * Output: one entry per movie that holds at least one source whose season is not
 * the row's season, with its sources in the order they must be re-ingested:
 * foreign seasons first (each splits into its own row), the row's own season last
 * so the surviving row ends up with its own season's fields.
 */
export function planSeasonSplit(rows) {
  const byMovie = new Map();
  for (const row of rows) {
    if (!row.provider_slug || row.source_season === null || row.source_season === undefined) continue;
    const group = byMovie.get(row.movie_id) || { movieId: row.movie_id, canonicalSlug: row.canonical_slug, rowSeason: row.row_season ?? null, sources: [] };
    group.sources.push({ slug: row.provider_slug, season: Number(row.source_season) });
    byMovie.set(row.movie_id, group);
  }
  const plan = [];
  for (const group of byMovie.values()) {
    const own = (source) => group.rowSeason !== null && source.season === Number(group.rowSeason);
    if (group.sources.every(own)) continue;
    group.sources.sort((a, b) => (own(a) - own(b)) || (a.season - b.season) || a.slug.localeCompare(b.slug));
    plan.push(group);
  }
  return plan.sort((a, b) => a.canonicalSlug.localeCompare(b.canonicalSlug));
}
