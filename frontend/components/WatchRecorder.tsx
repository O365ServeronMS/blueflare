"use client";

import { useEffect } from "react";
import { addHistory } from "@/components/LocalMovieActions";
import type { MovieCard } from "@/lib/types";

export function WatchRecorder({ movie }: { movie: MovieCard }) {
  useEffect(() => {
    addHistory(movie);
  }, [movie]);
  return null;
}
