import { describe, expect, it } from "vitest";
import {
  basenameOf,
  dirOf,
  hostOf,
  joinDownloadPath,
  qualityLabel,
  renderFilename,
  sanitizeSubfolder,
  withExtPreservingDir,
} from "../src/lib/filename";

describe("qualityLabel", () => {
  it("derives a height label from a resolution or explicit height", () => {
    expect(qualityLabel({ resolution: "1920x1080" })).toBe("1080p");
    expect(qualityLabel({ resolution: "1280X720" })).toBe("720p");
    expect(qualityLabel({ height: 2160 })).toBe("2160p");
  });

  it("returns empty when nothing is known", () => {
    expect(qualityLabel(undefined)).toBe("");
    expect(qualityLabel({})).toBe("");
  });
});

describe("renderFilename", () => {
  it("fills title and quality placeholders and guarantees an extension", () => {
    expect(renderFilename("{title} [{quality}]", { title: "My Clip", quality: "1080p", ext: "mp4" }, "fb")).toBe(
      "My Clip [1080p].mp4",
    );
  });

  it("collapses empty bracket groups instead of leaving '[]'", () => {
    expect(renderFilename("{title} [{quality}]", { title: "My Clip", ext: "mp4" }, "fb")).toBe("My Clip.mp4");
  });

  it("keeps an explicit extension from the template", () => {
    expect(renderFilename("{title}.{ext}", { title: "My Clip", ext: "webm" }, "fb")).toBe("My Clip.webm");
  });

  it("drops unknown placeholders and falls back to the title", () => {
    expect(renderFilename("{nope}", { title: "My Clip", ext: "mp4" }, "fb")).toBe("My Clip.mp4");
  });

  it("falls back to the provided stem when no title is usable", () => {
    expect(renderFilename("{title} [{quality}]", { ext: "mp4" }, "clip-from-url")).toBe("clip-from-url.mp4");
    expect(renderFilename("{title}", {}, "")).toBe("video.mp4");
  });

  it("supports {host}, {type} and {date}", () => {
    const name = renderFilename(
      "{host}-{type}-{date}",
      { ext: "mp4", host: "https://cdn.example.com/v.mp4", type: "hls", date: new Date("2026-09-19T00:00:00Z") },
      "fb",
    );
    expect(name).toBe("cdn.example.com-hls-2026-09-19.mp4");
  });

  it("sanitizes filesystem-illegal characters and never leaks a path separator", () => {
    const name = renderFilename("{title}", { title: 'a/b:c*"d', ext: "mp4" }, "fb");
    expect(name).not.toMatch(/[/:*"?]/);
    expect(name.endsWith(".mp4")).toBe(true);
  });

  it("collapses whitespace and trims separators", () => {
    expect(renderFilename("  {title}  -  ", { title: "Hello  World", ext: "mp4" }, "fb")).toBe("Hello World.mp4");
  });
});

describe("sanitizeSubfolder / joinDownloadPath", () => {
  it("normalizes separators and drops traversal segments", () => {
    expect(sanitizeSubfolder("Videos/down-stream/")).toBe("Videos/down-stream");
    expect(sanitizeSubfolder("Videos\\down")).toBe("Videos/down");
    expect(sanitizeSubfolder("../../etc")).toBe("etc");
    expect(sanitizeSubfolder("a/./b")).toBe("a/b");
    expect(sanitizeSubfolder("")).toBe("");
  });

  it("joins a basename under the subfolder, and returns it bare without one", () => {
    expect(joinDownloadPath("Videos/x", "clip.mp4")).toBe("Videos/x/clip.mp4");
    expect(joinDownloadPath("", "clip.mp4")).toBe("clip.mp4");
    // A filename that already carries a path contributes only its basename.
    expect(joinDownloadPath("Videos/x", "Other/clip.mp4")).toBe("Videos/x/clip.mp4");
  });
});

describe("path helpers", () => {
  it("splits a relative path into directory and basename", () => {
    expect(basenameOf("Videos/x/clip.mp4")).toBe("clip.mp4");
    expect(basenameOf("clip.mp4")).toBe("clip.mp4");
    expect(dirOf("Videos/x/clip.mp4")).toBe("Videos/x");
    expect(dirOf("clip.mp4")).toBe("");
  });

  it("swaps the extension while keeping the directory", () => {
    expect(withExtPreservingDir("Videos/x/clip.ts", ".mp4")).toBe("Videos/x/clip.mp4");
    expect(withExtPreservingDir("Videos/x/clip", "mp4")).toBe("Videos/x/clip.mp4");
    expect(withExtPreservingDir("clip.ts", ".mp4")).toBe("clip.mp4");
  });

  it("extracts a host safely", () => {
    expect(hostOf("https://cdn.example.com/a/b.mp4")).toBe("cdn.example.com");
    expect(hostOf("not a url")).toBe("");
    expect(hostOf(undefined)).toBe("");
  });
});
