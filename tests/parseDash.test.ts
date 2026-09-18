import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseDashManifest } from "../src/lib/parseDash";

const FIXTURES = join(__dirname, "fixtures");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

const MPD_URL = "https://cdn.example.com/dash/static.mpd";

describe("parseDashManifest — static MPD", () => {
  const result = parseDashManifest(fixture("static.mpd"), MPD_URL);

  it("produces a variant per video Representation", () => {
    expect(result.drmProtected).toBe(false);
    // mpd-parser exposes video Representations as playlists; audio lands in
    // mediaGroups and is paired at download time, not as its own variant.
    expect(result.variants).toHaveLength(2);
  });

  it("records resolution, bandwidth, and codecs", () => {
    const heights = result.variants.map((v) => v.height).sort((a, b) => (b ?? 0) - (a ?? 0));
    expect(heights).toEqual([1080, 720]);
    const v1080 = result.variants.find((v) => v.height === 1080)!;
    expect(v1080.width).toBe(1920);
    expect(v1080.bandwidth).toBe(4000000);
    expect(v1080.codecs).toBe("avc1.640028");
  });

  it("resolves SegmentTemplate media URLs against the manifest URI", () => {
    const v1080 = result.variants.find((v) => v.height === 1080)!;
    expect(v1080.segments?.length).toBeGreaterThan(0);
    for (const s of v1080.segments ?? []) {
      expect(s.startsWith("https://cdn.example.com/dash/")).toBe(true);
    }
    expect(v1080.segments?.some((s) => s.includes("video/1080p/init.mp4"))).toBe(true);
    expect(v1080.segments?.some((s) => /video\/1080p\/seg-\d+\.m4s$/.test(s))).toBe(true);
  });

  it("emits the init segment before media segments", () => {
    const v1080 = result.variants.find((v) => v.height === 1080)!;
    expect(v1080.segments?.[0]).toContain("video/1080p/init.mp4");
  });

  it("keeps variants pointing at the manifest URL", () => {
    expect(result.variants.every((v) => v.url === MPD_URL)).toBe(true);
  });
});

describe("parseDashManifest — DRM detection", () => {
  it("flags ContentProtection from the raw XML scan", () => {
    const result = parseDashManifest(fixture("drm.mpd"), MPD_URL);
    expect(result.drmProtected).toBe(true);
    expect(result.drmReason).toMatch(/ContentProtection/);
  });

  it("never throws on DRM manifests", () => {
    expect(() => parseDashManifest(fixture("drm.mpd"), MPD_URL)).not.toThrow();
  });

  it("reports clean for manifests without protection", () => {
    expect(parseDashManifest(fixture("static.mpd"), MPD_URL).drmProtected).toBe(false);
  });
});
