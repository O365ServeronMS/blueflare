import { describe, expect, it } from "vitest";
import { getRailSlideTarget } from "./rail-motion";

const SNAP_POINTS = [0, 220, 440, 660, 880, 1100, 1320, 1540, 1760];

describe("getRailSlideTarget", () => {
  it("advances by most of the visible rail and lands on a card", () => {
    expect(getRailSlideTarget({
      origin: 0,
      direction: 1,
      viewportWidth: 1000,
      maxScrollLeft: 1800,
      snapPoints: SNAP_POINTS
    })).toBe(880);
  });

  it("moves backward to a card-aligned position", () => {
    expect(getRailSlideTarget({
      origin: 880,
      direction: -1,
      viewportWidth: 1000,
      maxScrollLeft: 1800,
      snapPoints: SNAP_POINTS
    })).toBe(0);
  });

  it("clamps the final slide to the end of the rail", () => {
    expect(getRailSlideTarget({
      origin: 1320,
      direction: 1,
      viewportWidth: 1000,
      maxScrollLeft: 1800,
      snapPoints: SNAP_POINTS
    })).toBe(1800);
  });

  it("does not move beyond either boundary", () => {
    expect(getRailSlideTarget({
      origin: 0,
      direction: -1,
      viewportWidth: 1000,
      maxScrollLeft: 1800,
      snapPoints: SNAP_POINTS
    })).toBe(0);
    expect(getRailSlideTarget({
      origin: 1800,
      direction: 1,
      viewportWidth: 1000,
      maxScrollLeft: 1800,
      snapPoints: SNAP_POINTS
    })).toBe(1800);
  });

  it("always advances at least one card when the page distance is short", () => {
    expect(getRailSlideTarget({
      origin: 0,
      direction: 1,
      viewportWidth: 100,
      maxScrollLeft: 400,
      snapPoints: [0, 200, 400]
    })).toBe(200);
  });
});
