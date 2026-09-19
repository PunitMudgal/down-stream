import { describe, expect, it } from "vitest";
import { classify, looksLikeChunk } from "../src/lib/classify";

describe("looksLikeChunk (conservative chunk scoring)", () => {
  it("keeps real files with digit path tokens as videos", () => {
    // Two digit tokens = score 2 < threshold 3.
    expect(looksLikeChunk("https://cdn.example.com/2024/01/clip.mp4")).toBe(false);
    expect(looksLikeChunk("https://cdn.example.com/media/12345/video.mp4")).toBe(false);
  });

  it("flags fMP4 codec/dimension directory layouts", () => {
    expect(
      looksLikeChunk("https://cdn.example.com/avc1/0/0/1440x1440/x.mp4"),
    ).toBe(true);
  });

  it("flags raw stream fragment extensions regardless of the rest", () => {
    expect(looksLikeChunk("https://cdn.example.com/hls/1.ts")).toBe(true);
    expect(looksLikeChunk("https://cdn.example.com/dash/seg1.m4s")).toBe(true);
    expect(looksLikeChunk("https://cdn.example.com/dash/x.cmfv")).toBe(true);
    expect(looksLikeChunk("https://cdn.example.com/dash/x.cmfa")).toBe(true);
  });

  it("flags keyword numbering once it stacks with another signal", () => {
    // A bare keyword (score 2) stays below the conservative threshold 3 —
    // "seg-12.mp4" alone can be a real named file.
    expect(looksLikeChunk("https://cdn.example.com/seg-12.mp4")).toBe(false);
    // Keyword + codec directory = 4 -> chunk.
    expect(looksLikeChunk("https://cdn.example.com/avc1/seg-12.mp4")).toBe(true);
    // Keyword extension .m4v + keyword token = chunk via the backup rule.
    expect(looksLikeChunk("https://cdn.example.com/chunk_3.m4v")).toBe(true);
    // keyword + one digit token = 2+1 -> still < 3 (threshold is 3, so 3 is
    // actually a chunk — the digit token caps at min(2, digits)=1 here).
    expect(looksLikeChunk("https://cdn.example.com/seg-12/1.mp4")).toBe(true);
  });

  it("treats .m4v as chunk only with a backup signal", () => {
    // Bare .m4v: no score -> keep.
    expect(looksLikeChunk("https://cdn.example.com/movie.m4v")).toBe(false);
    // One digit token (1) + .m4v -> score 1 < 2: keep.
    expect(looksLikeChunk("https://cdn.example.com/1/movie.m4v")).toBe(false);
    // Codec dir + .m4v -> score 2: chunk.
    expect(looksLikeChunk("https://cdn.example.com/avc1/movie.m4v")).toBe(true);
  });

  it("ignores query strings when scoring", () => {
    // The pathname is what scores; signed params must not tip it either way.
    expect(looksLikeChunk("https://cdn.example.com/2024/01/clip.mp4?token=abc123")).toBe(false);
    expect(looksLikeChunk("https://cdn.example.com/seg-7.ts?Signature=zz")).toBe(true);
  });

  it("returns false for unparseable URLs", () => {
    expect(looksLikeChunk("not a url")).toBe(false);
  });
});

describe("classify (URL + content-type -> media type)", () => {
  it("detects HLS by extension and content-type", () => {
    expect(classify("https://cdn.example.com/live/master.m3u8", "")).toBe("hls");
    expect(classify("https://cdn.example.com/live/playlist", "application/vnd.apple.mpegurl")).toBe("hls");
    expect(classify("https://cdn.example.com/live/playlist", "application/x-mpegurl; charset=utf-8")).toBe("hls");
  });

  it("detects DASH by extension, content-type, and Smooth Streaming manifests", () => {
    expect(classify("https://cdn.example.com/video.mpd", "")).toBe("dash");
    expect(classify("https://cdn.example.com/video", "application/dash+xml")).toBe("dash");
    expect(classify("https://cdn.example.com/video.ism/manifest", "")).toBe("dash");
    expect(classify("https://cdn.example.com/video.ism/manifest(format=mpd-time-csf)", "")).toBe("dash");
  });

  it("maps Instagram CDN videos that have no file extension", () => {
    expect(
      classify(
        "https://scontent-lga3-1.cdninstagram.com/o1/v/t16/f2/m86/AQNcliphash?_nc_cat=111",
        "",
      ),
    ).toBe("mp4");
    expect(
      classify("https://scontent.cdninstagram.com/v/t51.2885-15/123_n.jpg", ""),
    ).toBeNull();
  });

  it("maps direct video types by content-type", () => {
    expect(classify("https://x.example.com/v", "video/mp4")).toBe("mp4");
    expect(classify("https://x.example.com/v", "video/webm")).toBe("webm");
    expect(classify("https://x.example.com/v", "video/quicktime")).toBe("mov");
    expect(classify("https://x.example.com/v", "video/x-matroska")).toBe("mkv");
    expect(classify("https://x.example.com/v", "video/x-msvideo")).toBe("avi");
    expect(classify("https://x.example.com/v", "video/mpeg")).toBe("mpg");
  });

  it("maps direct video by extension when content-type is empty", () => {
    expect(classify("https://x.example.com/a/b/clip.mp4", "")).toBe("mp4");
    expect(classify("https://x.example.com/a/b/clip.webm", "")).toBe("webm");
    expect(classify("https://x.example.com/a/b/clip.ogv", "")).toBe("ogg");
    expect(classify("https://x.example.com/a/b/clip.mov", "")).toBe("mov");
    expect(classify("https://x.example.com/a/b/clip.mkv", "")).toBe("mkv");
    expect(classify("https://x.example.com/a/b/clip.3gp", "")).toBe("mp4");
  });

  it("never classifies segment content as an item", () => {
    // video/mp2t is a chunk type even when the extension is mp4-ish.
    expect(classify("https://x.example.com/seg-1.m4s", "video/mp4")).toBeNull();
    expect(classify("https://x.example.com/seg-1.ts", "video/mp2t")).toBeNull();
  });

  it("returns null for non-video URLs", () => {
    expect(classify("https://x.example.com/page.html", "text/html")).toBeNull();
    expect(classify("https://x.example.com/data.json", "application/json")).toBeNull();
    expect(classify("https://x.example.com/img.png", "image/png")).toBeNull();
  });

  it("strips query/hash before extension checks", () => {
    expect(classify("https://x.example.com/clip.mp4?sig=1#t=10", "")).toBe("mp4");
  });
});
