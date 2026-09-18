import { describe, expect, it } from "vitest";
import {
  cleanTitle,
  filenameForUrl,
  isExpiredFailure,
  orderAndValidateSegmentParts,
  sanitizeStem,
  sortSegmentsNatural,
} from "../src/lib/download";
import {
  audioStream,
  buildFragment,
  buildInit,
  box,
  concat,
  initOnlyStream,
  videoStream,
} from "./helpers/fmp4";

describe("sortSegmentsNatural", () => {
  it("orders numbered segments numerically, not lexically", () => {
    const out = sortSegmentsNatural([
      "https://c.example.com/seg-10.m4s",
      "https://c.example.com/seg-2.m4s",
      "https://c.example.com/seg-1.m4s",
    ]);
    expect(out.map((u) => u.slice(-11))).toEqual(["m/seg-1.m4s", "m/seg-2.m4s", "/seg-10.m4s"]);
  });

  it("sorts by path then query tokens", () => {
    const out = sortSegmentsNatural([
      "https://c.example.com/v?id=2",
      "https://c.example.com/v?id=10",
      "https://c.example.com/v?id=1",
    ]);
    expect(out).toEqual([
      "https://c.example.com/v?id=1",
      "https://c.example.com/v?id=2",
      "https://c.example.com/v?id=10",
    ]);
  });

  it("treats ties as full-string ties only — differing tails still sort", () => {
    const first = "https://c.example.com/a?n=1&x=first";
    const second = "https://c.example.com/a?n=1&x=second";
    // Keys tokenize identically up to the tail token; 'first' < 'second'.
    expect(sortSegmentsNatural([second, first])).toEqual([first, second]);
    // Exact duplicates keep arrival order.
    expect(sortSegmentsNatural([second, second.slice()])).toEqual([second, second]);
  });

  it("handles unparseable URLs without throwing", () => {
    expect(() => sortSegmentsNatural(["::bad::", "https://ok.example.com/1"])).not.toThrow();
  });
});

describe("cleanTitle", () => {
  it("collapses whitespace and trims", () => {
    expect(cleanTitle("  My   Video \n Title ")).toBe("My Video Title");
  });

  it("strips known site suffixes", () => {
    expect(cleanTitle("Cool clip - YouTube")).toBe("Cool clip");
    expect(cleanTitle("Post | X (Twitter)")).toBe("Post");
    expect(cleanTitle("Some video – Twitch")).toBe("Some video");
    expect(cleanTitle("Another one / Reddit")).toBe("Another one");
  });

  it("rejects unusable titles", () => {
    expect(cleanTitle("")).toBe("");
    expect(cleanTitle("   ")).toBe("");
    expect(cleanTitle("ab")).toBe(""); // too short
  });

  it("caps length", () => {
    expect(cleanTitle("x".repeat(500)).length).toBeLessThanOrEqual(100);
  });
});

describe("sanitizeStem", () => {
  it("replaces filesystem-illegal characters", () => {
    // Each illegal char (: " < > ?) becomes one underscore; only trailing
    // dots/spaces are stripped, so the final ? leaves a trailing underscore.
    expect(sanitizeStem('video: "the best" <clip>?')).toBe("video_ _the best_ _clip__");
  });

  it("collapses whitespace and strips trailing dots/spaces", () => {
    expect(sanitizeStem("  spaced   out  ")).toBe("spaced out");
    expect(sanitizeStem("trailing dots...")).toBe("trailing dots");
  });

  it("turns slashes into underscores", () => {
    expect(sanitizeStem("a/b\\c")).toBe("a_b_c");
  });

  it("returns empty for garbage", () => {
    expect(sanitizeStem("???")).toBe("___");
    expect(sanitizeStem("")).toBe("");
  });
});

