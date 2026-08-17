import { describe, test, expect } from "vitest";
import {
  isIOSDevice,
  isAndroidDevice,
  isDesktopDevice,
  normalizePlaybackUrl,
  resolveHlsPlaybackSource,
  resolvePlaybackSource,
} from "./playback";

const ios = {
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
  platform: "iPhone",
  maxTouchPoints: 5,
};

const ipadDesktopMode = {
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
  platform: "MacIntel",
  maxTouchPoints: 5,
};

const android = {
  userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)",
  platform: "Linux armv8l",
  maxTouchPoints: 5,
};

const desktop = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  platform: "Win32",
  maxTouchPoints: 0,
};

describe("isIOSDevice", () => {
  test("detects iPhone", () => {
    expect(isIOSDevice(ios)).toBe(true);
  });

  test("detects iPad in desktop mode (MacIntel + touch)", () => {
    expect(isIOSDevice(ipadDesktopMode)).toBe(true);
  });

  test("rejects Android", () => {
    expect(isIOSDevice(android)).toBe(false);
  });

  test("rejects desktop", () => {
    expect(isIOSDevice(desktop)).toBe(false);
  });

  test("returns false when no navigator", () => {
    expect(isIOSDevice(undefined)).toBe(false);
  });

  test("rejects MacIntel without touch (real Mac)", () => {
    expect(isIOSDevice({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
      platform: "MacIntel",
      maxTouchPoints: 0,
    })).toBe(false);
  });
});

describe("isAndroidDevice", () => {
  test("detects Android", () => {
    expect(isAndroidDevice(android)).toBe(true);
  });

  test("rejects iOS", () => {
    expect(isAndroidDevice(ios)).toBe(false);
  });

  test("rejects desktop", () => {
    expect(isAndroidDevice(desktop)).toBe(false);
  });

  test("returns false when no navigator", () => {
    expect(isAndroidDevice(undefined)).toBe(false);
  });
});

describe("isDesktopDevice", () => {
  test("detects desktop", () => {
    expect(isDesktopDevice(desktop)).toBe(true);
  });

  test("rejects iOS", () => {
    expect(isDesktopDevice(ios)).toBe(false);
  });

  test("rejects Android", () => {
    expect(isDesktopDevice(android)).toBe(false);
  });

  test("returns true in Node (navigator exists but is not mobile)", () => {
    // In Node/Vitest, globalThis.navigator exists but has no mobile UA,
    // so isDesktopDevice() with default navigator returns true.
    expect(isDesktopDevice()).toBe(true);
  });
});

describe("normalizePlaybackUrl", () => {
  test("accepts https URL", () => {
    expect(normalizePlaybackUrl("https://example.com/video.m3u8")).toBe("https://example.com/video.m3u8");
  });

  test("accepts http URL", () => {
    expect(normalizePlaybackUrl("http://example.com/video.m3u8")).toBe("http://example.com/video.m3u8");
  });

  test("rejects empty string", () => {
    expect(normalizePlaybackUrl("")).toBeUndefined();
  });

  test("rejects undefined", () => {
    expect(normalizePlaybackUrl(undefined)).toBeUndefined();
  });

  test("trims whitespace", () => {
    expect(normalizePlaybackUrl("  https://example.com/video  ")).toBe("https://example.com/video");
  });

  test("rejects non-http protocols", () => {
    expect(normalizePlaybackUrl("ftp://example.com/video")).toBeUndefined();
    expect(normalizePlaybackUrl("javascript:alert(1)")).toBeUndefined();
  });

  test("rejects malformed URLs", () => {
    expect(normalizePlaybackUrl("not a url")).toBeUndefined();
  });
});

function mockVideo(canPlayHls: boolean): HTMLVideoElement {
  return {
    canPlayType: (type: string) =>
      type === "application/vnd.apple.mpegurl" && canPlayHls ? "maybe" : "",
  } as unknown as HTMLVideoElement;
}

describe("resolveHlsPlaybackSource", () => {
  test("returns native-hls when video supports HLS", () => {
    const result = resolveHlsPlaybackSource("https://example.com/video.m3u8", mockVideo(true));
    expect(result).toEqual({ mode: "native-hls", hlsUrl: "https://example.com/video.m3u8" });
  });

  test("returns hls-js when video does not support HLS", () => {
    const result = resolveHlsPlaybackSource("https://example.com/video.m3u8", mockVideo(false));
    expect(result).toEqual({ mode: "hls-js", hlsUrl: "https://example.com/video.m3u8" });
  });

  test("returns none when URL is empty", () => {
    expect(resolveHlsPlaybackSource("", mockVideo(true))).toEqual({ mode: "none" });
    expect(resolveHlsPlaybackSource(undefined, mockVideo(true))).toEqual({ mode: "none" });
  });
});

describe("resolvePlaybackSource", () => {
  const iframe = "https://embed.example.com/player";
  const hls = "https://cdn.example.com/video.m3u8";

  test("desktop prefers iframe over HLS", () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", { value: desktop, configurable: true });
    try {
      const result = resolvePlaybackSource({ iframeUrl: iframe, hlsUrl: hls }, mockVideo(false));
      expect(result.mode).toBe("iframe");
      expect(result.iframeUrl).toBe(iframe);
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
    }
  });

  test("desktop falls back to hls-js when no iframe", () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", { value: desktop, configurable: true });
    try {
      const result = resolvePlaybackSource({ hlsUrl: hls }, mockVideo(false));
      expect(result.mode).toBe("hls-js");
      expect(result.hlsUrl).toBe(hls);
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
    }
  });

  test("Android prefers iframe over HLS", () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", { value: android, configurable: true });
    try {
      const result = resolvePlaybackSource({ iframeUrl: iframe, hlsUrl: hls }, mockVideo(false));
      expect(result.mode).toBe("iframe");
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
    }
  });

  test("iOS prefers native HLS when available", () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", { value: ios, configurable: true });
    try {
      const result = resolvePlaybackSource({ iframeUrl: iframe, hlsUrl: hls }, mockVideo(true));
      expect(result.mode).toBe("native-hls");
      expect(result.hlsUrl).toBe(hls);
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
    }
  });

  test("iOS falls back to iframe when no native HLS", () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", { value: ios, configurable: true });
    try {
      const result = resolvePlaybackSource({ iframeUrl: iframe }, mockVideo(false));
      expect(result.mode).toBe("iframe");
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
    }
  });

  test("iOS uses hls-js as last resort", () => {
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", { value: ios, configurable: true });
    try {
      const result = resolvePlaybackSource({ hlsUrl: hls }, mockVideo(false));
      expect(result.mode).toBe("hls-js");
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
    }
  });

  test("returns none when no sources and no navigator", () => {
    const original = globalThis.navigator;
    // @ts-expect-error — removing navigator for test
    delete globalThis.navigator;
    try {
      const result = resolvePlaybackSource({}, mockVideo(false));
      expect(result.mode).toBe("none");
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
    }
  });
});
