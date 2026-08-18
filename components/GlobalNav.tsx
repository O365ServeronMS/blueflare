"use client";

import { useEffect, useState } from "react";
import { Clock3, Heart, Menu, Search, Settings, X } from "lucide-react";
import { SearchSuggest } from "@/components/SearchSuggest";
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

export function GlobalNav({ initialPathname = "/", initialSearch = "" }: { initialPathname?: string; initialSearch?: string }) {
  const [pathname, setPathname] = useState(initialPathname);
  const [search, setSearch] = useState(initialSearch);
  const [scrolled, setScrolled] = useState(initialPathname !== "/");
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const activeKey = getActiveNavKey(pathname, search);

  useEffect(() => {
    function syncLocation() {
      setPathname(window.location.pathname);
      setSearch(window.location.search);
      setScrolled(window.scrollY > 28 || window.location.pathname !== "/");
    }
    function onScroll() {
      setScrolled(window.scrollY > 28 || window.location.pathname !== "/");
    }
    syncLocation();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("popstate", syncLocation);
    window.addEventListener("pageshow", syncLocation);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("popstate", syncLocation);
      window.removeEventListener("pageshow", syncLocation);
    };
  }, []);

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
      <nav className="bf-content-width bf-page-gutter flex h-14 items-center gap-5 md:h-16" aria-label="Điều hướng chính">
        <a href="/" onClick={closePanels} className="flex shrink-0 items-center gap-2" aria-label="Blueflare - Trang chủ">
          <svg width="18" height="20" viewBox="0 0 20 22" className="shrink-0" aria-hidden="true">
            <path
              d="M10 0 C4 6 2 10 2 14 C2 18.4 5.6 22 10 22 C14.4 22 18 18.4 18 14 C18 10 16 6 10 0 Z M10 5 C13 9 15 11.5 15 14.2 C15 16.8 12.8 19 10 19 C7.2 19 5 16.8 5 14.2 C5 11.5 7 9 10 5 Z"
              fill="var(--color-netflix-red)"
            />
          </svg>
          <span className="bf-brand text-[19px] font-black tracking-[-0.04em] text-netflix-red md:text-[22px]">BLUEFLARE</span>
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
          <button
            type="button"
            aria-label={searchOpen ? "Đóng tìm kiếm" : "Mở tìm kiếm"}
            aria-expanded={searchOpen}
            onClick={() => { setSearchOpen((open) => !open); setMenuOpen(false); }}
            className="grid h-11 w-11 place-items-center text-chalk-white transition-colors hover:text-silver"
          >
            {searchOpen ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
          </button>

          <div className="hidden items-center md:flex">
            {utilityItems.map((item) => {
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

      {searchOpen ? (
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
            {utilityItems.map((item) => {
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
