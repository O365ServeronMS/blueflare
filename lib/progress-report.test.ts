import { describe, expect, test, vi } from "vitest";
import { buildProgressPayload, createProgressReporter } from "@/lib/progress-report";

const base = { slug: "s", episodeKey: "tap-1", now: 1000 };

describe("buildProgressPayload", () => {
  test("rounds and stamps updatedAt", () => {
    expect(buildProgressPayload({ ...base, position: 61.6, duration: 3000.2 })).toEqual({
      slug: "s", episodeKey: "tap-1", positionSec: 62, durationSec: 3000, updatedAt: 1000,
    });
  });
  test("skips live/invalid duration and short positions", () => {
    expect(buildProgressPayload({ ...base, position: 30, duration: Infinity })).toBeNull();
    expect(buildProgressPayload({ ...base, position: 30, duration: NaN })).toBeNull();
    expect(buildProgressPayload({ ...base, position: 0.5, duration: 100 })).toBeNull();
    expect(buildProgressPayload({ ...base, position: 30, duration: 0 })).toBeNull();
  });
  test("clamps position to duration", () => {
    expect(buildProgressPayload({ ...base, position: 101, duration: 100 })?.positionSec).toBe(100);
  });
});

function setup() {
  const send = vi.fn().mockResolvedValue(undefined);
  const reporter = createProgressReporter({ slug: "s", episodeKey: "tap-1", send, now: () => 5 });
  return { send, reporter };
}

describe("createProgressReporter", () => {
  test("throttles ticks to one send per 15s of playback", () => {
    const { send, reporter } = setup();
    for (let t = 2; t < 17; t += 0.5) reporter.tick(t, 600);
    expect(send).toHaveBeenCalledTimes(0);
    reporter.tick(17, 600);
    expect(send).toHaveBeenCalledTimes(1);
    reporter.tick(20, 600);
    expect(send).toHaveBeenCalledTimes(1);
  });
  test("flush sends the latest sample once and skips unchanged data", () => {
    const { send, reporter } = setup();
    reporter.tick(5, 600);
    reporter.flush();
    reporter.flush();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ positionSec: 5, updatedAt: 5 });
  });
  test("never sends for live streams or positions under 1s", () => {
    const { send, reporter } = setup();
    reporter.tick(0.4, 600);
    reporter.flush();
    reporter.tick(50, Infinity);
    reporter.flush();
    expect(send).not.toHaveBeenCalled();
  });
  test("keeps a single request in flight and sends the newest sample afterwards", async () => {
    let release: () => void = () => undefined;
    const send = vi.fn().mockImplementationOnce(() => new Promise<void>((r) => (release = r))).mockResolvedValue(undefined);
    const reporter = createProgressReporter({ slug: "s", episodeKey: "e", send });
    reporter.tick(5, 600);
    reporter.flush();
    reporter.tick(9, 600);
    reporter.flush();
    expect(send).toHaveBeenCalledTimes(1);
    release();
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].positionSec).toBe(9);
  });
  test("swallows send failures without retrying", async () => {
    const send = vi.fn().mockRejectedValue(new Error("offline"));
    const reporter = createProgressReporter({ slug: "s", episodeKey: "e", send });
    reporter.tick(5, 600);
    reporter.flush();
    await new Promise((r) => setTimeout(r, 0));
    expect(send).toHaveBeenCalledTimes(1);
  });
  test("dispose flushes then ignores input", () => {
    const { send, reporter } = setup();
    reporter.tick(8, 600);
    reporter.dispose();
    reporter.tick(40, 600);
    reporter.flush();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
