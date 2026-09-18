// Background service worker — thin wiring only.
// Detection lives in bg/detection, clustering in bg/clusters, header capture
// in bg/headers, media/badge helpers in bg/media, manifests in bg/manifests,
// video/capture enrichment in bg/signals, downloads in bg/jobs, and message
// routing in bg/router. This file only wires Chrome APIs and re-exports the
// legacy helpers (classify/looksLikeChunk/applyTitle/…) so existing imports
// keep working. Zero behavior change from the split.
import { classify, looksLikeChunk } from "./lib/classify";
import type { MediaType } from "./lib/types";
import { clearClustersForTab } from "./bg/clusters";
import { onHeadersReceived } from "./bg/detection";
import { clearHeadersForTab, onSendHeaders } from "./bg/headers";
import { markInterruptedJobs } from "./bg/jobs";
import { isExcludedUrl, updateBadge, updateBadgeForActiveTab } from "./bg/media";
import { routeMessage } from "./bg/router";
import { forgetTabMedia, lastUrlByTab, persistTab } from "./bg/store";

// Re-exported for the legacy import path; new code should import
// from lib/classify directly (popup.ts does).
export { classify, looksLikeChunk };
export type { MediaType };
// Legacy helper re-exports (implementation lives in bg/* now).
export { isExcludedUrl, applyTitle, describeSignal } from "./bg/media";
export { extForBlobMime } from "./bg/signals";

// ---- startup ----
// PING listener registers FIRST, before anything else that could throw
// during startup on some Chromium variants. It answers synchronously with
// zero dependencies, so the popup can always tell "worker alive" apart
// from "worker stuck". (The main listener below handles every other type;
// it deliberately skips PING to avoid a double response.)
try {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((msg as any)?.type === "PING") {
      try {
        sendResponse({ pong: true });
      } catch {
        /* ignore */
      }
    }
    return false;
  });
} catch {
  /* prehistoric browser — the main listener below still tries */
}

// ---- wiring (each guarded: one blocked API must never kill the worker) ----
function safeWire(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn(`[vdg] listener '${label}' unavailable:`, err);
  }
}

safeWire("webRequest.send", () => {
  // extraHeaders is required to SEE Authorization/Referer — without it the
  // capture silently misses auth and every replayed fetch 403s.
  chrome.webRequest.onSendHeaders.addListener(onSendHeaders, { urls: ["http://*/*", "https://*/*"] }, [
    "requestHeaders",
    "extraHeaders",
  ]);
});

safeWire("webRequest", () => {
  chrome.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: ["http://*/*", "https://*/*"] },
    ["responseHeaders"],
  );
});

// New page load = stale detections (traffic, headers, items).
safeWire("webNavigation.committed", () => {
  chrome.webNavigation.onCommitted.addListener(async (details) => {
    if (details.frameId !== 0) return;
    lastUrlByTab.set(details.tabId, details.url);
    clearClustersForTab(details.tabId);
    clearHeadersForTab(details.tabId);
    await persistTab(details.tabId, []);
    await updateBadge(details.tabId);
  });
});

// SPA navigation (X/Twitter feed -> tweet detail etc.): new URL = stale detections.
safeWire("webNavigation.history", () => {
  chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
    try {
      if (details.frameId !== 0) return;
      const prev = lastUrlByTab.get(details.tabId);
      if (prev && new URL(prev).pathname !== new URL(details.url).pathname) {
        await persistTab(details.tabId, []);
        await updateBadge(details.tabId);
      }
      lastUrlByTab.set(details.tabId, details.url);
    } catch {
      /* malformed URLs etc. must never break the worker */
    }
  });
});

safeWire("tabs", () => {
  chrome.tabs.onActivated.addListener((info) => {
    void updateBadge(info.tabId);
  });

  chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
    if (info.status === "complete" && tab.url && tab.id != null) {
      lastUrlByTab.set(tab.id, tab.url);
    }
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    clearClustersForTab(tabId);
    clearHeadersForTab(tabId);
    await forgetTabMedia(tabId);
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // NOTE: PING is handled by the early listener at the top of this file
  // (kept out of here to avoid a double sendResponse).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((msg as any)?.type === "PING") return false;
  void (async () => {
    try {
      sendResponse(await routeMessage(msg, sender));
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // async response
});

// Initialize badge on SW startup (never allowed to break startup).
try {
  void updateBadgeForActiveTab();
} catch {
  /* ignore */
}

// Jobs alive in storage but with no offscreen document lost their fetched
// parts (offscreen memory is gone) — they can never resume. Mark them so
// the popup offers Retry instead of a stuck Paused/Running row. Skipped
// when offscreen is still alive (normal SW suspend during a download).
void markInterruptedJobs();
