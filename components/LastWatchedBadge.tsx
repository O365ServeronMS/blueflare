"use client";

import { useLastEpisode } from "@/components/LocalMovieActions";

/** Small "Đang xem" label inside the chip of the last watched episode. Renders nothing otherwise. */
export function LastWatchedBadge({ slug, serverName, episodeKey }: { slug: string; serverName: string; episodeKey: string }) {
  const ep = useLastEpisode(slug);
  if (!ep || ep.key !== episodeKey || (ep.server && ep.server !== serverName)) return null;
  return <span className="mt-0.5 block text-micro font-medium leading-none text-chalk-white/80">Đang xem</span>;
}
