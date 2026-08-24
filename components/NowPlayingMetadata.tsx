"use client";

import { useEffect } from "react";
import { buildNowPlaying } from "@/lib/media-session";

type NowPlayingMetadataProps = {
  name: string;
  originName?: string;
  type?: string;
  episodeName?: string;
  artworkSrc?: string;
};

/** Drives the iOS lock-screen Now Playing panel for the native <video>
 * playback path. Cleared on unmount so switching away (or to an embed) does
 * not leave a stale entry pinned to the lock screen. */
export function NowPlayingMetadata({ name, originName, type, episodeName, artworkSrc }: NowPlayingMetadataProps) {
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;

    const { title, artist, album, artwork } = buildNowPlaying({ name, originName, type, episodeName, artworkSrc });
    navigator.mediaSession.metadata = new MediaMetadata({ title, artist, album, artwork });

    return () => {
      navigator.mediaSession.metadata = null;
    };
  }, [name, originName, type, episodeName, artworkSrc]);

  return null;
}
