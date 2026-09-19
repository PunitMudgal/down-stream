import { describe, expect, it } from "vitest";
import {
  CapExceededError,
  capPartials,
  fetchSegmentedParts,
  findInitChunk,
  isCapExceeded,
  partFilename,
  sniffKind,
  type FetchRangeFn,
} from "../src/lib/download";
import { planCaptureSplit } from "../src/lib/download";
import { audioStream, videoStream } from "./helpers/fmp4";

function buf(n: number, fill = 0x41): ArrayBuffer {
  return new Uint8Array(n).fill(fill).buffer as ArrayBuffer;
}

function urls(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `https://c.example.com/seg-${i}.m4s`);
}

describe("CapExceededError", () => {
  it("is detected by isCapExceeded, including the legacy message", () => {
    const err = new CapExceededError();
    err.partials = [buf(4), undefined];
    expect(isCapExceeded(err)).toBe(true);
    expect(capPartials(err)).toHaveLength(2);
    // Failures raised before the typed error existed still match.
    expect(isCapExceeded(new Error("Video exceeds the 1.5 GB safety cap — download stopped."))).toBe(true);
  });

  it("rejects unrelated errors", () => {
    expect(isCapExceeded(new Error("Segment fetch failed (500)"))).toBe(false);
    expect(isCapExceeded(undefined)).toBe(false);
    expect(capPartials(new Error("nope"))).toBeUndefined();
    expect(capPartials({ partials: "junk" })).toBeUndefined();
  });
});

describe("partFilename", () => {
  it("inserts the part number before the extension", () => {
    expect(partFilename("movie.mp4", 2, ".mp4")).toBe("movie.part2.mp4");
    expect(partFilename("my.show-s01e02.ts", 10, ".ts")).toBe("my.show-s01e02.part10.ts");
  });

  it("tolerates missing dots", () => {
    expect(partFilename("video", 1, "mp4")).toBe("video.part1.mp4");
    expect(partFilename("video", 1, ".mp4")).toBe("video.part1.mp4");
  });
});

