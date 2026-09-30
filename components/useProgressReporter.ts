"use client";

import { useEffect, type RefObject } from "react";
import { createProgressReporter, putProgress } from "@/lib/progress-report";

/** Reports playback position of a real <video>; pass null to stay silent. */
export function useProgressReporter(
  videoRef: RefObject<HTMLVideoElement | null>,
  config: { slug: string; episodeKey: string } | null
) {
  const slug = config?.slug;
  const episodeKey = config?.episodeKey;
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !slug || !episodeKey) return;
    const reporter = createProgressReporter({ slug, episodeKey, send: putProgress });
    const sample = () => reporter.tick(video.currentTime, video.duration);
    const flush = () => {
      sample();
      reporter.flush();
    };
    const onHidden = () => {
      if (document.visibilityState === "hidden") flush();
    };
    video.addEventListener("timeupdate", sample);
    video.addEventListener("pause", flush);
    video.addEventListener("ended", flush);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", flush);
    return () => {
      video.removeEventListener("timeupdate", sample);
      video.removeEventListener("pause", flush);
      video.removeEventListener("ended", flush);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", flush);
      // Episode change / unmount: send the last sample seen, do not re-read a reset element.
      reporter.dispose();
    };
  }, [videoRef, slug, episodeKey]);
}
