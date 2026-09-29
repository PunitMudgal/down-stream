import { describe, expect, it } from "vitest";
import { countForBadge } from "../src/bg/media";
import type { MediaItem } from "../src/lib/types";

function item(over: Partial<MediaItem> & { url: string }): MediaItem {
  return {
    tabId: 3,
    type: "mp4",
    filename: "v.mp4",
    detectedAt: 1,
    drmProtected: false,
    ...over,
  } as MediaItem;
}

describe("countForBadge", () => {
  it("counts a lone blob player row instead of showing no badge", () => {
    const blob = item({ url: "blob:https://site/1", type: "blob", filename: "" });
    expect(countForBadge([blob])).toBe(1);
  });

  it("counts the downloadable row once a blob upgrades", () => {
    const blob = item({ url: "blob:https://site/1", type: "blob", filename: "" });
    const file = item({ url: "https://site/v.mp4", type: "mp4" });
    expect(countForBadge([blob, file])).toBe(1);
  });

  it("counts nothing for DRM-only or empty pages", () => {
    const drm = item({ url: "https://site/d.m3u8", type: "hls", drmProtected: true });
    expect(countForBadge([drm])).toBe(0);
    expect(countForBadge([])).toBe(0);
  });
});
