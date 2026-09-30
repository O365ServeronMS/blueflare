import { describe, expect, test } from "vitest";
import { clampProgress, progressWidth } from "@/lib/progress";

describe("clampProgress", () => {
  test("keeps values inside 0..1", () => {
    expect(clampProgress(0.4)).toBe(0.4);
    expect(clampProgress(0)).toBe(0);
    expect(clampProgress(1)).toBe(1);
  });
  test("clamps out-of-range values", () => {
    expect(clampProgress(-2)).toBe(0);
    expect(clampProgress(3)).toBe(1);
  });
  test("treats missing or non-finite as 0", () => {
    expect(clampProgress(undefined)).toBe(0);
    expect(clampProgress(null)).toBe(0);
    expect(clampProgress(NaN)).toBe(0);
    expect(clampProgress(Infinity)).toBe(0);
  });
});

describe("progressWidth", () => {
  test("formats a percentage", () => {
    expect(progressWidth(0.425)).toBe("42.5%");
    expect(progressWidth(2)).toBe("100%");
    expect(progressWidth(undefined)).toBe("0%");
  });
});
