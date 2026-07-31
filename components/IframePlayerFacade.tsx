"use client";

import { useState } from "react";
import { Play } from "lucide-react";

type IframePlayerFacadeProps = {
  onError?: () => void;
  src: string;
  poster?: string;
  title: string;
};

export function IframePlayerFacade({ onError, src, poster, title }: IframePlayerFacadeProps) {
  const [isPlaying, setIsPlaying] = useState(false);

  if (isPlaying) {
    return (
      <iframe
        src={src}
        title={title}
        allow="autoplay; fullscreen; picture-in-picture"
        referrerPolicy="no-referrer-when-downgrade"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-forms"
        allowFullScreen
        onError={onError}
        className="h-full w-full border-0 bg-black"
      />
    );
  }

  return (
    <button
      type="button"
      aria-label={`Phát ${title}`}
      onClick={() => setIsPlaying(true)}
      className="group relative block h-full w-full cursor-pointer overflow-hidden bg-obsidian text-left transition duration-300 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-glacier-beam"
    >
      {poster ? (
        <img
          src={poster}
          alt=""
          className="absolute inset-0 h-full w-full object-cover opacity-40 transition duration-700 ease-out group-hover:scale-105 group-hover:opacity-30"
          loading="eager"
          decoding="async"
        />
      ) : null}
      <span className="absolute inset-0 bg-obsidian/80 transition-colors duration-300 group-hover:bg-obsidian/65" />
      <span className="absolute inset-0 grid place-items-center p-4">
        <span className="player-play-pulse rounded-full">
          <span className="flex h-[96px] w-[96px] items-center justify-center rounded-full border border-snow/20 bg-signal-blue text-snow shadow-[0_10px_32px_rgba(0,0,0,0.45)] transition duration-200 group-hover:scale-105 group-hover:bg-signal-blue/90 sm:h-[112px] sm:w-[112px]">
            <Play className="ml-1.5 h-[44px] w-[44px] fill-current sm:ml-2 sm:h-[52px] sm:w-[52px]" aria-hidden="true" />
          </span>
        </span>
      </span>
    </button>
  );
}
