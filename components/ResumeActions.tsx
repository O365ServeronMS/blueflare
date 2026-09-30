"use client";

import { usePathname } from "next/navigation";
import { useAccount } from "@/components/useAccount";
import { useContinueItem } from "@/components/useContinueItem";
import { formatClock, nextEpisodeTarget, resumeTarget } from "@/lib/continue-watching";
import { hrefWithReturnTo } from "@/lib/navigation";

/**
 * Logged-in shortcuts next to the Play button. Both are plain links: nothing
 * mounts or seeks until the user follows one (or Play) and presses play.
 */
export function ResumeActions({
  activeEpisodeKey,
  episodeKeys,
  navSource,
  resumeHref,
  returnTo,
  serverIndex,
  slug,
}: {
  activeEpisodeKey: string;
  episodeKeys: string[];
  navSource?: string;
  resumeHref: string;
  returnTo?: string;
  serverIndex: number;
  slug: string;
}) {
  const account = useAccount(usePathname());
  const item = useContinueItem(slug, account === "user");
  const resumeAt = resumeTarget(item, activeEpisodeKey);
  const nextKey = nextEpisodeTarget(item, activeEpisodeKey, episodeKeys);

  if (resumeAt !== null) {
    return (
      <a href={resumeHref} className="bf-secondary-cta">
        Xem tiếp từ {formatClock(resumeAt)}
      </a>
    );
  }
  if (nextKey !== null) {
    const href = hrefWithReturnTo(
      `/movie/${slug}?server=${serverIndex}&ep=${encodeURIComponent(nextKey)}&play=1#player`,
      returnTo,
      navSource
    );
    return (
      <a href={href} className="bf-secondary-cta">
        Xem tập tiếp theo
      </a>
    );
  }
  return null;
}
