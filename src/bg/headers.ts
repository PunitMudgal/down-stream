// Request-header capture (auth replay for 403-prone fetches).
// Moved verbatim from background.ts — zero behavior change.
//
// Only replayable values are stored (Authorization + custom X-* headers and
// the page referrer). Cookies are NEVER stored — and couldn't be replayed
// via fetch() anyway. Memory-only (never persisted), per tab, FIFO-capped.
import { classify } from "../lib/classify";
import type { NetReplay } from "../lib/types";
import { clusterKey, looksSequential, segPathExt } from "./clusters";
import { isExcludedUrl } from "./media";

export const HDR_MAX_PER_TAB = 300;

export interface CapturedNet {
  origin: string;
  pattern: string;
  headers: Record<string, string>;
  referrer?: string;
}

export const hdrStore = new Map<number, Map<string, CapturedNet>>();

export function videoishForHeaders(url: string): boolean {
  if (classify(url, "") !== null) return true;
  const path = url.toLowerCase().split("?")[0];
  if (segPathExt(path) && ["ts", "m4s", "m4v", "cmfv", "cmfa"].includes(segPathExt(path)!)) return true;
  return looksSequential(url);
}

export function onSendHeaders(details: chrome.webRequest.OnSendHeadersDetails): void {
  const { tabId, url } = details;
  if (tabId == null || tabId < 0) return;
  if (isExcludedUrl(url)) return;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return;
  if (!videoishForHeaders(url)) return;
  const headers: Record<string, string> = {};
  let referrer: string | undefined;
  for (const h of details.requestHeaders ?? []) {
    const name = h.name.toLowerCase();
    const value = (h.value ?? "").slice(0, 2048);
    if (!value) continue;
    if (name === "authorization") {
      headers["Authorization"] = value;
    } else if (name.startsWith("x-") && Object.keys(headers).length < 10) {
      headers[h.name] = value;
    } else if (name === "referer") {
      referrer = value;
    }
    // NOTE: cookie/set-cookie and everything else are deliberately skipped.
  }
  if (!Object.keys(headers).length && !referrer) return;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  let perTab = hdrStore.get(tabId);
  if (!perTab) {
    perTab = new Map();
    hdrStore.set(tabId, perTab);
  }
  perTab.set(url, { origin, pattern: clusterKey(url) ?? url, headers, referrer });
  while (perTab.size > HDR_MAX_PER_TAB) {
    const oldest = perTab.keys().next().value as string | undefined;
    if (!oldest) break;
    perTab.delete(oldest);
  }
}

/**
 * Replayable net context for a target URL. Auth/custom headers only cross
 * to the SAME origin they were captured from (no token leakage across
 * hosts); the page referrer may go anywhere (matches page behavior).
 */
export function lookupNet(tabId: number, targetUrl: string): NetReplay | undefined {
  const perTab = hdrStore.get(tabId);
  if (!perTab?.size) return undefined;
  let targetOrigin: string;
  try {
    targetOrigin = new URL(targetUrl).origin;
  } catch {
    return undefined;
  }
  const exact = perTab.get(targetUrl);
  const candidates = exact ? [exact] : [...perTab.values()].reverse();
  for (const c of candidates) {
    const patternMatch = exact ? true : c.pattern === clusterKey(targetUrl);
    if (!patternMatch) continue;
    const out: NetReplay = {};
    if (c.origin === targetOrigin && Object.keys(c.headers).length) {
      out.headers = { ...c.headers };
    }
    if (c.referrer) out.referrer = c.referrer;
    if (out.headers || out.referrer) return out;
    if (exact) return undefined;
  }
  return undefined;
}

export function clearHeadersForTab(tabId: number): void {
  hdrStore.delete(tabId);
}
