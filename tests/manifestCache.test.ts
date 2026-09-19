import { describe, expect, it } from "vitest";
import {
  MANIFEST_CACHE_TTL_MS,
  ManifestCache,
  manifestCacheKey,
  manifestFailureMessage,
} from "../src/lib/manifestCache";

const MASTER = "https://cdn.example.com/hls/a1b2/master.m3u8?token=abc&expires=1";

describe("manifestCacheKey", () => {
  it("drops the query so rotated tokens share one key", () => {
    expect(manifestCacheKey(MASTER)).toBe("https://cdn.example.com/hls/a1b2/master.m3u8");
    expect(manifestCacheKey("https://cdn.example.com/hls/a1b2/master.m3u8?token=zzz")).toBe(
      manifestCacheKey(MASTER),
    );
  });

  it("falls back to the raw string for unparsable URLs", () => {
    expect(manifestCacheKey("not a url")).toBe("not a url");
  });
});

describe("ManifestCache", () => {
  it("stores and returns text by exact URL", () => {
    const c = new ManifestCache();
    c.set(MASTER, "#EXTM3U");
    expect(c.get(MASTER)).toBe("#EXTM3U");
  });

  it("hits a rotated-token URL through the path alias", () => {
    const c = new ManifestCache();
    c.set(MASTER, "#EXTM3U");
    expect(c.get("https://cdn.example.com/hls/a1b2/master.m3u8?token=QQQ")).toBe("#EXTM3U");
  });

  it("refuses the path alias once that path served more than one URL", () => {
    const c = new ManifestCache();
    c.set("https://cdn/hls/stream.m3u8?token=A", "#A");
    c.set("https://cdn/hls/stream.m3u8?token=B", "#B");
    // A third token must not be handed either video's playlist.
    expect(c.get("https://cdn/hls/stream.m3u8?token=C")).toBeUndefined();
    expect(c.get("https://cdn/hls/stream.m3u8?token=A")).toBe("#A");
    expect(c.get("https://cdn/hls/stream.m3u8?token=B")).toBe("#B");
  });

  it("misses a different path on the same host", () => {
    const c = new ManifestCache();
    c.set(MASTER, "#EXTM3U");
    expect(c.get("https://cdn.example.com/hls/zzzz/master.m3u8?token=abc")).toBeUndefined();
  });

  it("expires entries past the TTL and forgets them", () => {
    const c = new ManifestCache(8, 1000);
    c.set(MASTER, "#EXTM3U", 0);
    expect(c.get(MASTER, 999)).toBe("#EXTM3U");
    expect(c.get(MASTER, 1001)).toBeUndefined();
    expect(c.get(MASTER, MANIFEST_CACHE_TTL_MS)).toBeUndefined();
  });

  it("evicts the least-recently-written entries at the cap", () => {
    const c = new ManifestCache(2, 10_000);
    c.set("https://h/a.m3u8", "A");
    c.set("https://h/b.m3u8", "B");
    c.set("https://h/c.m3u8", "C");
    expect(c.get("https://h/a.m3u8")).toBeUndefined(); // oldest written, evicted
    expect(c.get("https://h/b.m3u8")).toBe("B");
    expect(c.get("https://h/c.m3u8")).toBe("C");
  });

  it("refreshes recency on rewrite and drops on demand", () => {
    const c = new ManifestCache(3, 10_000);
    c.set("https://h/a.m3u8", "A");
    c.set("https://h/b.m3u8", "B");
    c.set("https://h/a.m3u8", "A2"); // a write moves it to the newest slot
    c.set("https://h/c.m3u8", "C");
    expect(c.get("https://h/a.m3u8")).toBe("A2");
    c.drop("https://h/a.m3u8");
    expect(c.get("https://h/a.m3u8")).toBeUndefined();
  });

  it("ignores empty text (a blank read is never cached)", () => {
    const c = new ManifestCache();
    c.set(MASTER, "");
    expect(c.size).toBe(0);
  });
});

describe("manifestFailureMessage", () => {
  it("names both layers with their status codes", () => {
    const msg = manifestFailureMessage({ status: 404 }, { reason: "Page fetch failed (404)" });
    expect(msg).toContain("extension: 404");
    expect(msg).toContain("page: 404");
    expect(msg).toContain("Retry");
  });

  it("distinguishes transport failures from statuses", () => {
    expect(manifestFailureMessage({ network: true, reason: "Failed to fetch" }, undefined)).toContain(
      "extension: unreachable",
    );
    expect(
      manifestFailureMessage({ status: 403 }, { reason: "Page fetch timed out" }),
    ).toContain("page: timed out");
    expect(
      manifestFailureMessage(undefined, { reason: "Manifest too large to parse (>5 MB)." }),
    ).toContain("page: too large");
  });

  it("still gives one actionable sentence when nothing was recorded", () => {
    const msg = manifestFailureMessage(undefined, undefined);
    expect(msg).toMatch(/Couldn't read the stream list\./);
    expect(msg).toContain("Retry");
  });
});