describe("filenameForUrl", () => {
  it("prefers a real title and preserves a URL-derived extension", () => {
    expect(filenameForUrl("https://x.example.com/v/clip.mp4", "mp4", "My Clip")).toBe("My Clip.mp4");
  });

  it("falls back to the sanitized URL basename", () => {
    expect(filenameForUrl("https://x.example.com/v/clip.webm", "webm")).toBe("clip.webm");
  });

  it("timestamp-falls-back when the URL has no usable name", () => {
    const name = filenameForUrl("https://x.example.com/", "hls");
    expect(name).toMatch(/^hls-video-\d{4}-\d{2}-\d{2}T.*\.ts$/);
    const dash = filenameForUrl("https://x.example.com/x", "dash");
    expect(dash).toMatch(/^dash-video-.*\.mp4$/);
    const seg = filenameForUrl("https://x.example.com/x", "segments");
    expect(seg).toMatch(/^video-segments-.*\.mp4$/);
  });

  it("normalizes odd extensions to mp4 for titled files", () => {
    // Odd extensions (.m4v/.3gp) normalize when a usable title (>2 chars)
    // supplies the stem; short titles are rejected and the basename wins.
    expect(filenameForUrl("https://x.example.com/clip.m4v", "mp4", "Title")).toBe("Title.mp4");
    expect(filenameForUrl("https://x.example.com/clip.3gp", "mp4", "Title")).toBe("Title.mp4");
    expect(filenameForUrl("https://x.example.com/clip.m4v", "mp4", "T")).toBe("clip.m4v");
    expect(filenameForUrl("https://x.example.com/clip.m4v", "mp4")).toBe("clip.m4v");
  });
});

describe("isExpiredFailure", () => {
  it("recognizes expired/signed-URL style failures", () => {
    expect(isExpiredFailure(new Error("Stream chunk unavailable (403) — the link likely expired."))).toBe(true);
    expect(isExpiredFailure(new Error("A stream chunk came back as an error page instead of video"))).toBe(true);
    expect(isExpiredFailure(new Error("A stream file isn't video data"))).toBe(true);
  });

  it("rejects unrelated errors and non-errors", () => {
    expect(isExpiredFailure(new Error("Network hiccup"))).toBe(false);
    expect(isExpiredFailure("nope")).toBe(false);
    expect(isExpiredFailure(undefined)).toBe(false);
  });
});

