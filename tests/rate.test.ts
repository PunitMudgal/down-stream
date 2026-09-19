import { describe, expect, it } from "vitest";
import { RateMeter, RATE_WINDOW_MS } from "../src/lib/rate";

describe("RateMeter", () => {
  it("reports nothing until two samples span enough time", () => {
    const m = new RateMeter();
    expect(m.add(0, 0)).toBeUndefined();
    expect(m.add(1000, 200)).toBeUndefined(); // span below the noise floor
    expect(m.add(3000, 1000)).toBeCloseTo(3000); // 2000 bytes / 1000 ms -> 2000 B/s
  });

  it("computes bytes/second across the retained window", () => {
    const m = new RateMeter();
    m.add(0, 0);
    expect(m.add(1_000_000, 2000)).toBeCloseTo(500_000);
  });

  it("slides the window so an old burst stops inflating the current rate", () => {
    const m = new RateMeter();
    m.add(0, 0);
    m.add(1_000_000, 1000); // a fast first second
    // Long stall: the burst ages out of the window, so there is no current rate.
    expect(m.add(1_000_000, 10_000)).toBeUndefined();
    const stalled = m.add(1_000_000, 10_000 + RATE_WINDOW_MS);
    expect(stalled).toBeUndefined();
    // Progress resumes — the rate reflects only the recent window again.
    expect(m.add(1_100_000, 10_000 + RATE_WINDOW_MS + 1000)).toBeCloseTo(100_000);
  });

  it("ignores duplicate and out-of-order readings", () => {
    const m = new RateMeter();
    m.add(0, 0);
    m.add(1000, 1000);
    const before = m.bps;
    expect(m.add(1000, 1000)).toBe(before);
    expect(m.add(500, 500)).toBe(before); // older timestamp
  });

  it("resets to unknown", () => {
    const m = new RateMeter();
    m.add(0, 0);
    m.add(1000, 1000);
    m.reset();
    expect(m.bps).toBeUndefined();
  });
});
