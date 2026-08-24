"use client";

import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { HlsVideo } from "@/components/HlsVideo";
import { IframePlayerFacade } from "@/components/IframePlayerFacade";
import { NowPlayingMetadata } from "@/components/NowPlayingMetadata";
import { WatchRecorder } from "@/components/WatchRecorder";
import {
  normalizePlaybackUrl,
  resolveHlsPlaybackSource,
  resolvePlaybackSource,
  type PlaybackSource,
} from "@/lib/playback";
import type { MovieCard } from "@/lib/types";

type MoviePlayerProps = {
  embedSrc?: string;
  episodeLabel: string;
  episodeName?: string;
  hlsSrc?: string;
  initialOpen?: boolean;
  movie: MovieCard;
  poster?: string;
  preferredMode?: "iframe" | "hls";
  title: string;
};

export function MoviePlayer({
  embedSrc,
  episodeLabel,
  episodeName,
  hlsSrc,
  initialOpen = false,
  movie,
  poster,
  preferredMode,
  title,
}: MoviePlayerProps) {
  const [isOpen, setIsOpen] = useState(initialOpen);
  const [playbackSource, setPlaybackSource] = useState<PlaybackSource | null>(null);
  const playerRef = useRef<HTMLDivElement | null>(null);
  const iframeFailedRef = useRef(false);
  const nativeHlsFailedRef = useRef(false);

  useEffect(() => {
    if (!isOpen) {
      setPlaybackSource(null);
      return;
    }

    iframeFailedRef.current = false;
    nativeHlsFailedRef.current = false;
    const probe = document.createElement("video");
    if (preferredMode === "iframe") {
      const iframeUrl = normalizePlaybackUrl(embedSrc);
      setPlaybackSource(iframeUrl ? { mode: "iframe", iframeUrl } : resolveHlsPlaybackSource(hlsSrc, probe));
      return;
    }
    if (preferredMode === "hls") {
      const hlsSource = resolveHlsPlaybackSource(hlsSrc, probe);
      setPlaybackSource(hlsSource.mode !== "none" ? hlsSource : resolvePlaybackSource({ iframeUrl: embedSrc }, probe));
      return;
    }

    setPlaybackSource(resolvePlaybackSource({ iframeUrl: embedSrc, hlsUrl: hlsSrc }, probe));
  }, [embedSrc, hlsSrc, isOpen, preferredMode]);

  function handleIframeError() {
    iframeFailedRef.current = true;
    const hlsUrl = normalizePlaybackUrl(hlsSrc);
    if (nativeHlsFailedRef.current && hlsUrl) {
      setPlaybackSource({ mode: "hls-js", hlsUrl });
      return;
    }
    setPlaybackSource(resolveHlsPlaybackSource(hlsUrl, document.createElement("video")));
  }

  function handleHlsError() {
    if (playbackSource?.mode === "native-hls") {
      nativeHlsFailedRef.current = true;
      const iframeUrl = normalizePlaybackUrl(embedSrc);
      const hlsUrl = normalizePlaybackUrl(hlsSrc);
      setPlaybackSource(iframeUrl && !iframeFailedRef.current
        ? { mode: "iframe", iframeUrl }
        : hlsUrl
          ? { mode: "hls-js", hlsUrl }
          : { mode: "none" });
      return;
    }
    setPlaybackSource({ mode: "none" });
  }

  return (
    <div className="grid gap-3">
      {isOpen ? (
        <div ref={playerRef} id="movie-player" className="scroll-mt-4 overflow-hidden rounded bg-deep-space">
          <WatchRecorder movie={movie} />
          <div className="watch-header flex items-center justify-between gap-3 border-b border-white/10 bg-black px-4 py-3">
            <div className="min-w-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-netflix-red">Đang chọn</p>
              <p className="truncate text-[14px] font-bold text-white">{episodeLabel}</p>
            </div>
            <button
              type="button"
              aria-label="Đóng player"
              className="grid h-10 w-10 shrink-0 place-items-center rounded text-silver transition-colors hover:bg-graphite hover:text-white"
              onClick={() => setIsOpen(false)}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
          <div className="aspect-video w-full bg-black">
            {playbackSource?.mode === "iframe" && playbackSource.iframeUrl ? (
              <IframePlayerFacade onError={handleIframeError} src={playbackSource.iframeUrl} poster={poster} title={title} />
            ) : (playbackSource?.mode === "native-hls" || playbackSource?.mode === "hls-js") && playbackSource.hlsUrl ? (
              <>
                <NowPlayingMetadata name={movie.name} originName={movie.originName} type={movie.type} episodeName={episodeName} artworkSrc={poster} />
                <HlsVideo mode={playbackSource.mode} onPlaybackFailure={handleHlsError} src={playbackSource.hlsUrl} poster={poster} />
              </>
            ) : playbackSource === null ? (
              <div className="grid h-full place-items-center p-6 text-center text-[14px] text-silver">Đang chuẩn bị player…</div>
            ) : (
              <div className="grid h-full place-items-center p-6 text-center text-[14px] text-silver">No playable source.</div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
