import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractHlsSegments, parseHlsManifest } from "../src/lib/parseHls";

const FIXTURES = join(__dirname, "fixtures");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

const MASTER_URL = "https://cdn.example.com/hls/master.m3u8";

describe("parseHlsManifest — master playlist", () => {
  const text = fixture("master.m3u8");
  const result = parseHlsManifest(text, MASTER_URL);

  it("finds all variants with attributes", () => {
    expect(result.isMaster).toBe(true);
    expect(result.variants).toHaveLength(3);
    expect(result.variants[0].resolution).toBe("1280x720");
    expect(result.variants[0].height).toBe(720);
    expect(result.variants[0].width).toBe(1280);
    expect(result.variants[0].bandwidth).toBe(2149286);
    expect(result.variants[0].codecs).toContain("avc1.64001f");
  });

  it("resolves variant URIs against the manifest URL", () => {
    expect(result.variants[0].url).toBe("https://cdn.example.com/hls/video/720p.m3u8");
    expect(result.variants[1].url).toBe("https://cdn.example.com/hls/video/360p.m3u8");
    expect(result.variants[2].url).toBe("https://cdn.example.com/hls/audio/only.m3u8");
  });

  it("is not DRM protected", () => {
    expect(result.drmProtected).toBe(false);
    expect(result.drmReason).toBeUndefined();
  });
});

describe("parseHlsManifest — media playlist", () => {
  const result = parseHlsManifest(fixture("media-fmp4.m3u8"), MASTER_URL);

  it("degrades to a single variant (the manifest itself)", () => {
    expect(result.isMaster).toBe(false);
    expect(result.variants).toHaveLength(1);
    expect(result.variants[0].url).toBe(MASTER_URL);
  });

  it("stays clean when no key tags exist", () => {
    expect(result.drmProtected).toBe(false);
  });
});

describe("parseHlsManifest — DRM detection", () => {
  it("flags AES-128 encrypted playlists via the raw tag scan", () => {
    const result = parseHlsManifest(fixture("media-encrypted.m3u8"), MASTER_URL);
    expect(result.drmProtected).toBe(true);
    expect(result.drmReason).toMatch(/encrypted|EXT-X-KEY/i);
  });

  it("flags METHOD=NONE as clean", () => {
    const clean = fixture("media-ts.m3u8").replace(
      "#EXT-X-PLAYLIST-TYPE:VOD",
      '#EXT-X-KEY:METHOD=NONE\n#EXT-X-PLAYLIST-TYPE:VOD',
    );
    expect(parseHlsManifest(clean, MASTER_URL).drmProtected).toBe(false);
  });

  it("never throws for encrypted input", () => {
    expect(() => parseHlsManifest(fixture("media-encrypted.m3u8"), MASTER_URL)).not.toThrow();
  });
});

describe("extractHlsSegments", () => {
  // NOTE: the parser resolves relative URIs against the playlist URL minus
  // its last path segment (no trailing slash kept) — "init.mp4" next to
  // "…/video/720p.m3u8" becomes "…/video/init.mp4".
  const BASE = "https://cdn.example.com/hls/video/720p.m3u8";

  it("resolves relative segment URIs against the variant playlist", () => {
    const segs = extractHlsSegments(fixture("media-fmp4.m3u8"), BASE);
    expect(segs).toContain("https://cdn.example.com/hls/video/init.mp4");
    expect(segs).toContain("https://cdn.example.com/hls/video/seg-0.m4s");
  });

  it("puts the init segment first, exactly once", () => {
    const segs = extractHlsSegments(fixture("media-fmp4.m3u8"), BASE);
    expect(segs[0]).toContain("init.mp4");
    expect(segs.filter((s) => s.includes("init.mp4"))).toHaveLength(1);
    expect(segs).toHaveLength(4); // init + 3 segments
  });

  it("keeps segment order for plain TS playlists", () => {
    const segs = extractHlsSegments(fixture("media-ts.m3u8"), BASE);
    expect(segs).toHaveLength(4);
    expect(segs[0]).toContain("chunk-000.ts");
    expect(segs[3]).toContain("chunk-003.ts");
    expect(segs.every((s) => s.startsWith("https://cdn.example.com/hls/video/"))).toBe(true);
  });
});
