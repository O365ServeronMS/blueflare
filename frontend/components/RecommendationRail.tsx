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
