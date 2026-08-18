import { connection } from "next/server";
import { HeroSlider } from "@/components/HeroSlider";
import { SectionRow } from "@/components/SectionRow";
import { getHomeServer } from "@/lib/catalog-server";
import { readFrontendFeatures } from "@/lib/features";

export const metadata = {
  title: "Bluesia Cinema — Xem phim online",
  description: "Khám phá phim lẻ, phim bộ, TV Shows và hoạt hình trên Blueflare."
};

export default async function HomePage() {
  await connection();
  const home = await getHomeServer();
  const features = readFrontendFeatures();
  // Same up-to-24-item shortlist the hero slider rotates through — the
  // trending row below reuses it as-is instead of fetching or rendering
  // anything new.
  const heroItems = home.hero.filter((movie) => movie.slug && (movie.poster || movie.thumb)).slice(0, 24);
  return (
    <>
      {features.heroSlider ? <HeroSlider items={heroItems} /> : null}
      <div className="pb-6">
        {heroItems.length ? (
          <SectionRow
            title="Phim đang được xem nhiều"
            href="/list/phim-moi-cap-nhat"
            items={heroItems}
            returnTo="/"
            spotlight
            ranked
            itemLimit={heroItems.length}
          />
        ) : null}
        {home.sections.map((section, index) => (
          <SectionRow
            key={section.href || index}
            title={section.title}
            href={section.href}
            items={section.items}
            returnTo="/"
            spotlight={index === 0 && !heroItems.length}
            itemLimit={section.href === "/list/phim-moi-cap-nhat" ? 24 : features.homeSectionLimit}
          />
        ))}
      </div>
    </>
  );
}