describe("sniffKind + findInitChunk", () => {
  it("identifies containers from head bytes", () => {
    expect(sniffKind(new Uint8Array([0x47, 0, 0, 0]))).toBe("ts");
    expect(sniffKind(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe("webm");
    expect(sniffKind(new Uint8Array([0x3c, 0x68, 0x74, 0x6d]))).toBe("text");
    expect(sniffKind(new Uint8Array([0x5a, 0x5a, 0x5a, 0x5a]))).toBe("unknown");
    expect(sniffKind(videoStream(1).subarray(0, 8))).toBe("fmp4");
    expect(sniffKind(audioStream(2).subarray(0, 8))).toBe("fmp4");
  });

  it("finds the moov chunk in an fMP4 stream and nothing in TS", () => {
    const stream = videoStream(1).slice().buffer as ArrayBuffer;
    expect(findInitChunk([stream])).toBe(stream);
    expect(findInitChunk([buf(188, 0x47)])).toBeUndefined();
    expect(findInitChunk([])).toBeUndefined();
  });
});

describe("fetchSegmentedParts", () => {
  it("fetches small lists in one range with multi=false", async () => {
    const seen: Array<{ start: number; end: number; withExisting: boolean }> = [];
    const saved: Array<{ start: number; end: number; partNo: number; multi: boolean }> = [];
    const fetchRange: FetchRangeFn = (win, o) => {
      seen.push({ start: o.start, end: o.end, withExisting: !!o.existingParts });
      return Promise.resolve(win.map(() => buf(10)));
    };
    const res = await fetchSegmentedParts(urls(5), fetchRange, (part, partNo, multi) => {
      saved.push({ start: part.start, end: part.end, partNo, multi });
      expect(part.buffers).toHaveLength(part.end - part.start);
      return Promise.resolve();
    });
    expect(res).toEqual({ parts: 1, multi: false });
    expect(seen).toEqual([{ start: 0, end: 5, withExisting: false }]);
    expect(saved).toEqual([{ start: 0, end: 5, partNo: 1, multi: false }]);
  });

  it("binary-splits a capped list and saves ranges in playlist order", async () => {
    const calls: Array<{ start: number; end: number; existing?: number }> = [];
    const saved: Array<{ start: number; end: number; partNo: number; multi: boolean }> = [];
    let first = true;
    const fetchRange: FetchRangeFn = (win, o) => {
      calls.push({ start: o.start, end: o.end, existing: o.existingParts?.length });
      if (first) {
        first = false;
        // Simulate fetchSegments hitting the cap after fetching everything.
        const err = new CapExceededError();
        err.partials = win.map(() => buf(10));
        return Promise.reject(err);
      }
      return Promise.resolve(win.map(() => buf(10)));
    };
    const res = await fetchSegmentedParts(urls(4), fetchRange, (part, partNo, multi) => {
      saved.push({ start: part.start, end: part.end, partNo, multi });
      return Promise.resolve();
    });
    expect(res).toEqual({ parts: 2, multi: true });
    // Full attempt first, then each half retried WITH its partials slice.
    expect(calls).toEqual([
      { start: 0, end: 4, existing: undefined },
      { start: 0, end: 2, existing: 2 },
      { start: 2, end: 4, existing: 2 },
    ]);
    // Ordered part files: part 1 precedes part 2.
    expect(saved).toEqual([
      { start: 0, end: 2, partNo: 1, multi: true },
      { start: 2, end: 4, partNo: 2, multi: true },
    ]);
  });

  it("keeps splitting while ranges still exceed the cap", async () => {
    const fetchRange: FetchRangeFn = (win, o) => {
      if (win.length > 1) {
        const err = new CapExceededError();
        err.partials = win.map(() => buf(10));
        return Promise.reject(err);
      }
      return Promise.resolve([buf(10)]);
    };
    const saved: Array<[number, number]> = [];
    const res = await fetchSegmentedParts(urls(3), fetchRange, (part, partNo) => {
      saved.push([part.start, part.end]);
      expect(partNo).toBe(saved.length);
      return Promise.resolve();
    });
    expect(res.parts).toBe(3);
    expect(res.multi).toBe(true);
    expect(saved).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
  });

  it("fails clearly when one segment alone exceeds the cap", async () => {
    const fetchRange: FetchRangeFn = () => {
      const err = new CapExceededError();
      err.partials = [buf(10)];
      return Promise.reject(err);
    };
    await expect(fetchSegmentedParts(urls(1), fetchRange, () => Promise.resolve())).rejects.toThrow(
      /single video chunk.*lower quality/i,
    );
  });

  it("propagates non-cap errors without splitting", async () => {
    let calls = 0;
    const fetchRange: FetchRangeFn = () => {
      calls++;
      return Promise.reject(new Error("Segment fetch failed (500)"));
    };
    let saves = 0;
    await expect(
      fetchSegmentedParts(urls(4), fetchRange, () => {
        saves++;
        return Promise.resolve();
      }),
    ).rejects.toThrow(/500/);
    expect(calls).toBe(1);
    expect(saves).toBe(0);
  });

  it("retries halves cleanly when the cap error carries no partials", async () => {
    const seenExisting: Array<number | undefined> = [];
    let first = true;
    const fetchRange: FetchRangeFn = (win, o) => {
      seenExisting.push(o.existingParts?.length);
      if (first) {
        first = false;
        return Promise.reject(new CapExceededError());
      }
      return Promise.resolve(win.map(() => buf(10)));
    };
    const res = await fetchSegmentedParts(urls(2), fetchRange, () => Promise.resolve());
    expect(res).toEqual({ parts: 2, multi: true });
    expect(seenExisting).toEqual([undefined, undefined, undefined]);
  });

  it("rejects an empty list", async () => {
    await expect(fetchSegmentedParts([], () => Promise.resolve([]), () => Promise.resolve())).rejects.toThrow(
      /No segments/,
    );
  });
});

describe("planCaptureSplit", () => {
  it("returns null when both tracks fit under the cap", () => {
    expect(planCaptureSplit([1_000_000_000, 200_000_000], 1_500_000_000)).toBeNull();
    expect(planCaptureSplit([], 1_500_000_000)).toBeNull();
    expect(planCaptureSplit([1_500_000_000], 1_500_000_000)).toBeNull();
  });

  it("splits each over-cap track independently", () => {
    // 3.2 GB video + 300 MB audio: video -> 3 parts, audio -> 1 part.
    expect(planCaptureSplit([3_200_000_000, 300_000_000], 1_500_000_000)).toEqual([3, 1]);
  });

  it("respects a custom cap", () => {
    expect(planCaptureSplit([10], 3)).toEqual([4]); // ceil(10/3)
    expect(planCaptureSplit([9], 3)).toEqual([3]); // exactly at the boundary still splits
    expect(planCaptureSplit([3], 3)).toBeNull(); // fits — no split
  });
});
