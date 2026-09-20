import { describe, expect, it } from "vitest";
import {
  ADAPTERS,
  extractWithAdapters,
  isAdapterBlockedUrl,
  matchAdapters,
  type AdapterPage,
  type SiteAdapter,
} from "../src/lib/adapters";
import { adapterHost, adapterItem } from "../src/lib/adapters/types";
import { recommendVariant } from "../src/lib/download";
import { pickShortcutVideo } from "../src/lib/pickVideo";
import {
  looksLikeBlobPlayer,
  normalizeUrl,
  pickBestTabItem,
  pickCandidateItem,
  pickNewestByPath,
  type TargetItem,
} from "../src/lib/target";

function page(over: Partial<AdapterPage> = {}): AdapterPage {
  return {
    url: "https://example.com/watch/1",
    title: "Example",
    mediaUrls: [],
    ...over,
  };
}

describe("adapter item factory", () => {
  it("derives hls/dash types from the URL and marks unknown defensively", () => {
    expect(adapterItem("https://cdn.example.com/master.m3u8").type).toBe("hls");
    expect(adapterItem("https://cdn.example.com/manifest.mpd").type).toBe("dash");
    expect(adapterItem("https://cdn.example.com/clip.mp4").type).toBe("unknown");
  });

  it("preserves titles and uses the URL as a filename placeholder", () => {
    const item = adapterItem("https://cdn.example.com/clip.mp4", { title: "Big clip" });
    expect(item.title).toBe("Big clip");
    expect(item.filename).toBe("https://cdn.example.com/clip.mp4");
    expect(item.autoNamed).toBe(false);
    expect(item.tabId).toBe(-1);
    expect(item.detectedAt).toBe(0);
    expect(item.drmProtected).toBe(false);
  });

  it("flags DRM only when an adapter explicitly reports it", () => {
    expect(adapterItem("https://cdn.example.com/a.m3u8").drmProtected).toBe(false);
    expect(adapterItem("https://cdn.example.com/a.m3u8", { drmProtected: true }).drmProtected).toBe(true);
  });

  it("parses hosts defensively for match predicates", () => {
    expect(adapterHost("https://Sub.Example.com/watch")).toBe("sub.example.com");
    expect(adapterHost("not a url")).toBe("");
  });
});

describe("adapter registry", () => {
  it("ships no adapters by default but is a working registry", () => {
    expect(Array.isArray(ADAPTERS)).toBe(true);
    expect(matchAdapters("https://example.com/watch")).toEqual([]);
    expect(extractWithAdapters(page())).toEqual([]);
  });

  it("never matches YouTube, in any form", () => {
    for (const url of [
      "https://youtube.com/watch?v=1",
      "https://www.youtube.com/watch?v=1",
      "https://youtu.be/abc",
      "https://youtube-nocookie.com/embed/x",
      "https://googlevideo.com/videoplayback",
    ]) {
      expect(isAdapterBlockedUrl(url)).toBe(true);
      expect(matchAdapters(url)).toEqual([]);
      expect(extractWithAdapters(page({ url }))).toEqual([]);
    }
  });

  it("rejects malformed page urls without throwing", () => {
    expect(matchAdapters("not a url")).toEqual([]);
    expect(matchAdapters("")).toEqual([]);
  });
});

describe("extractWithAdapters with a stub adapter", () => {
  const stub: SiteAdapter = {
    id: "stub",
    match: (url) => adapterHost(url) === "example.com" || adapterHost(url).endsWith(".example.com"),
    extract: () => [
      adapterItem("https://cdn.example.com/a.m3u8"),
      adapterItem("https://cdn.example.com/a.m3u8"), // duplicate -> deduped
      adapterItem("https://cdn.example.com/b.mp4", { title: "B" }),
      adapterItem(""),
      adapterItem("https://youtube.com/oops.m3u8"), // blocked host -> dropped
    ],
  };

  it("matches only pages accepted by the adapter's match predicate", () => {
    ADAPTERS.push(stub);
    try {
      expect(matchAdapters("https://www.example.com/x")).toHaveLength(1);
      expect(matchAdapters("https://other.com/x")).toHaveLength(0);
    } finally {
      ADAPTERS.pop();
    }
  });

  it("returns complete media items, deduped and YouTube-filtered", () => {
    ADAPTERS.push(stub);
    try {
      const out = extractWithAdapters(page());
      expect(out.map((item) => item.url)).toEqual([
        "https://cdn.example.com/a.m3u8",
        "https://cdn.example.com/b.mp4",
      ]);
      expect(out[0].type).toBe("hls");
      expect(out[1].title).toBe("B");
    } finally {
      ADAPTERS.pop();
    }
  });

  it("isolates a throwing adapter", () => {
    const boom: SiteAdapter = {
      id: "boom",
      match: () => true,
      extract: () => {
        throw new Error("adapter bug");
      },
    };
    ADAPTERS.push(boom, stub);
    try {
      // The broken adapter is skipped; the healthy one still contributes.
      expect(extractWithAdapters(page()).length).toBe(2);
    } finally {
      ADAPTERS.pop();
      ADAPTERS.pop();
    }
  });
});

