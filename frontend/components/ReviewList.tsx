"use client";

import { useState } from "react";
import { getReviewsPage } from "@/lib/catalog";
import { formatReviewDate, isLongReview, reviewInitial } from "@/lib/reviews";
import type { Review } from "@/lib/types";

const PAGE_SIZE = 5;

function ReviewCard({ review }: { review: Review }) {
  const [open, setOpen] = useState(false);
  const long = isLongReview(review.content);
  const date = formatReviewDate(review.createdAt);
  return (
    <li className="rounded bg-graphite p-4">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-charcoal text-body font-bold text-white"
        >
          {reviewInitial(review.author)}
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-body font-bold text-white">{review.author}</p>
          <p className="flex flex-wrap items-center gap-x-3 text-micro text-silver">
            {review.rating !== null ? (
              <span className="font-bold text-luxury-gold">{`★ ${review.rating}/10`}</span>
            ) : null}
            {date ? <time dateTime={review.createdAt || undefined}>{date}</time> : null}
          </p>
        </div>
        {review.hasSpoiler ? (
          <span className="shrink-0 rounded bg-netflix-red px-2 py-1 text-control font-bold text-white">Spoiler</span>
        ) : null}
      </div>
      <p
        className={`mt-3 whitespace-pre-line break-words text-body leading-6 text-silver${long && !open ? " line-clamp-4" : ""}`}
      >
        {review.content}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        {long ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
            className="text-control font-bold text-white transition hover:text-netflix-red"
          >
            {open ? "Thu gọn" : "Đọc tiếp"}
          </button>
        ) : null}
        {review.url ? (
          <a
            href={review.url}
            target="_blank"
            rel="noopener nofollow noreferrer"
            className="text-control text-silver underline-offset-2 transition hover:text-white hover:underline"
          >
            Xem trên TMDB
          </a>
        ) : null}
      </div>
    </li>
  );
}

export function ReviewList({
  slug,
  initial,
  total
}: {
  slug: string;
  initial: Review[];
  total: number;
}) {
  const [items, setItems] = useState(initial);
  const [page, setPage] = useState(1);
  const [done, setDone] = useState(initial.length >= total);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  async function more() {
    setLoading(true);
    setFailed(false);
    try {
      // The detail payload carries page 1 at PAGE_SIZE, so continue at that size.
      const next = await getReviewsPage(slug, page + 1, PAGE_SIZE);
      setItems((current) => {
        const seen = new Set(current.map((review) => review.id));
        const merged = [...current, ...next.reviews.filter((review) => !seen.has(review.id))];
        setDone(!next.reviews.length || page + 1 >= next.totalPages || merged.length >= total);
        return merged;
      });
      setPage(page + 1);
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <ul className="mt-5 grid gap-3 lg:grid-cols-2">
        {items.map((review) => (
          <ReviewCard key={review.id} review={review} />
        ))}
      </ul>
      {!done ? (
        <div className="mt-4">
          <button
            type="button"
            onClick={more}
            disabled={loading}
            className="rounded bg-graphite px-4 py-2.5 text-control font-bold text-white transition hover:bg-charcoal disabled:opacity-60"
          >
            {loading ? "Đang tải…" : "Xem thêm đánh giá"}
          </button>
          {failed ? (
            <p role="alert" className="mt-2 text-control text-silver">Không tải được đánh giá. Thử lại sau.</p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
