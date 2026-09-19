import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCaptureSessions, handleVideoSignals } from "../src/bg/signals";
import { memoryStore } from "../src/bg/store";
import type { BlobFileInfo, MediaItem, VideoSignal } from "../src/lib/types";

const BLOB_URL = "blob:https://www.instagram.com/reel-1";

function video(over: Partial<VideoSignal> = {}): VideoSignal {
  return {
    currentSrc: BLOB_URL,
    candidates: [BLOB_URL],
    title: "A reel",
    width: 720,
    height: 1280,
    paused: false,
    ...over,
  };
}

function backing(over: Partial<BlobFileInfo> = {}): BlobFileInfo {
  return { url: BLOB_URL, size: 2_400_000, type: "video/mp4", ...over };
}

beforeEach(() => {
  memoryStore.clear();
  vi.stubGlobal("chrome", {
    storage: {
      session: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => undefined),
      },
    },
    action: {
      setBadgeText: vi.fn(async () => undefined),
      setBadgeBackgroundColor: vi.fn(async () => undefined),
    },
  });
});

afterEach(() => {
  memoryStore.clear();
  vi.unstubAllGlobals();
});

describe("handleVideoSignals blob players", () => {
  it("explains a blob: player when no bytes have been captured yet", async () => {
    await handleVideoSignals(7, [video()], "Instagram");
    const items = memoryStore.get(7) ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("blob");
    expect(items[0].error).toMatch(/Blob\/MSE stream/i);
  });

  it("turns that placeholder into a downloadable blobfile once the page Blob is known", async () => {
    await handleVideoSignals(7, [video()], "Instagram");
    await handleVideoSignals(7, [video()], "Instagram", 0, [backing()]);
    const items = memoryStore.get(7) ?? [];
    expect(items).toHaveLength(1);
    expect(items[0].type).toBe("blobfile");
    expect(items[0].error).toBeUndefined();
    expect(items[0].filename).toMatch(/\.mp4$/);
    expect(items[0].meta).toMatch(/direct file/i);
  });

  it("creates a blobfile immediately when the backing Blob is already listed", async () => {
    await handleVideoSignals(7, [video()], "Instagram", 0, [backing()]);
    const items = memoryStore.get(7) ?? [];
    expect(items.map((i) => i.type)).toEqual(["blobfile"]);
  });
});

describe("handleCaptureSessions vs blob placeholders", () => {
  it("drops the blob error row once MSE capture bytes exist for that player", async () => {
    await handleVideoSignals(7, [video()], "Instagram");
    await handleCaptureSessions(
      7,
      [
        {
          id: "ms-1",
          blobUrl: BLOB_URL,
          tracks: [{ idx: 0, mime: "video/mp4", kind: "video", bytes: 800_000, chunks: 4 }],
          bytes: 800_000,
          complete: true,
          eme: false,
          pageEme: false,
        },
      ],
      new Map(),
      new Map(),
      "Instagram",
    );
    const items = memoryStore.get(7) ?? [];
    expect(items.some((i: MediaItem) => i.type === "blob")).toBe(false);
    expect(items.some((i: MediaItem) => i.type === "capture" && !i.drmProtected)).toBe(true);
  });
});
