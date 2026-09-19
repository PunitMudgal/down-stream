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
import { markInterruptedJobs, ensureItemForUrl, startDownload } from "./bg/jobs";
import { isExcludedUrl, updateBadge, updateBadgeForActiveTab } from "./bg/media";
import { routeMessage } from "./bg/router";
import { forgetTabMedia, getTabItems, jobMemory, lastUrlByTab, persistTab } from "./bg/store";
import { pickBestTabItem, pickCandidateItem, looksLikeBlobPlayer } from "./lib/target";
import { pruneOrphans } from "./lib/persist";

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

// Right-click a <video> → "Download this video", or press the keyboard
// shortcut. Both ask the content script to resolve the target video (cursor
// position for the menu, best-video heuristic for the key) and then start the
// download directly — a zero-friction entry point that never needs the popup.
const CTX_MENU_ID = "vdg-download-video";
const CMD_DOWNLOAD_BEST = "download-best-video";

async function triggerPageDownload(tabId: number): Promise<boolean> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: "CONTEXT_DOWNLOAD" })) as
      | { ok?: boolean; candidates?: string[]; title?: string }
      | undefined;
    if (!res?.ok || !Array.isArray(res.candidates) || res.candidates.length === 0) return false;
    const items = await getTabItems(tabId);
    // 1. The element's own URLs, matched against what we detected (handles
    //    signed-URL drift, and finds the MSE capture row behind a blob: player).
    const matched = pickCandidateItem(items, res.candidates);
    if (matched) {
      // No variant id: startDownload picks the best quality, exactly like the
      // popup's default click.
      await startDownload(tabId, matched.url);
      return true;
    }
    // 2. Nothing matched: register the element's direct/manifest URL ourselves
    //    (cached media and manifests webRequest never reported).
    const fresh = await ensureItemForUrl(tabId, res.candidates, res.title);
    if (fresh) {
      await startDownload(tabId, fresh.url);
      return true;
    }
    // 3. Only a blob: player and no matching row: the tab's best downloadable
    //    item is the only way to honour the click.
    if (looksLikeBlobPlayer(res.candidates)) {
      const best = pickBestTabItem(items);
      if (best) {
        await startDownload(tabId, best.url);
        return true;
      }
    }
  } catch {
    /* content script absent (chrome:// pages, store pages) or worker race */
  }
  return false;
}

safeWire("contextMenus", () => {
  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId !== CTX_MENU_ID || tab?.id == null) return;
    void triggerPageDownload(tab.id);
  });
});

safeWire("commands", () => {
  chrome.commands.onCommand.addListener((command) => {
    if (command !== CMD_DOWNLOAD_BEST) return;
    void (async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id != null) await triggerPageDownload(tab.id);
      } catch {
        /* ignore */
      }
    })();
  });
});

chrome.runtime.onInstalled.addListener(() => {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: CTX_MENU_ID,
        title: "Download this video",
        contexts: ["video"],
      });
    });
  } catch {
    /* menu API unavailable */
  }
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

// Jobs alive in storage but not running in the live offscreen document were
// orphaned by a restart. Re-fetchable kinds keep their OPFS-persisted segments
// and become resumable; the rest are marked so the popup offers Retry.
void markInterruptedJobs().then(() => {
  // Drop OPFS segment caches for jobs that no longer exist (bounded storage).
  pruneOrphans(new Set([...jobMemory.keys()])).catch(() => {
    /* best-effort */
  });
});
