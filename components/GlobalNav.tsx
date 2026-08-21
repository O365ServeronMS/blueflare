"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Clock3, Heart, Menu, Search, Settings, X } from "lucide-react";
import { SearchSuggest } from "@/components/SearchSuggest";
import { BlueflareIcon } from "@/components/logo/BlueflareIcon";
import { BlueflareWordmark } from "@/components/logo/BlueflareWordmark";
import { getActiveNavKey } from "@/lib/navigation";
import { cn } from "@/lib/utils";

const primaryItems = [
  { key: "home", href: "/", label: "Trang chủ" },
  { key: "phim-le", href: "/list/phim-le", label: "Phim lẻ" },
  { key: "phim-bo", href: "/list/phim-bo", label: "Phim bộ" },
  { key: "tv-shows", href: "/list/tv-shows", label: "TV Shows" },
  { key: "hoat-hinh", href: "/list/hoat-hinh", label: "Hoạt hình" },
];

const utilityItems = [
  { href: "/favorites", label: "Yêu thích", icon: Heart },
  { href: "/history", label: "Lịch sử", icon: Clock3 },
  { href: "/settings", label: "Cài đặt", icon: Settings },
];

type GlobalNavProps = {
  featureSearch?: boolean;
  featureLocalLibrary?: boolean;
};

export function GlobalNav({ featureSearch = true, featureLocalLibrary = true }: GlobalNavProps) {
  const pathname = usePathname();
  // Populated client-side only, after hydration — used solely to infer the
  // active tab on /movie/* detail pages from ?returnTo=. Empty on first
  // paint means no tab lights up rather than the wrong one flashing.
  const [search, setSearch] = useState("");
  const [scrolled, setScrolled] = useState(pathname !== "/");
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const activeKey = getActiveNavKey(pathname, search);
  const visibleUtilityItems = featureLocalLibrary
    ? utilityItems
    : utilityItems.filter((item) => item.href !== "/favorites" && item.href !== "/history");

  useEffect(() => {
    function syncLocation() {
      setSearch(window.location.search);
      setScrolled(window.scrollY > 28 || window.location.pathname !== "/");
    }
    function onScroll() {
      setScrolled(window.scrollY > 28 || window.location.pathname !== "/");
    }
    syncLocation();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("pageshow", syncLocation);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("pageshow", syncLocation);
    };
  }, [pathname]);

  useEffect(() => {
    if (!menuOpen && !searchOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuOpen(false);
        setSearchOpen(false);
      }
    }
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [menuOpen, searchOpen]);

  function closePanels() {
    setMenuOpen(false);
    setSearchOpen(false);
  }

  return (
    <header
      className="bf-nav-surface fixed inset-x-0 top-0 z-50 transition-colors duration-300"
      data-scrolled={scrolled}
      data-open={menuOpen || searchOpen}
    >
      <nav className="bf-nav-row bf-content-width bf-page-gutter flex items-center gap-5" aria-label="Điều hướng chính">
        <a href="/" onClick={closePanels} className="flex shrink-0 items-center gap-2" aria-label="Blueflare - Trang chủ">
          <BlueflareIcon className="h-6 w-6 shrink-0 md:h-7 md:w-7" />
          <BlueflareWordmark className="hidden h-[17px] w-auto sm:block md:h-5" />
        </a>

        <div className="hidden min-w-0 items-center gap-4 lg:flex">
          {primaryItems.map((item) => (
            <a
              key={item.key}
              href={item.href}
              aria-current={activeKey === item.key ? "page" : undefined}
              className={cn(
                "relative py-5 text-[13px] font-medium text-silver transition-colors hover:text-chalk-white",
                activeKey === item.key && "text-chalk-white after:absolute after:inset-x-0 after:bottom-3 after:h-0.5 after:bg-netflix-red"
              )}
            >
              {item.label}
            </a>
          ))}
        </div>

        <div className="ml-auto flex items-center">
          {featureSearch ? (
            <button
              type="button"
              aria-label={searchOpen ? "Đóng tìm kiếm" : "Mở tìm kiếm"}
              aria-expanded={searchOpen}
              onClick={() => { setSearchOpen((open) => !open); setMenuOpen(false); }}
              className="grid h-11 w-11 place-items-center text-chalk-white transition-colors hover:text-silver"
            >
              {searchOpen ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
            </button>
          ) : null}

          <div className="hidden items-center md:flex">
            {visibleUtilityItems.map((item) => {
              const Icon = item.icon;
              return (
                <a key={item.href} href={item.href} aria-label={item.label} className="grid h-11 w-10 place-items-center text-silver transition-colors hover:text-chalk-white">
                  <Icon className="h-[18px] w-[18px]" />
                </a>
              );
            })}
          </div>

          <button
            type="button"
            aria-label={menuOpen ? "Đóng menu" : "Mở menu"}
            aria-expanded={menuOpen}
            onClick={() => { setMenuOpen((open) => !open); setSearchOpen(false); }}
            className="grid h-11 w-11 place-items-center text-chalk-white lg:hidden"
          >
            {menuOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
          </button>
        </div>
      </nav>

      {featureSearch && searchOpen ? (
        <div className="bf-content-width bf-page-gutter border-t border-white/10 bg-black pb-5 pt-4">
          <div className="ml-auto max-w-xl">
            <SearchSuggest autoFocus />
          </div>
        </div>
      ) : null}

      {menuOpen ? (
        <div className="border-t border-white/10 bg-black px-4 pb-5 pt-2 lg:hidden">
          <div className="grid">
            {primaryItems.map((item) => (
              <a
                key={item.key}
                href={item.href}
                onClick={closePanels}
                aria-current={activeKey === item.key ? "page" : undefined}
                className={cn(
                  "border-b border-white/10 py-3.5 text-[15px] font-medium text-silver",
                  activeKey === item.key && "text-chalk-white"
                )}
              >
                {item.label}
              </a>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2">
            {visibleUtilityItems.map((item) => {
              const Icon = item.icon;
              return (
                <a key={item.href} href={item.href} onClick={closePanels} className="flex min-h-11 items-center justify-center gap-2 rounded px-2 text-[12px] font-medium text-silver hover:bg-graphite hover:text-chalk-white">
                  <Icon className="h-4 w-4" />
                  {item.label}
                </a>
              );
            })}
          </div>
        </div>
      ) : null}
    </header>
  );
}
