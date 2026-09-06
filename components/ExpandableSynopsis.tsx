"use client";

import { ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { stripHtml } from "@/lib/utils";

type ExpandableSynopsisProps = {
  /** Raw synopsis; HTML is stripped before render. */
  text?: string;
  /** Collapsed line budget. */
  lines?: number;
  className?: string;
  copyClassName?: string;
  /** Collapse again whenever this value changes (hero slider rotation). */
  resetKey?: string;
  onExpandedChange?: (expanded: boolean) => void;
};

export function ExpandableSynopsis({
  text,
  lines = 2,
  className = "",
  copyClassName = "",
  resetKey,
  onExpandedChange
}: ExpandableSynopsisProps) {
  const [expanded, setExpanded] = useState(false);
  const copy = stripHtml(text);

  useEffect(() => {
    setExpanded(false);
    onExpandedChange?.(false);
    // `onExpandedChange` is a render-scoped callback; only the key drives resets.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  if (!copy) return null;

  function toggle() {
    setExpanded((open) => {
      onExpandedChange?.(!open);
      return !open;
    });
  }

  return (
    <div
      className={`movie-synopsis${expanded ? " is-expanded" : ""}${className ? ` ${className}` : ""}`}
      style={{ ["--bf-synopsis-lines" as string]: String(lines) }}
    >
      <p className={`movie-synopsis-copy${copyClassName ? ` ${copyClassName}` : ""}`}>{copy}</p>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={toggle}
        className="mt-2 inline-flex items-center gap-1.5 text-control font-bold text-white transition hover:text-netflix-red"
      >
        {expanded ? "Thu gọn" : "Xem thêm"}
        <ChevronDown className="movie-synopsis-icon h-4 w-4" aria-hidden="true" />
      </button>
    </div>
  );
}
