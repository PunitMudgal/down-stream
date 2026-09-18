// Network detection: webRequest -> media items + cluster feed.
// Moved verbatim from background.ts — zero behavior change.
import { classify } from "../lib/classify";
import { filenameForUrl } from "../lib/download";
import type { MediaItem } from "../lib/types";
import { recordCandidate } from "./clusters";
import { dropSupersededClusters } from "./clusters";
import { headerValue, isExcludedUrl, upsertItem } from "./media";
import { parseStreamingItem } from "./manifests";
import { getTabItems } from "./store";

export function onHeadersReceived(
  details: chrome.webRequest.OnHeadersReceivedDetails,
): chrome.webRequest.BlockingResponse | undefined {
  const { tabId, url } = details;
  if (tabId == null || tabId < 0) return undefined;
  if (isExcludedUrl(url)) return undefined;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return undefined;

  const ct = headerValue(details.responseHeaders, "content-type");
  // Always feed the segment-cluster engine (cheap prefilter inside) —
  // this is what catches MSE/blob players via their chunk traffic.
  const len = Number(headerValue(details.responseHeaders, "content-length") || "0");
  recordCandidate(tabId, details.frameId ?? 0, url, ct, details.statusCode, Number.isFinite(len) ? len : 0);

  const type = classify(url, ct);
  if (!type) return undefined;

  const item: MediaItem = {
    url, // keep full URL incl. auth/signed params
    tabId,
    type,
    filename: filenameForUrl(url, type),
    autoNamed: true,
    detectedAt: Date.now(),
    drmProtected: false,
    variants: type === "hls" || type === "dash" ? [] : undefined,
    error: type === "blob" ? "Blob/MSE stream — not directly downloadable." : undefined,
  };

  void (async () => {
    const existing = await getTabItems(tabId);
    if (existing.some((x) => x.url === url)) return;
    await upsertItem(tabId, item);
    if (type === "hls" || type === "dash") {
      // A parsed manifest replaces raw auto-groups from the same directory.
      await dropSupersededClusters(tabId, url);
      await parseStreamingItem(tabId, item);
    }
  })();
  return undefined;
}