describe("recommendVariant", () => {
  const variants = [
    { id: "v-1080", bandwidth: 5_000_000 },
    { id: "v-720", bandwidth: 2_500_000 },
    { id: "v-360", bandwidth: 800_000 },
  ];

  it("recommends the highest quality that fits measured throughput", () => {
    // 2 MB/s = 16 Mbps -> minus 30% headroom = 11.2 Mbps -> 1080p (5 Mbps) fits.
    expect(recommendVariant(variants, 2_000_000)).toBe("v-1080");
    // 400 KB/s = 3.2 Mbps -> budget 2.24 Mbps -> 720p (2.5) doesn't fit; 360p does.
    expect(recommendVariant(variants, 400_000)).toBe("v-360");
  });

  it("falls back to the lowest quality when nothing fits", () => {
    expect(recommendVariant(variants, 1)).toBe("v-360");
  });

  it("returns undefined without enough information", () => {
    expect(recommendVariant(variants, 0)).toBeUndefined();
    expect(recommendVariant(variants, Number.NaN)).toBeUndefined();
    // Fewer than two rated variants: nothing to choose between.
    expect(recommendVariant([{ id: "only", bandwidth: 1_000 }], 1_000_000)).toBeUndefined();
    expect(recommendVariant([{ id: "a" }, { id: "b" }], 1_000_000)).toBeUndefined();
  });

  it("honours a custom utilization factor", () => {
    // 1 MB/s = 8 Mbps; willing to use all of it -> the 1080p variant (5 Mbps) fits.
    expect(recommendVariant(variants, 1_000_000, 1)).toBe("v-1080");
    // Only 10% usable (0.8 Mbps) -> nothing fits -> lowest quality.
    expect(recommendVariant(variants, 1_000_000, 0.1)).toBe("v-360");
    // Out-of-range factors are clamped, never crashing or inverting the pick.
    expect(recommendVariant(variants, 1_000_000, 5)).toBe("v-1080");
    expect(recommendVariant(variants, 1_000_000, -1)).toBe("v-360");
  });
});

describe("pickShortcutVideo", () => {
  it("returns -1 for an empty page", () => {
    expect(pickShortcutVideo([])).toBe(-1);
  });

  it("prefers a playing video over larger paused ones", () => {
    expect(
      pickShortcutVideo([
        { playing: false, area: 10_000, hasSource: true }, // big paused player
        { playing: true, area: 100, hasSource: true }, // small playing preview
      ]),
    ).toBe(1);
  });

  it("breaks ties by rendered area", () => {
    expect(
      pickShortcutVideo([
        { playing: false, area: 900, hasSource: true },
        { playing: false, area: 100_000, hasSource: true },
      ]),
    ).toBe(1);
  });

  it("prefers a sourced video over a source-less one of equal state", () => {
    expect(
      pickShortcutVideo([
        { playing: false, area: 5_000, hasSource: false },
        { playing: false, area: 5_000, hasSource: true },
      ]),
    ).toBe(1);
  });

  it("falls back to the first entry when everything ties", () => {
    expect(
      pickShortcutVideo([
        { playing: false, area: 0, hasSource: false },
        { playing: false, area: 0, hasSource: false },
      ]),
    ).toBe(0);
  });
});

describe("normalizeUrl", () => {
  it("strips query, hash, and host case", () => {
    expect(normalizeUrl("https://CDN.Example.com/a/b.m3u8?sig=1&t=2#frag")).toBe(
      "https://cdn.example.com/a/b.m3u8",
    );
    expect(normalizeUrl("https://cdn.example.com/a/b.m3u8")).toBe(
      normalizeUrl("https://cdn.example.com/a/b.m3u8?other=9"),
    );
  });

  it("returns unparseable input unchanged instead of throwing", () => {
    expect(normalizeUrl("blob:https://x/abc")).toBe("blob:https://x/abc");
    expect(normalizeUrl("")).toBe("");
  });
});

