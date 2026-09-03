// Server-only: reads runtime env so operators can flip features via .env +
// container restart, without a frontend rebuild. Read this in a Server
// Component and pass the result down as props — never import from a
// "use client" file, since these vars are not exposed to the browser.

function flag(name: string, fallback = true) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function limit(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function readFrontendFeatures() {
  return {
    heroSlider: flag("FEATURE_HERO_SLIDER"),
    searchSuggest: flag("FEATURE_SEARCH_SUGGEST"),
    localLibrary: flag("FEATURE_LOCAL_LIBRARY"),
    homeSectionLimit: limit("HOME_SECTION_LIMIT", 16),
    railSlideDurationMs: limit("RAIL_SLIDE_DURATION_MS", 300)
  };
}
