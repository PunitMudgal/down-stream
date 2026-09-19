import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, normalizeSettings } from "../src/lib/settings";
import {
  appendHistory,
  clearHistory,
  entryFromJob,
  HISTORY_LIMIT,
  loadHistory,
  type HistoryEntry,
} from "../src/lib/history";
import type { DownloadJobState } from "../src/lib/types";

// In-memory chrome.storage.local stand-in (history is the only consumer here).
const storage = new Map<string, unknown>();
vi.stubGlobal("chrome", {
  storage: {
    local: {
      async get(key: string) {
        return storage.has(key) ? { [key]: storage.get(key) } : {};
      },
      async set(obj: Record<string, unknown>) {
        for (const [k, v] of Object.entries(obj)) storage.set(k, v);
      },
      async remove(key: string) {
        storage.delete(key);
      },
    },
  },
});

beforeEach(() => {
  storage.clear();
});

describe("normalizeSettings", () => {
  it("returns defaults for garbage input", () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ filenameTemplate: 5, notifyOnComplete: "yes" })).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps the batch concurrency into range", () => {
    expect(normalizeSettings({ batchConcurrency: 9 }).batchConcurrency).toBe(4);
    expect(normalizeSettings({ batchConcurrency: 0 }).batchConcurrency).toBe(1);
    expect(normalizeSettings({ batchConcurrency: 3.4 }).batchConcurrency).toBe(3);
    expect(normalizeSettings({ batchConcurrency: "x" }).batchConcurrency).toBe(DEFAULT_SETTINGS.batchConcurrency);
  });

  it("sanitizes the subfolder and keeps a valid template", () => {
    expect(normalizeSettings({ subfolder: "Videos/../down-stream/" }).subfolder).toBe("Videos/down-stream");
    expect(normalizeSettings({ filenameTemplate: "{title}" }).filenameTemplate).toBe("{title}");
  });
});

function job(over: Partial<DownloadJobState> = {}): DownloadJobState {
  return {
    jobId: "job-1",
    tabId: 7,
    itemUrl: "https://cdn.example.com/v.m3u8",
    filename: "DownStream/clip [1080p].mp4",
    status: "done",
    done: 10,
    total: 10,
    bytesDone: 1234,
    updatedAt: 1,
    ...over,
  };
}

describe("entryFromJob", () => {
  it("maps a settled job onto a history row", () => {
    const entry = entryFromJob(job({ title: "Clip", quality: "1080p", mediaType: "hls", downloadId: 5 }), "done", 99);
    expect(entry).toMatchObject({
      id: "job-1",
      itemUrl: "https://cdn.example.com/v.m3u8",
      filename: "DownStream/clip [1080p].mp4",
      title: "Clip",
      quality: "1080p",
      type: "hls",
      bytes: 1234,
      status: "done",
      downloadId: 5,
      at: 99,
    });
  });

  it("keeps the error text for failures only", () => {
    expect(entryFromJob(job({ error: "expired" }), "error").error).toBe("expired");
    expect(entryFromJob(job({ error: "expired" }), "done").error).toBeUndefined();
  });
});

describe("download history store", () => {
  const entry = (id: string, at: number): HistoryEntry => ({
    id,
    itemUrl: `https://x.example.com/${id}.mp4`,
    filename: `${id}.mp4`,
    status: "done",
    at,
  });

  it("prepends newest first and de-duplicates on id", async () => {
    await appendHistory(entry("a", 1));
    await appendHistory(entry("b", 2));
    await appendHistory(entry("a", 3));
    const list = await loadHistory();
    expect(list.map((e) => e.id)).toEqual(["a", "b"]);
    expect(list[0].at).toBe(3);
  });

  it("caps the list at HISTORY_LIMIT", async () => {
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) await appendHistory(entry(`e${i}`, i));
    expect((await loadHistory()).length).toBe(HISTORY_LIMIT);
  });

  it("clears everything", async () => {
    await appendHistory(entry("a", 1));
    await clearHistory();
    expect(await loadHistory()).toEqual([]);
  });

  it("ignores malformed stored rows", async () => {
    storage.set("downStreamHistory", [{ nope: true }, entry("ok", 1)]);
    const list = await loadHistory();
    expect(list.map((e) => e.id)).toEqual(["ok"]);
  });
});
