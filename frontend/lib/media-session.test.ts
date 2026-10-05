import { describe, expect, it } from "vitest";
import { buildNowPlaying, titleWithSeason } from "@/lib/media-session";

describe("titleWithSeason", () => {
  it("leaves the name untouched when it already carries a Phần marker", () => {
    expect(titleWithSeason("Tài phiệt và Cảnh sát (Phần 2)", "Flex X Cop (Season 2)"))
      .toBe("Tài phiệt và Cảnh sát (Phần 2)");
  });

  it("appends Phần N from origin_name's Season N when the name lacks it", () => {
    expect(titleWithSeason("Flex X Cop", "Flex X Cop (Season 2)")).toBe("Flex X Cop (Phần 2)");
  });

  it("appends Phần N from origin_name's Part N", () => {
    expect(titleWithSeason("Some Show", "Some Show Part 3")).toBe("Some Show (Phần 3)");
  });

  it("leaves the name untouched when neither side has a season marker", () => {
    expect(titleWithSeason("Tiên Nghịch", "Renegade Immortal")).toBe("Tiên Nghịch");
  });

  it("handles a missing origin_name", () => {
    expect(titleWithSeason("Doraemon (2005)")).toBe("Doraemon (2005)");
  });
});

describe("buildNowPlaying", () => {
  it("uses the current episode name as artist for series", () => {
    const result = buildNowPlaying({
      name: "Tài phiệt và Cảnh sát (Phần 2)",
      originName: "Flex X Cop (Season 2)",
      type: "series",
      episodeName: "Tập 06",
      artworkSrc: "https://img.bluesia.net/i/m/abc.webp"
    });
    expect(result.title).toBe("Tài phiệt và Cảnh sát (Phần 2)");
    expect(result.artist).toBe("Tập 06");
    expect(result.album).toBe("Bluesia Cinema");
  });

  it("falls back to origin_name for a single movie (no episode)", () => {
    const result = buildNowPlaying({
      name: "Giao Lộ",
      originName: "Crossroads",
      type: "single",
      episodeName: "Full"
    });
    expect(result.artist).toBe("Crossroads");
  });

  it("falls back to origin_name when the episode label is the generic Full marker", () => {
    const result = buildNowPlaying({
      name: "Show Đặc Biệt",
      originName: "Special Show",
      type: "hoathinh",
      episodeName: "Full"
    });
    expect(result.artist).toBe("Special Show");
  });

  it("leaves artist empty when there's no episode and origin_name matches name", () => {
    const result = buildNowPlaying({ name: "Phim Việt", originName: "Phim Việt", type: "single" });
    expect(result.artist).toBe("");
  });

  it("always includes the PNG icon fallback artwork after the primary artwork", () => {
    const result = buildNowPlaying({
      name: "X",
      type: "series",
      episodeName: "Tập 01",
      artworkSrc: "https://img.bluesia.net/i/m/x.webp"
    });
    expect(result.artwork).toEqual([
      { src: "https://img.bluesia.net/i/m/x.webp", sizes: "480x720", type: "image/webp" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" }
    ]);
  });

  it("still returns the icon fallback artwork when no artworkSrc is given", () => {
    const result = buildNowPlaying({ name: "X", type: "series", episodeName: "Tập 01" });
    expect(result.artwork).toEqual([{ src: "/icon-512.png", sizes: "512x512", type: "image/png" }]);
  });
});
