import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchSegments, isGateFailure } from "../src/lib/download";

/** Minimal Response stand-in — the fetcher only reads status/headers/bytes. */
function res(status: number, body: ArrayBuffer, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async (): Promise<ArrayBuffer> => body,
    text: async (): Promise<string> => new TextDecoder().decode(body),
  };
}

function buf(n: number, fill = 0x47): ArrayBuffer {
  return new Uint8Array(n).fill(fill).buffer as ArrayBuffer;
}

function textBuf(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer as ArrayBuffer;
}

type Handler = (url: string) => ReturnType<typeof res>;

let handler: Handler;
let calls: string[] = [];

beforeEach(() => {
  calls = [];
  handler = () => res(200, buf(4));
  vi.stubGlobal("fetch", (url: string) => {
    calls.push(String(url));
    return Promise.resolve(handler(String(url)));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const A = "https://cdn.example.com/x/1.ts";
const B = "https://cdn.example.com/x/2.ts";

describe("isGateFailure", () => {
  it("treats refused requests as relayable", () => {
    expect(isGateFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isGateFailure(new Error("Stream chunk unavailable (403) — the link likely expired."))).toBe(
      true,
    );
    expect(isGateFailure(new Error("Segment fetch failed (404): https://cdn/x.ts"))).toBe(true);
    expect(isGateFailure(new Error("Playlist fetch failed (403)"))).toBe(true);
    expect(
      isGateFailure(new Error("A stream chunk came back as an error page instead of video (link expired).")),
    ).toBe(true);
  });

  it("leaves server-side and transport problems alone", () => {
    expect(isGateFailure(new Error("Segment fetch failed (500): https://cdn/x.ts"))).toBe(false);
    expect(isGateFailure(new Error("Segment fetch failed (503): https://cdn/x.ts"))).toBe(false);
    expect(isGateFailure(new Error("Segment timed out after 30s: https://cdn/x.ts"))).toBe(false);
    expect(isGateFailure(new Error("Video exceeds the 1.5 GB safety cap — download stopped."))).toBe(
      false,
    );
    expect(isGateFailure(undefined)).toBe(false);
  });
});

describe("fetchSegments with a page relay", () => {
  it("relays only the segment the CDN refused, and keeps the rest direct", async () => {
    handler = (url) => (url === B ? res(403, new ArrayBuffer(0)) : res(200, buf(4, 0x47)));
    const relayed: string[] = [];
    const out = await fetchSegments([A, B], undefined, undefined, undefined, {
      relay: async (url) => {
        relayed.push(url);
        return buf(16, 0x47);
      },
    });
    expect(relayed).toEqual([B]);
    expect(calls.filter((u) => u === A)).toHaveLength(1); // direct path untouched
    expect(calls.filter((u) => u === B)).toHaveLength(1); // 403 fails fast, no retries
    expect(out).toHaveLength(2);
    expect(out[1].byteLength).toBe(16);
  });

  it("never spends the page's bandwidth on a 5xx", async () => {
    handler = () => res(501, new ArrayBuffer(0));
    let relayCalls = 0;
    await expect(
      fetchSegments([A], undefined, undefined, undefined, {
        relay: async () => {
          relayCalls++;
          return buf(4);
        },
      }),
    ).rejects.toThrow(/Segment fetch failed \(501\)/);
    expect(relayCalls).toBe(0);
  });

  it("surfaces the original refusal when the page is refused too", async () => {
    handler = () => res(404, new ArrayBuffer(0));
    const err = await fetchSegments([A], undefined, undefined, undefined, {
      relay: async () => {
        throw new Error("The page was refused (404).");
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/unavailable \(404\)/);
    expect(isGateFailure(err)).toBe(true);
  });

  it("refuses an error page the page relayed back", async () => {
    handler = () => res(403, new ArrayBuffer(0));
    await expect(
      fetchSegments([A], undefined, undefined, undefined, {
        relay: async () => textBuf("<html>hotlink denied</html>"),
      }),
    ).rejects.toThrow(/error page instead of video/i);
  });

  it("fails as before when no relay is configured", async () => {
    handler = () => res(403, new ArrayBuffer(0));
    await expect(fetchSegments([A], undefined, undefined, undefined, {})).rejects.toThrow(
      /unavailable \(403\)/,
    );
  });

  it("relays nothing when the direct fetch already works", async () => {
    let relayCalls = 0;
    const out = await fetchSegments([A, B], undefined, undefined, undefined, {
      relay: async () => {
        relayCalls++;
        return buf(4);
      },
    });
    expect(relayCalls).toBe(0);
    expect(out).toHaveLength(2);
  });

  it("replaces expired signed URLs via refreshUrls and finishes the job", async () => {
    handler = (url) =>
      url.includes("token=old") ? res(404, new ArrayBuffer(0)) : res(200, buf(4, 0x47));
    const out = await fetchSegments(
      ["https://cdn.example.com/x/1.ts?token=old", "https://cdn.example.com/x/2.ts?token=old"],
      undefined,
      undefined,
      undefined,
      {
        refreshUrls: async () => [
          "https://cdn.example.com/x/1.ts?token=new",
          "https://cdn.example.com/x/2.ts?token=new",
        ],
      },
    );
    expect(out).toHaveLength(2);
    expect(calls.some((u) => u.includes("token=new"))).toBe(true);
  });

  it("caps in-flight fetches at opts.concurrency", async () => {
    let inflight = 0;
    let max = 0;
    vi.stubGlobal("fetch", (url: string) => {
      calls.push(String(url));
      inflight++;
      max = Math.max(max, inflight);
      return new Promise((resolve) => {
        setTimeout(() => {
          inflight--;
          resolve(res(200, buf(4, 0x47)));
        }, 20);
      });
    });
    const urls = [A, B, "https://cdn.example.com/x/3.ts", "https://cdn.example.com/x/4.ts"];
    await fetchSegments(urls, undefined, undefined, undefined, { concurrency: 2 });
    expect(max).toBeLessThanOrEqual(2);
  });
});
