import { connection } from "next/server";
import { HeroSlider } from "@/components/HeroSlider";
import { SectionRow } from "@/components/SectionRow";
import { getHomeServer } from "@/lib/catalog-server";

export const metadata = {
  title: "Bluesia Cinema — Xem phim online",
  description: "Khám phá phim lẻ, phim bộ, TV Shows và hoạt hình trên Blueflare."
};

export default async function HomePage() {
  await connection();
  const home = await getHomeServer();
  return (
    <>
      <HeroSlider items={home.hero} />
      <div className="pb-6">
        {home.sections.map((section, index) => (
          <SectionRow
            key={section.href || index}
            title={section.title}
            href={section.href}
            items={section.items}
            returnTo="/"
            spotlight={index === 0}
            itemLimit={section.href === "/list/phim-moi-cap-nhat" ? 24 : 16}
          />
        ))}
      </div>
    </>
  );
}
