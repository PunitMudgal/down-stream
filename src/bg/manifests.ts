// Manifest fetching + streaming-item parsing.
//
// A playlist is fetched through a chain of progressively richer contexts,
// because the cheapest/fastest one frequently is not the one the CDN accepts:
//   1. cache — the bytes we already read (also covers rotated signed URLs);
//   2. page capture — the playlist bytes the player already downloaded (no
//      network at all);
//   3. worker fetch — replays captured Authorization/X-* headers + the page
//      referrer; fails against Referer/Origin/token-gated CDNs;
//   4. page fetch (content script) — a request issued from the page's own JS
//      world, i.e. exactly the request the playing video made.
// Only when the whole chain fails do we report, naming what each layer said.
import { parseDashManifest } from "../lib/parseDash";
import { parseHlsManifest } from "../lib/parseHls";
import {
  ManifestCache,
  manifestFailureMessage,
  type FetchAttempt,
} from "../lib/manifestCache";
import type { MediaItem } from "../lib/types";
import { lookupNet } from "./headers";
import { patchItem } from "./media";

export const MAX_MANIFEST_BYTES = 5_000_000;

/** Successful reads, shared by detection parses, downloads and re-downloads. */
const manifestCache = new ManifestCache();

export interface FetchManifestOptions {
  /**
   * Network first, cache only as a fallback. Used where freshness matters
   * (download-time re-resolution of signed segment URLs).
   */
  forceNetwork?: boolean;
}

/** One fetch attempt from the worker context, with the page's auth replayed. */
async function fetchFromWorker(
  tabId: number,
  url: string,
): Promise<{ text?: string; attempt?: FetchAttempt }> {
  const net = lookupNet(tabId, url);
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: net?.headers,
      referrer: net?.referrer,
      referrerPolicy: net?.referrer ? "unsafe-url" : undefined,
    });
    if (res.ok) {
      const text = await res.text();
      if (text.length > MAX_MANIFEST_BYTES) {
        throw new Error("Manifest too large to parse (>5 MB).");
      }
      return { text };
    }
    return { attempt: { status: res.status } };
  } catch (err) {
    if (err instanceof Error && /too large/i.test(err.message)) throw err;
    return {
      attempt: { network: true, reason: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Cheap probe for the bytes the page's player already downloaded: no network
 * at all. Returns undefined when absent (or the page is unreachable), which is
 * the normal case before playback starts.
 */
async function probePageCapture(tabId: number, url: string): Promise<string | undefined> {
  if (tabId < 0) return undefined;
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "FETCH_TEXT", url, captureOnly: true }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("probe timeout")), 2000)),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = res as any;
    if (r?.ok === true && typeof r.text === "string" && (r.text as string).length > 0) {
      return r.text as string;
    }
  } catch {
    /* no content script, no capture, or a frozen tab — just move on */
  }
  return undefined;
}

/** Fetch from the tab's content script: captured bytes, else the page's own
 *  request context. Returns a short failure reason when it can't. */
async function fetchFromPage(
  tabId: number,
  url: string,
): Promise<{ text?: string; attempt?: FetchAttempt }> {
  if (tabId < 0) return {};
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "FETCH_TEXT", url }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Page fetch timed out")), 20_000),
      ),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = res as any;
    if (r?.ok) {
      const text = typeof r.text === "string" ? (r.text as string) : "";
      if (r.truncated || text.length > MAX_MANIFEST_BYTES) {
        throw new Error("Manifest too large to parse (>5 MB).");
      }
      return { text };
    }
    return { attempt: { reason: String(r?.error ?? "Page fetch failed") } };
  } catch (err) {
    if (err instanceof Error && /too large/i.test(err.message)) throw err;
    return {
      attempt: { network: true, reason: err instanceof Error ? err.message : String(err) },
    };
  }
}

/**
 * Read a manifest (m3u8/mpd) as text through the fallback chain above.
 * Throws an actionable, user-facing error when every layer is refused.
 */
export async function fetchManifestText(
  tabId: number,
  url: string,
  opts: FetchManifestOptions = {},
): Promise<string> {
  const cached = manifestCache.get(url);
  if (cached !== undefined && !opts.forceNetwork) return cached;

  // Fastest first: the page's own copy of the playlist costs no network.
  // Skipped when freshness matters — a download re-resolves signed segment
  // URLs and a minutes-old playlist can carry expired tokens (the page step
  // below still falls back to the captured copy if the network refuses).
  if (!opts.forceNetwork) {
    const captured = await probePageCapture(tabId, url);
    if (captured !== undefined) {
      manifestCache.set(url, captured);
      return captured;
    }
  }

  let workerAttempt: FetchAttempt | undefined;
  try {
    const worker = await fetchFromWorker(tabId, url);
    if (worker.text !== undefined) {
      manifestCache.set(url, worker.text);
      return worker.text;
    }
    workerAttempt = worker.attempt;
  } catch (err) {
    if (cached !== undefined) return cached; // e.g. oversized loop guard
    throw err;
  }

  // Worker refused (Referer/Origin/token gates): ask the page to fetch it with
  // its own request context — the one the playing video proved the CDN accepts.
  let pageAttempt: FetchAttempt | undefined;
  try {
    const page = await fetchFromPage(tabId, url);
    if (page.text !== undefined) {
      manifestCache.set(url, page.text);
      return page.text;
    }
    pageAttempt = page.attempt;
  } catch (err) {
    if (cached !== undefined) return cached;
    throw err;
  }

  // Both layers failed — but an expired-token manifest still beats nothing if
  // we happen to hold a usable snapshot (its segment URLs may still resolve).
  if (cached !== undefined) return cached;
  throw new Error(manifestFailureMessage(workerAttempt, pageAttempt));
}

/** Parse a manifest item in place (variants / DRM flags / error message). */
export async function parseStreamingItem(
  tabId: number,
  item: MediaItem,
  opts: FetchManifestOptions = {},
): Promise<void> {
  try {
    const text = await fetchManifestText(tabId, item.url, opts);
    if (text.length > MAX_MANIFEST_BYTES) {
      throw new Error("Manifest too large to parse (>5 MB).");
    }
    if (item.type === "hls") {
      const parsed = parseHlsManifest(text, item.url);
      await patchItem(tabId, item.url, {
        variants: parsed.variants,
        drmProtected: parsed.drmProtected,
        drmReason: parsed.drmReason,
        error: undefined,
      });
    } else if (item.type === "dash") {
      const parsed = parseDashManifest(text, item.url);
      await patchItem(tabId, item.url, {
        variants: parsed.variants,
        drmProtected: parsed.drmProtected,
        drmReason: parsed.drmReason,
        error: undefined,
      });
    }
  } catch (err) {
    await patchItem(tabId, item.url, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
