import { describe, expect, it } from "vitest";
import { forDisplay } from "../src/lib/target";
import type { MediaItem } from "../src/lib/types";

function item(over: Partial<MediaItem>): MediaItem {
  return {
    url: "https://cdn.example.com/x",
    tabId: 1,
    type: "mp4",
    filename: "x.mp4",
    detectedAt: 1,
    drmProtected: false,
    ...over,
  };
}

describe("forDisplay", () => {
  it("keeps the blob explanation when it is the only thing found", () => {
    const blob = item({
      url: "blob:https://ig/1",
      type: "blob",
      filename: "",
      error: "Blob/MSE stream",
    });
    expect(forDisplay([blob])).toEqual([blob]);
  });

  it("hides the blob explanation once a downloadable file exists", () => {
    const blob = item({ url: "blob:https://ig/1", type: "blob", filename: "" });
    const file = item({ url: "https://scontent.cdninstagram.com/o1/v/clip.mp4", type: "mp4" });
    expect(forDisplay([blob, file]).map((i) => i.type)).toEqual(["mp4"]);
  });

  it("hides the blob explanation when an MSE capture is downloadable", () => {
    const blob = item({ url: "blob:https://ig/1", type: "blob", filename: "" });
    const cap = item({
      url: "capture:ms-1:0",
      type: "capture",
      filename: "reel-video.mp4",
      captureRef: "ms-1:0",
    });
    expect(forDisplay([blob, cap]).map((i) => i.type)).toEqual(["capture"]);
  });

  it("still hides raw chunk groups when a parsed manifest is present", () => {
    const segs = item({ url: "https://cdn/seg-0.m4s", type: "segments" });
    const hls = item({
      url: "https://cdn/master.m3u8",
      type: "hls",
      variants: [{ id: "v0", url: "https://cdn/v0.m3u8" }],
    });
    expect(forDisplay([segs, hls]).map((i) => i.type)).toEqual(["hls"]);
  });
});
