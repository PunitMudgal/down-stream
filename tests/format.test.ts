import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration, formatEta, formatProgressPair, formatSpeed } from "../src/lib/format";

describe("formatBytes", () => {
  it("scales across KB, MB and GB", () => {
    expect(formatBytes(1500)).toBe("2 KB");
    expect(formatBytes(1_500_000)).toBe("1.5 MB");
    expect(formatBytes(2_500_000_000)).toBe("2.50 GB");
  });

  it("never prints negatives or an empty value", () => {
    expect(formatBytes(0)).toBe("0 KB");
    expect(formatBytes(-5)).toBe("0 KB");
    expect(formatBytes(Number.NaN)).toBe("0 KB");
  });
});

describe("formatSpeed", () => {
  it("scales and rejects unusable rates", () => {
    expect(formatSpeed(250_000)).toBe("250 KB/s");
    expect(formatSpeed(12_000_000)).toBe("12.0 MB/s");
    expect(formatSpeed(0)).toBe("");
    expect(formatSpeed(Number.NaN)).toBe("");
  });
});

describe("formatEta", () => {
  it("uses seconds, minutes then hours", () => {
    expect(formatEta(3)).toBe("~a few sec left");
    expect(formatEta(45)).toBe("~45s left");
    expect(formatEta(150)).toBe("~2m 30s left");
    expect(formatEta(3900)).toBe("~1h 5m left");
  });

  it("returns empty for invalid input", () => {
    expect(formatEta(-1)).toBe("");
    expect(formatEta(Number.NaN)).toBe("");
  });
});

describe("formatDuration", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatDuration(34)).toBe("0:34");
    expect(formatDuration(3723)).toBe("1:02:03");
  });

  it("returns empty for missing/invalid values", () => {
    expect(formatDuration(undefined)).toBe("");
    expect(formatDuration(0)).toBe("");
    expect(formatDuration(-2)).toBe("");
  });
});

describe("formatProgressPair", () => {
  it("shows a pair when the total is known, otherwise the raw value", () => {
    expect(formatProgressPair(1_000_000, 4_000_000)).toBe("1.0 MB/4.0 MB");
    expect(formatProgressPair(1_000_000, 0)).toBe("1.0 MB");
  });
});