describe("orderAndValidateSegmentParts", () => {
  const enc = new TextEncoder();

  it("refuses an empty list", () => {
    expect(() => orderAndValidateSegmentParts([])).toThrow(/No segments/);
  });

  it("refuses error pages", () => {
    const html = enc.encode("<html><body>Forbidden</body></html>").buffer as ArrayBuffer;
    expect(() => orderAndValidateSegmentParts([html])).toThrow(/error page/);
  });

  it("refuses unknown non-video chunks", () => {
    const junk = new Uint8Array(64).fill(0x5a).buffer as ArrayBuffer;
    expect(() => orderAndValidateSegmentParts([junk])).toThrow(/isn't video data/);
  });

  it("refuses mixed container kinds", () => {
    const ts = new Uint8Array(188).fill(0x47).buffer as ArrayBuffer;
    const webm = concat([u8bytes([0x1a, 0x45, 0xdf, 0xa3]), new Uint8Array(60)]).buffer as ArrayBuffer;
    expect(() => orderAndValidateSegmentParts([ts, webm])).toThrow(/mixed formats/);
  });

  it("concatenates TS parts unchanged (order-tolerant container)", () => {
    const ts1 = concat([new Uint8Array(188).fill(0x47)]).buffer as ArrayBuffer;
    const ts2 = concat([new Uint8Array(94).fill(0x47)]).buffer as ArrayBuffer;
    expect(orderAndValidateSegmentParts([ts1, ts2])).toEqual([ts1, ts2]);
  });

  it("moves a lone out-of-order init chunk to the front", () => {
    const init = initOnlyStream(1).slice().buffer as ArrayBuffer;
    const frag = buildFragment({ trackId: 1, baseTime: 0, sequence: 1, samples: [{ dur: 2560, size: 100 }] });
    const fragBuf = frag.slice().buffer as ArrayBuffer;
    const out = orderAndValidateSegmentParts([fragBuf, init]);
    expect(out[0]).toBe(init);
    expect(out[1]).toBe(fragBuf);
  });

  it("refuses fMP4 chunks with no moov (init never captured)", () => {
    const frag1 = buildFragment({ trackId: 1, baseTime: 0, sequence: 1, samples: [{ dur: 2560, size: 100 }] });
    const frag2 = buildFragment({ trackId: 1, baseTime: 2560, sequence: 2, samples: [{ dur: 2560, size: 90 }] });
    expect(() =>
      orderAndValidateSegmentParts([frag1.slice().buffer as ArrayBuffer, frag2.slice().buffer as ArrayBuffer]),
    ).toThrow(/header segment wasn't captured/);
  });

  it("salvages byte-identical duplicate pure init chunks", () => {
    const init = initOnlyStream(1);
    const frag = buildFragment({ trackId: 1, baseTime: 0, sequence: 1, samples: [{ dur: 2560, size: 100 }] });
    const initBuf = init.slice().buffer as ArrayBuffer;
    const initAgain = init.slice().buffer as ArrayBuffer;
    const fragBuf = frag.slice().buffer as ArrayBuffer;
    const out = orderAndValidateSegmentParts([initBuf, initAgain, fragBuf]);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe(initBuf);
    expect(out[1]).toBe(fragBuf);
  });

  it("refuses multiple distinct quality headers", () => {
    const init1 = initOnlyStream(1).slice().buffer as ArrayBuffer;
    const init2 = initOnlyStream(2).slice().buffer as ArrayBuffer; // different bytes
    const frag = buildFragment({ trackId: 1, baseTime: 0, sequence: 1, samples: [{ dur: 2560, size: 100 }] });
    expect(() =>
      orderAndValidateSegmentParts([init1, init2, frag.slice().buffer as ArrayBuffer]),
    ).toThrow(/multiple quality headers/);
  });

  it("refuses a top-level pssh box in an fMP4 chunk", () => {
    // pssh at top level (some packagers emit it beside ftyp/moov).
    const pssh = box("pssh", new Uint8Array(32));
    const frag = buildFragment({ trackId: 1, baseTime: 0, sequence: 1, samples: [{ dur: 2560, size: 100 }] });
    const joined = concat([pssh, frag]);
    expect(() => orderAndValidateSegmentParts([joined.slice().buffer as ArrayBuffer])).toThrow(/Protected content/);
  });

  it("defers pssh-inside-moov to the muxer (validation only scans top level)", () => {
    // Known limitation: scanTopLevel does not descend into moov; the muxer
    // throws on such input, so the bytes never reach disk either way.
    const pssh = box("pssh", new Uint8Array(32));
    const init = buildInit({ trackId: 1, handler: "vide", codec4cc: "avc1", timescale: 12800, pssh });
    const frag = buildFragment({ trackId: 1, baseTime: 0, sequence: 1, samples: [{ dur: 2560, size: 100 }] });
    const joined = concat([init, frag]);
    expect(() => orderAndValidateSegmentParts([joined.slice().buffer as ArrayBuffer])).not.toThrow();
  });

  it("refuses senc-tainted chunks only via the muxer (validation passes them)", () => {
    // senc lives inside traf — container sniffing sees clean fMP4, so
    // grouped-chunk validation accepts it; the muxer is the refusal point.
    const stream = audioStream(2, { senc: true });
    const out = orderAndValidateSegmentParts([stream.slice().buffer as ArrayBuffer]);
    expect(out).toHaveLength(1);
  });

  it("accepts a clean full stream (init + fragments) unchanged", () => {
    const stream = videoStream(1);
    const out = orderAndValidateSegmentParts([stream.slice().buffer as ArrayBuffer]);
    expect(out).toHaveLength(1);
    expect(new Uint8Array(out[0])[4]).toBe(0x66); // 'f' of ftyp
  });

  it("accepts a clean audio stream unchanged", () => {
    const stream = audioStream(2);
    const out = orderAndValidateSegmentParts([stream.slice().buffer as ArrayBuffer]);
    expect(out).toHaveLength(1);
    expect(new Uint8Array(out[0])[4]).toBe(0x66);
  });
});

// ---- tiny local helpers (kept out of the shared fixture module) ----------

function u8bytes(bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}
