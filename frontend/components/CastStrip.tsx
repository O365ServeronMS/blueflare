import { hrefWithReturnTo } from "@/lib/navigation";
import type { PersonCredit } from "@/lib/types";

function PersonTile({ credit, returnTo, navSource }: { credit: PersonCredit; returnTo: string; navSource?: string }) {
  const href = hrefWithReturnTo(`/person/${credit.slug}`, returnTo, navSource);
  return (
    <a href={href} className="group block w-28 shrink-0 sm:w-32">
      <div className="aspect-[2/3] overflow-hidden rounded bg-graphite">
        {credit.photo ? (
          <img
            src={credit.photo}
            alt=""
            width={160}
            height={240}
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover transition group-hover:scale-105"
          />
        ) : null}
      </div>
      <p className="mt-2 truncate text-control font-semibold text-white">{credit.name}</p>
      {credit.character ? <p className="truncate text-micro text-silver">{credit.character}</p> : null}
    </a>
  );
}

// Only rows with a verified TMDB identity have credits, so this is absent on
// most of the catalog. The plain actor/director text stays on the page either
// way; this strip is the clickable layer on top of it.
export function CastStrip({
  cast,
  directors,
  returnTo,
  navSource
}: {
  cast: PersonCredit[];
  directors: PersonCredit[];
  returnTo: string;
  navSource?: string;
}) {
  if (!cast.length && !directors.length) return null;
  return (
    <section className="mt-10" aria-labelledby="cast-heading">
      <h2 id="cast-heading" className="text-heading font-bold text-white">Diễn viên &amp; đạo diễn</h2>
      <div className="mt-5 space-y-5">
        {directors.length ? (
          <div>
            <h3 className="mb-2 text-control font-bold text-silver">Đạo diễn</h3>
            <div className="no-scrollbar flex gap-4 overflow-x-auto pb-2">
              {directors.map((credit) => (
                <PersonTile key={credit.slug} credit={credit} returnTo={returnTo} navSource={navSource} />
              ))}
            </div>
          </div>
        ) : null}
        {cast.length ? (
          <div>
            <h3 className="mb-2 text-control font-bold text-silver">Diễn viên</h3>
            <div className="no-scrollbar flex gap-4 overflow-x-auto pb-2">
              {cast.map((credit) => (
                <PersonTile key={credit.slug} credit={credit} returnTo={returnTo} navSource={navSource} />
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
