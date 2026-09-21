import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseHlsManifest, parseHlsMediaPlaylist } from "../src/lib/parseHls";
import { parseDashManifest } from "../src/lib/parseDash";

const FIXTURES = join(__dirname, "fixtures");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

const HLS_URL = "https://cdn.example.com/live/stream.m3u8";
const MPD_URL = "https://cdn.example.com/live/manifest.mpd";

describe("parseHlsManifest — live detection", () => {
  it("flags a media playlist without #EXT-X-ENDLIST as live", () => {
    const result = parseHlsManifest(fixture("media-live.m3u8"), HLS_URL);
    expect(result.isMaster).toBe(false);
    expect(result.isLive).toBe(true);
    expect(result.targetDurationSec).toBe(4);
    expect(result.drmProtected).toBe(false);
  });

  it("flags PLAYLIST-TYPE:EVENT as live even with an end list", () => {
    const text = `${fixture("media-ts.m3u8").replace("#EXT-X-PLAYLIST-TYPE:VOD", "#EXT-X-PLAYLIST-TYPE:EVENT")}`;
    expect(parseHlsManifest(text, HLS_URL).isLive).toBe(true);
  });

  it("does not flag a closed VOD playlist", () => {
    const result = parseHlsManifest(fixture("media-ts.m3u8"), HLS_URL);
    expect(result.isLive).toBe(false);
  });

  it("does not flag a master playlist (variants carry liveness)", () => {
    const result = parseHlsManifest(fixture("master.m3u8"), HLS_URL);
    expect(result.isMaster).toBe(true);
    expect(result.isLive).toBeUndefined();
  });
});

describe("parseHlsMediaPlaylist — live recording view", () => {
  it("pairs each segment with its media-sequence number", () => {
    const info = parseHlsMediaPlaylist(fixture("media-live.m3u8"), HLS_URL);
    expect(info.endList).toBe(false);
    expect(info.targetDurationSec).toBe(4);
    expect(info.entries.map((e) => e.seq)).toEqual([1024, 1025, 1026]);
    expect(info.entries[0].url).toBe("https://cdn.example.com/live/chunk-1024.ts");
  });

  it("detects a closed playlist and the fMP4 init URL", () => {
    const closed = `${fixture("media-live-fmp4.m3u8")}#EXT-X-ENDLIST\n`;
    const info = parseHlsMediaPlaylist(closed, HLS_URL);
    expect(info.endList).toBe(true);
    expect(info.initUrl).toBe("https://cdn.example.com/live/init.mp4");
    expect(info.entries.map((e) => e.seq)).toEqual([40, 41]);
  });

  it("defaults the sequence base to 0 when the tag is absent", () => {
    const text = fixture("media-live.m3u8").replace(/#EXT-X-MEDIA-SEQUENCE:\d+\r?\n/, "");
    const info = parseHlsMediaPlaylist(text, HLS_URL);
    expect(info.entries.map((e) => e.seq)).toEqual([0, 1, 2]);
  });
});

describe("parseDashManifest — live detection", () => {
  it("flags type=\"dynamic\" MPDs as live with their update period", () => {
    const result = parseDashManifest(fixture("live.mpd"), MPD_URL);
    expect(result.isLive).toBe(true);
    expect(result.minUpdatePeriodSec).toBe(2);
    expect(result.drmProtected).toBe(false);
    expect(result.variants.length).toBeGreaterThan(0);
  });

  it("lists the init segment first for a live video representation", () => {
    const result = parseDashManifest(fixture("live.mpd"), MPD_URL);
    const video = result.variants.find((v) => v.codecs?.includes("avc1"));
    expect(video?.segments?.[0]).toContain("init-v.mp4");
    expect(video?.segments?.some((s) => s.includes("chunk-v"))).toBe(true);
  });

  it("does not flag a static MPD", () => {
    const result = parseDashManifest(fixture("static.mpd"), MPD_URL);
    expect(result.isLive).toBe(false);
  });

  it("parses ISO-8601 update periods", () => {
    const xml = fixture("live.mpd").replace('minimumUpdatePeriod="PT2S"', 'minimumUpdatePeriod="PT1M30S"');
    expect(parseDashManifest(xml, MPD_URL).minUpdatePeriodSec).toBe(90);
  });
});