describe("pickCandidateItem", () => {
  const items: TargetItem[] = [
    { url: "https://cdn.example.com/other.mp4", type: "mp4", detectedAt: 1 },
    { url: "https://cdn.example.com/v/master.m3u8?sig=old", type: "hls", detectedAt: 2 },
    { url: "capture:ms1:0", type: "capture", detectedAt: 3 },
  ];

  it("matches by exact URL first", () => {
    expect(pickCandidateItem(items, ["https://cdn.example.com/other.mp4"])?.url).toBe(
      "https://cdn.example.com/other.mp4",
    );
  });

  it("matches ignoring query strings (signed URLs drift)", () => {
    const hit = pickCandidateItem(items, ["https://cdn.example.com/v/master.m3u8?sig=new"]);
    expect(hit?.url).toBe("https://cdn.example.com/v/master.m3u8?sig=old");
  });

  it("honours candidate order (best candidate wins)", () => {
    const hit = pickCandidateItem(items, [
      "https://unknown.example.com/x.mp4",
      "https://cdn.example.com/other.mp4",
    ]);
    expect(hit?.url).toBe("https://cdn.example.com/other.mp4");
  });

  it("returns a DRM match so the real reason surfaces", () => {
    const drm: TargetItem[] = [
      { url: "https://cdn.example.com/drm.mpd", type: "dash", detectedAt: 1, drmProtected: true },
    ];
    expect(pickCandidateItem(drm, ["https://cdn.example.com/drm.mpd"])?.drmProtected).toBe(true);
  });

  it("returns undefined when nothing matches", () => {
    expect(pickCandidateItem(items, ["https://nope.example.com/a.mp4"])).toBeUndefined();
    expect(pickCandidateItem(items, [])).toBeUndefined();
    expect(pickCandidateItem([], ["https://x/y.mp4"])).toBeUndefined();
  });
});

describe("pickNewestByPath", () => {
  it("returns the most recently detected item that shares origin+path", () => {
    const items: TargetItem[] = [
      { url: "https://ev.phncdn.com/hls/a/master.m3u8?token=old", type: "hls", detectedAt: 10 },
      { url: "https://ev.phncdn.com/hls/a/master.m3u8?token=new", type: "hls", detectedAt: 50 },
      { url: "https://ev.phncdn.com/hls/b/master.m3u8?token=other", type: "hls", detectedAt: 99 },
    ];
    expect(
      pickNewestByPath(items, "https://ev.phncdn.com/hls/a/master.m3u8?token=stale")?.url,
    ).toBe("https://ev.phncdn.com/hls/a/master.m3u8?token=new");
  });

  it("returns undefined when no path matches", () => {
    expect(
      pickNewestByPath(
        [{ url: "https://cdn.example.com/x.m3u8", type: "hls", detectedAt: 1 }],
        "https://cdn.example.com/y.m3u8",
      ),
    ).toBeUndefined();
  });
});

describe("looksLikeBlobPlayer", () => {
  it("detects MediaSource players", () => {
    expect(looksLikeBlobPlayer(["blob:https://site/abc-123"])).toBe(true);
    expect(looksLikeBlobPlayer(["https://cdn/x.mp4", "blob:https://site/abc"])).toBe(true);
  });

  it("is false for plain file players", () => {
    expect(looksLikeBlobPlayer(["https://cdn/x.mp4"])).toBe(false);
    expect(looksLikeBlobPlayer([])).toBe(false);
  });
});

describe("pickBestTabItem", () => {
  it("prefers unprotected items over protected ones", () => {
    const items: TargetItem[] = [
      { url: "https://a/drm.mpd", type: "dash", detectedAt: 9, drmProtected: true },
      { url: "https://a/plain.mp4", type: "mp4", detectedAt: 1 },
    ];
    expect(pickBestTabItem(items)?.url).toBe("https://a/plain.mp4");
  });

  it("prefers real files and manifests over captured buffers", () => {
    const items: TargetItem[] = [
      { url: "capture:ms1:0", type: "capture", detectedAt: 9 },
      { url: "https://a/master.m3u8", type: "hls", detectedAt: 1 },
    ];
    expect(pickBestTabItem(items)?.url).toBe("https://a/master.m3u8");
  });

  it("breaks ties by newest detection", () => {
    const items: TargetItem[] = [
      { url: "https://a/old.mp4", type: "mp4", detectedAt: 1 },
      { url: "https://a/new.mp4", type: "mp4", detectedAt: 5 },
    ];
    expect(pickBestTabItem(items)?.url).toBe("https://a/new.mp4");
  });

  it("ignores undownloadable types and empties", () => {
    expect(
      pickBestTabItem([
        { url: "blob:https://a/x", type: "blob", detectedAt: 1 },
        { url: "https://a/y", type: "unknown", detectedAt: 2 },
      ]),
    ).toBeUndefined();
    expect(pickBestTabItem([])).toBeUndefined();
  });
});
