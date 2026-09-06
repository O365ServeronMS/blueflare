"use client";

import { useEffect, useRef, useState } from "react";
import { canPlayNativeHls, type PlaybackMode } from "@/lib/playback";

type HlsErrorData = {
  fatal?: boolean;
  type?: string;
};

type HlsListener = (event: string, data: HlsErrorData) => void;

type HlsRuntime = {
  attachMedia: (media: HTMLMediaElement) => void;
  destroy: () => void;
  loadSource: (source: string) => void;
  off: (event: string, listener: (...args: never[]) => void) => void;
  on: (event: string, listener: (...args: never[]) => void) => void;
  recoverMediaError: () => void;
  startLoad: () => void;
};

type HlsConstructor = {
  new (config: Record<string, unknown>): HlsRuntime;
  ErrorTypes: {
    MEDIA_ERROR: string;
    NETWORK_ERROR: string;
  };
  Events: {
    ERROR: string;
  };
  isSupported: () => boolean;
};

type NavigatorWithConnection = Navigator & {
  connection?: {
    effectiveType?: string;
    saveData?: boolean;
  };
};

const DEFAULT_HLS_BUFFER_CONFIG = {
  enableWorker: true,
  lowLatencyMode: false,
  maxBufferLength: 60,
  maxMaxBufferLength: 120,
  backBufferLength: 60,
  maxBufferSize: 60 * 1000 * 1000,
  manifestLoadingMaxRetry: 3,
  manifestLoadingRetryDelay: 1000,
  fragLoadingMaxRetry: 4,
  fragLoadingRetryDelay: 1000,
};

let hlsModulePromise: Promise<{ default: HlsConstructor }> | null = null;

function loadHlsModule() {
  if (!hlsModulePromise) {
    // Keep the light build outside the initial chunk and reuse one import per browser session.
    // @ts-expect-error hls.js does not publish declarations for the light-build subpath.
    hlsModulePromise = import("hls.js/dist/hls.light.js") as Promise<{ default: HlsConstructor }>;
  }
  return hlsModulePromise;
}

function hasGoodNetworkForAggressiveBuffering() {
  const connection = (navigator as NavigatorWithConnection).connection;
  if (!connection || connection.saveData) return false;
  const effectiveType = connection.effectiveType?.toLowerCase();
  return effectiveType !== "slow-2g" && effectiveType !== "2g";
}

function getHlsBufferConfig() {
  if (!hasGoodNetworkForAggressiveBuffering()) return DEFAULT_HLS_BUFFER_CONFIG;
  return {
    ...DEFAULT_HLS_BUFFER_CONFIG,
    maxBufferLength: 180,
    maxMaxBufferLength: 300,
    maxBufferSize: 120 * 1000 * 1000,
  };
}

export function HlsVideo({
  mode,
  onPlaybackFailure,
  poster,
  src,
}: {
  mode: Extract<PlaybackMode, "native-hls" | "hls-js">;
  onPlaybackFailure?: () => void;
  poster?: string;
  src: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const failureRef = useRef(onPlaybackFailure);
  const [error, setError] = useState("");
  failureRef.current = onPlaybackFailure;

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !src) return;

    let disposed = false;
    let hlsInstance: HlsRuntime | null = null;
    const cleanupListeners: Array<() => void> = [];

    setError("");
    video.pause();
    video.removeAttribute("src");
    video.load();

    const fail = (message: string) => {
      if (disposed) return;
      setError(message);
      failureRef.current?.();
    };

    async function setup() {
      if (!video || disposed) return;

      if (mode === "native-hls") {
        if (!canPlayNativeHls(video)) {
          fail("Trình duyệt không hỗ trợ HLS gốc.");
          return;
        }
        const onNativeError = () => fail("Không thể phát nguồn HLS gốc.");
        video.addEventListener("error", onNativeError, { once: true });
        cleanupListeners.push(() => video.removeEventListener("error", onNativeError));
        video.src = src;
        video.load();
        return;
      }

      try {
        const { default: Hls } = await loadHlsModule();
        if (disposed) return;
        if (!Hls.isSupported()) {
          fail("Trình duyệt không hỗ trợ HLS.");
          return;
        }

        const hls = new Hls(getHlsBufferConfig());
        const onHlsError: HlsListener = (_event, data) => {
          if (!data.fatal || disposed) return;
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            hls.startLoad();
            return;
          }
          if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
            hls.recoverMediaError();
            return;
          }
          hls.destroy();
          hlsInstance = null;
          fail("Không thể phục hồi phiên phát HLS.");
        };

        hlsInstance = hls;
        hls.on(Hls.Events.ERROR, onHlsError as (...args: never[]) => void);
        cleanupListeners.push(() => {
          hls.off(Hls.Events.ERROR, onHlsError as (...args: never[]) => void);
        });
        hls.loadSource(src);
        hls.attachMedia(video);
      } catch {
        fail("Không thể tải trình phát HLS.");
      }
    }

    void setup();
    return () => {
      disposed = true;
      cleanupListeners.forEach((cleanup) => cleanup());
      if (hlsInstance) {
        hlsInstance.destroy();
      }
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [mode, src]);

  return (
    <div className="relative h-full w-full bg-black">
      <video ref={videoRef} className="h-full w-full bg-black" controls playsInline preload="metadata" poster={poster} />
      {error ? <div className="absolute inset-0 grid place-items-center bg-black p-6 text-center text-control text-zinc-400">{error}</div> : null}
    </div>
  );
}
