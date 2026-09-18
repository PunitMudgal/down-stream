// Manifest fetching + streaming-item parsing.
// Moved verbatim from background.ts — zero behavior change.
import { parseDashManifest } from "../lib/parseDash";
import { parseHlsManifest } from "../lib/parseHls";
import type { MediaItem } from "../lib/types";
import { lookupNet } from "./headers";
import { patchItem } from "./media";

export const MAX_MANIFEST_BYTES = 5_000_000;

export async function fetchManifestText(tabId: number, url: string): Promise<string> {
  const net = lookupNet(tabId, url);
  // First try from the worker (fast path, no tab involvement), replaying
  // the page's own auth/referrer context where captured.
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: net?.headers,
      referrer: net?.referrer,
      referrerPolicy: net?.referrer ? "unsafe-url" : undefined,
    });
    if (res.ok) return await res.text();
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(`Manifest fetch failed (${res.status})`);
    }
    // 401/403: fall through to the page-context fetch below.
  } catch (err) {
    // Network-level failure from the worker context — page fetch may still work.
    if (err instanceof Error && err.message.startsWith("Manifest fetch failed")) throw err;
  }
  // Auth-walled manifests (logged-in sessions, HttpOnly cookies): refetch
  // from the tab's content script, which runs with the page's cookie jar.
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "FETCH_TEXT", url }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("page fetch timeout")), 15000),
      ),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = res as any;
    if (r?.ok && typeof r.text === "string") {
      if (r.truncated) {
        throw new Error("Manifest too large to parse (>5 MB).");
      }
      return r.text as string;
    }
    throw new Error(r?.error ?? "Page-context fetch failed.");
  } catch (err) {
    throw new Error(
      `Manifest unreachable (worker + page fetch failed): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function parseStreamingItem(tabId: number, item: MediaItem): Promise<void> {
  try {
    const text = await fetchManifestText(tabId, item.url);
    if (text.length > MAX_MANIFEST_BYTES) {
      throw new Error("Manifest too large to parse (>5 MB).");
    }
    if (item.type === "hls") {
      const parsed = parseHlsManifest(text, item.url);
      await patchItem(tabId, item.url, {
        variants: parsed.variants,
        drmProtected: parsed.drmProtected,
        drmReason: parsed.drmReason,
      });
    } else if (item.type === "dash") {
      const parsed = parseDashManifest(text, item.url);
      await patchItem(tabId, item.url, {
        variants: parsed.variants,
        drmProtected: parsed.drmProtected,
        drmReason: parsed.drmReason,
      });
    }
  } catch (err) {
    await patchItem(tabId, item.url, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
