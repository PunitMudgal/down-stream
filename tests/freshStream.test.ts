import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  looksFmp4Segments,
  playlistLooksFmp4,
  resolveDashForDownload,
  resolveHlsForDownload,
  segmentConcurrencyFor,
  SHORT_LIVED_CONCURRENCY,
  isShortLivedSignedUrl,
} from "../src/lib/freshStream";

const FIXTURES = join(__dirname, "fixtures");
function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

describe("isShortLivedSignedUrl", () => {
  it("flags token-gated adult CDNs and signed query strings", () => {
    expect(isShortLivedSignedUrl("https://ev-h.phncdn.com/hls/a/master.m3u8?validfrom=1&hash=x")).toBe(
      true,
    );
    expect(isShortLivedSignedUrl("https://cdn.example.com/seg.ts?token=abc&expires=9")).toBe(true);
    expect(isShortLivedSignedUrl("https://cdn.example.com/seg.ts?Signature=abc&Key-Pair-Id=1")).toBe(
      true,
    );
  });

  it("leaves ordinary static URLs alone", () => {
    expect(isShortLivedSignedUrl("https://cdn.example.com/hls/master.m3u8")).toBe(false);
    expect(isShortLivedSignedUrl("https://cdn.example.com/v/clip.mp4")).toBe(false);
  });
});

describe("segmentConcurrencyFor", () => {
  it("lowers the pool on short-lived signed hosts so the first segments start sooner", () => {
    expect(
      segmentConcurrencyFor(["https://ev-h.phncdn.com/hls/a/seg-0.ts?hash=1"]),
    ).toBe(SHORT_LIVED_CONCURRENCY);
    expect(segmentConcurrencyFor(["https://cdn.example.com/seg-0.ts"])).toBe(8);
  });
});

describe("looksFmp4Segments / playlistLooksFmp4", () => {
  it("detects fMP4 from segment extensions and EXT-X-MAP", () => {
    expect(looksFmp4Segments(["https://c/init.mp4", "https://c/seg-0.m4s"])).toBe(true);
    expect(looksFmp4Segments(["https://c/chunk-000.ts"])).toBe(false);
    expect(playlistLooksFmp4(fixture("media-fmp4.m3u8"), [])).toBe(true);
    expect(playlistLooksFmp4(fixture("media-ts.m3u8"), ["https://c/chunk-000.ts"])).toBe(false);
  });
});

describe("resolveHlsForDownload", () => {
  it("re-reads master + media playlists now and uses those segment URLs", async () => {
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2"
index-1080.m3u8?token=FRESH
`;
    const media = `#EXTM3U
#EXT-X-TARGETDURATION:4
#EXTINF:4.000,
seg-0.ts?token=FRESH
#EXTINF:4.000,
seg-1.ts?token=FRESH
#EXT-X-ENDLIST
`;
    const fetched: string[] = [];
    const plan = await resolveHlsForDownload(
      "https://cdn.example.com/hls/master.m3u8?token=STALE",
      "hls-0",
      async (url) => {
        fetched.push(url);
        if (url.includes("master.m3u8")) return master;
        if (url.includes("index-1080.m3u8")) return media;
        throw new Error(`unexpected fetch ${url}`);
      },
    );
    expect(fetched[0]).toContain("master.m3u8");
    expect(fetched[1]).toContain("index-1080.m3u8?token=FRESH");
    expect(plan.variant.url).toContain("token=FRESH");
    expect(plan.segments).toEqual([
      "https://cdn.example.com/hls/seg-0.ts?token=FRESH",
      "https://cdn.example.com/hls/seg-1.ts?token=FRESH",
    ]);
    expect(plan.muxable).toBe(false);
  });

  it("treats a media playlist as the only variant (no extra fetch)", async () => {
    const plan = await resolveHlsForDownload(
      "https://cdn.example.com/hls/video/720p.m3u8",
      undefined,
      async () => fixture("media-ts.m3u8"),
    );
    expect(plan.segments).toHaveLength(4);
    expect(plan.segments[0]).toBe("https://cdn.example.com/hls/video/chunk-000.ts");
    expect(plan.variant.url).toBe("https://cdn.example.com/hls/video/720p.m3u8");
  });

  it("refuses encrypted media playlists", async () => {
    await expect(
      resolveHlsForDownload("https://cdn.example.com/enc.m3u8", undefined, async () =>
        fixture("media-encrypted.m3u8"),
      ),
    ).rejects.toThrow(/encrypted|Protected/i);
  });

  it("loads a paired audio playlist and reports muxable fMP4 tracks", async () => {
    const master = `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720,CODECS="avc1.64001f",AUDIO="aud"
video.m3u8?t=1
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",DEFAULT=YES,URI="audio.m3u8?t=1"
`;
    const plan = await resolveHlsForDownload(
      "https://cdn.example.com/hls/master.m3u8",
      "hls-0",
      async (url) => {
        if (url.includes("master.m3u8")) return master;
        if (url.includes("video.m3u8")) return fixture("media-fmp4.m3u8");
        if (url.includes("audio.m3u8")) return fixture("media-fmp4.m3u8");
        throw new Error(`unexpected fetch ${url}`);
      },
    );
    expect(plan.pairUrl).toContain("audio.m3u8");
    expect(plan.pairSegments?.length).toBeGreaterThan(0);
    expect(plan.muxable).toBe(true);
  });
});

describe("resolveDashForDownload", () => {
  it("returns segments from the MPD fetched now", async () => {
    const plan = await resolveDashForDownload(
      "https://cdn.example.com/dash/static.mpd",
      undefined,
      async () => fixture("static.mpd"),
    );
    expect(plan.segments[0]).toContain("video/");
    expect(plan.segments.some((s) => s.includes("init.mp4"))).toBe(true);
  });

  it("refuses DRM manifests", async () => {
    await expect(
      resolveDashForDownload("https://cdn.example.com/dash/drm.mpd", undefined, async () =>
        fixture("drm.mpd"),
      ),
    ).rejects.toThrow(/Protected|ContentProtection/i);
  });
});
