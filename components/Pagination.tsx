import { MoreHorizontal } from "lucide-react";

interface Props {
  currentPage: number;
  totalPages?: number;
  buildUrl: (page: number) => string;
  className?: string;
}

export function Pagination({ currentPage, totalPages, buildUrl, className = "" }: Props) {
  if (!totalPages || totalPages <= 1) return null;

  const pageSet = new Set<number>([1, totalPages]);
  for (let page = currentPage - 2; page <= currentPage + 2; page += 1) pageSet.add(page);
  const pages = Array.from(pageSet).filter((page) => page >= 1 && page <= totalPages).sort((a, b) => a - b);
  const items: Array<number | "ellipsis"> = [];

  pages.forEach((page, index) => {
    if (index > 0) {
      const gap = page - pages[index - 1];
      if (gap === 2) items.push(page - 1);
      else if (gap > 2) items.push("ellipsis");
    }
    items.push(page);
  });

  return (
    <nav className={`flex items-center justify-center pb-6 pt-12 ${className}`} aria-label="Phân trang">
      <div className="flex items-center gap-1">
        {items.map((item, index) => item === "ellipsis" ? (
          <span key={`ellipsis-${index}`} className="grid h-11 w-7 place-items-center text-ash" aria-hidden="true">
            <MoreHorizontal className="h-4 w-4" />
          </span>
        ) : item === currentPage ? (
          <span key={item} aria-current="page" aria-label={`Trang ${item}`} className="grid h-11 min-w-11 place-items-center rounded-sm bg-netflix-red px-2 text-[13px] font-bold text-white">
            {item}
          </span>
        ) : (
          <a
            key={item}
            href={buildUrl(item)}
            aria-label={`Trang ${item}`}
            className="grid h-11 min-w-11 place-items-center rounded-sm px-2 text-[13px] font-medium text-silver transition hover:bg-graphite hover:text-white"
          >
            {item}
          </a>
        ))}
      </div>
    </nav>
  );
}
