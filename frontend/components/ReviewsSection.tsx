import { ReviewList } from "@/components/ReviewList";
import type { Review } from "@/lib/types";

// Hidden when TMDB has no reviews for the title. The first page arrives with the
// cached detail payload; the client island only fetches further pages.
export function ReviewsSection({
  slug,
  reviews,
  reviewCount
}: {
  slug: string;
  reviews: Review[];
  reviewCount: number;
}) {
  if (!reviews.length) return null;
  const total = Math.max(reviewCount, reviews.length);
  return (
    <section className="mt-10" aria-labelledby="reviews-heading">
      <h2 id="reviews-heading" className="text-heading font-bold text-white">
        Đánh giá <span className="text-body font-medium text-silver">({total})</span>
      </h2>
      <ReviewList slug={slug} initial={reviews} total={total} />
      <p className="mt-4 text-micro text-ash">Reviews by TMDB users</p>
    </section>
  );
}
