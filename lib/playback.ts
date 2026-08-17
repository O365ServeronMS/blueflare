export type PlaybackMode = "iframe" | "native-hls" | "hls-js" | "none";

export type PlaybackSource = {
  mode: PlaybackMode;
  iframeUrl?: string;
  hlsUrl?: string;
};

type NavigatorLike = Pick<Navigator, "maxTouchPoints" | "platform" | "userAgent">;

function currentNavigator(): NavigatorLike | undefined {
  return typeof navigator === "undefined" ? undefined : navigator;
}

export function isIOSDevice(value = currentNavigator()) {
  if (!value) return false;
  return /iPhone|iPad|iPod/i.test(value.userAgent)
    || (value.platform === "MacIntel" && value.maxTouchPoints > 1);
}

export function isAndroidDevice(value = currentNavigator()) {
  return Boolean(value && /Android/i.test(value.userAgent));
}

export function isDesktopDevice(value = currentNavigator()) {
  return Boolean(value && !isIOSDevice(value) && !isAndroidDevice(value));
}

export function canPlayNativeHls(video: HTMLVideoElement) {
  return Boolean(video.canPlayType("application/vnd.apple.mpegurl"));
}

export function normalizePlaybackUrl(value?: string) {
  const source = String(value || "").trim();
  if (!source) return undefined;

  try {
    const url = new URL(source);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function resolveHlsPlaybackSource(hlsUrl: string | undefined, video: HTMLVideoElement): PlaybackSource {
  const normalizedHlsUrl = normalizePlaybackUrl(hlsUrl);
  if (!normalizedHlsUrl) return { mode: "none" };
  return canPlayNativeHls(video)
    ? { mode: "native-hls", hlsUrl: normalizedHlsUrl }
    : { mode: "hls-js", hlsUrl: normalizedHlsUrl };
}

export function resolvePlaybackSource(
  sources: { iframeUrl?: string; hlsUrl?: string },
  video: HTMLVideoElement,
): PlaybackSource {
  const iframeUrl = normalizePlaybackUrl(sources.iframeUrl);
  const hlsUrl = normalizePlaybackUrl(sources.hlsUrl);

  // iOS, including iPadOS desktop mode, gets Safari-native HLS before embeds.
  if (isIOSDevice()) {
    if (hlsUrl && canPlayNativeHls(video)) return { mode: "native-hls", hlsUrl };
    if (iframeUrl) return { mode: "iframe", iframeUrl };
    if (hlsUrl) return { mode: "hls-js", hlsUrl };
  }

  // Desktop and Android avoid client HLS work whenever the API supplies an embed.
  if (isAndroidDevice() || isDesktopDevice()) {
    if (iframeUrl) return { mode: "iframe", iframeUrl };
    return resolveHlsPlaybackSource(hlsUrl, video);
  }

  return { mode: "none" };
}
