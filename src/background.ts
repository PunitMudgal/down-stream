import { parseHlsManifest } from "./lib/parseHls";
import { parseDashManifest } from "./lib/parseDash";
import { filenameForUrl } from "./lib/download";
import type { MediaItem, MediaType, VideoSignal } from "./lib/types";

// In-memory cache (fast path) + chrome.storage.session mirror (survives SW suspend).
const memoryStore = new Map<number, MediaItem[]>();
const SESSION_KEY = "mediaByTab";

async function readSession(): Promise<Record<string, MediaItem[]>> {
  try {
    const got = await chrome.storage.session.get(SESSION_KEY);
    const val = got[SESSION_KEY];
    if (val && typeof val === "object") return val as Record<string, MediaItem[]>;
  } catch {
    /* storage.session unavailable — fall back to memory only */
  }
  return {};
}

async function persistTab(tabId: number, items: MediaItem[]): Promise<void> {
  memoryStore.set(tabId, items);
  try {
    const all = await readSession();
    all[String(tabId)] = items;
    await chrome.storage.session.set({ [SESSION_KEY]: all });
  } catch {
    /* ignore persistence failures */
  }
}

async function getTabItems(tabId: number): Promise<MediaItem[]> {
  const mem = memoryStore.get(tabId);
  if (mem) return mem;
  const all = await readSession();
  const items = all[String(tabId)] ?? [];
  memoryStore.set(tabId, items);
  return items;
}

async function updateBadge(tabId: number): Promise<void> {
  try {
    const items = await getTabItems(tabId);
    const count = items.length;
    await chrome.action.setBadgeText({
      text: count > 0 ? String(count) : "",
      tabId,
    });
    await chrome.action.setBadgeBackgroundColor({ color: "#1a73e8", tabId });
  } catch {
    /* badge is best-effort */
  }
}

async function updateBadgeForActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null) await updateBadge(tab.id);
  } catch {
    /* ignore */
  }
}

function classify(url: string, contentType: string): MediaType | null {
  const ct = contentType.toLowerCase().split(";")[0].trim();
  const lower = url.toLowerCase().split("?")[0].split("#")[0];

  if (lower.endsWith(".m3u8") || ct === "application/vnd.apple.mpegurl" || ct === "application/x-mpegurl")
    return "hls";
  if (lower.endsWith(".mpd") || ct === "application/dash+xml") return "dash";
  if (url.startsWith("blob:")) return "blob";
  if (ct === "video/mp4") return "mp4";
  if (ct === "video/webm") return "webm";
  if (ct === "video/ogg") return "ogg";
  if (ct === "video/quicktime") return "mov";
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "mp4";
  if (lower.endsWith(".webm")) return "webm";
  if (lower.endsWith(".ogv") || lower.endsWith(".ogg")) return "ogg";
  if (lower.endsWith(".mov")) return "mov";
  return null;
}

function headerValue(
  headers: chrome.webRequest.HttpHeader[] | undefined,
  name: string,
): string {
  if (!headers) return "";
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h?.value ?? "";
}

async function upsertItem(tabId: number, item: MediaItem): Promise<void> {
  const items = await getTabItems(tabId);
  // Deduplicate by full URL — keep signed query params intact.
  if (items.some((x) => x.url === item.url)) return;
  items.push(item);
  await persistTab(tabId, items);
  await updateBadge(tabId);
}

async function patchItem(
  tabId: number,
  url: string,
  patch: Partial<MediaItem>,
): Promise<void> {
  const items = await getTabItems(tabId);
  const idx = items.findIndex((x) => x.url === url);
  if (idx === -1) return;
  items[idx] = { ...items[idx], ...patch };
  await persistTab(tabId, items);
  await updateBadge(tabId);
}

async function parseStreamingItem(tabId: number, item: MediaItem): Promise<void> {
  try {
    const res = await fetch(item.url, { credentials: "include" });
    if (!res.ok) throw new Error(`Manifest fetch failed (${res.status})`);
    if (item.type === "hls") {
      const text = await res.text();
      const parsed = parseHlsManifest(text, item.url);
      await patchItem(tabId, item.url, {
        variants: parsed.variants,
        drmProtected: parsed.drmProtected,
        drmReason: parsed.drmReason,
      });
    } else if (item.type === "dash") {
      const text = await res.text();
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

function onHeadersReceived(
  details: chrome.webRequest.OnHeadersReceivedDetails,
): chrome.webRequest.BlockingResponse | undefined {
  const { tabId, url } = details;
  if (tabId == null || tabId < 0) return undefined;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return undefined;

  const ct = headerValue(details.responseHeaders, "content-type");
  const type = classify(url, ct);
  if (!type) return undefined;

  const item: MediaItem = {
    url, // keep full URL incl. auth/signed params
    tabId,
    type,
    filename: filenameForUrl(url, type),
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
      await parseStreamingItem(tabId, item);
    }
  })();
  return undefined;
}

// ---- wiring ----
chrome.webRequest.onHeadersReceived.addListener(
  onHeadersReceived,
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"],
);

// New page load = stale detections.
chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  await persistTab(details.tabId, []);
  await updateBadge(details.tabId);
});

chrome.tabs.onActivated.addListener((info) => {
  void updateBadge(info.tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  memoryStore.delete(tabId);
  try {
    const all = await readSession();
    delete all[String(tabId)];
    await chrome.storage.session.set({ [SESSION_KEY]: all });
  } catch {
    /* ignore */
  }
});

// Enrichment from content script: attach posters, surface blob: videos.
async function handleVideoSignals(
  tabId: number,
  videos: VideoSignal[],
  pageTitle?: string,
): Promise<void> {
  const items = await getTabItems(tabId);
  let changed = false;

  for (const v of videos) {
    if (!v.currentSrc) continue;
    if (v.currentSrc.startsWith("blob:")) {
      if (!items.some((x) => x.url === v.currentSrc)) {
        items.push({
          url: v.currentSrc,
          tabId,
          type: "blob",
          filename: "",
          detectedAt: Date.now(),
          drmProtected: false,
          poster: v.poster,
          pageTitle,
          error: "Blob/MSE stream (e.g. in-player buffer) — not directly downloadable.",
        });
        changed = true;
      }
      continue;
    }
    // Attach poster to a network-detected item lacking one.
    const match = items.find(
      (x) => x.url === v.currentSrc || x.url.split("?")[0] === v.currentSrc.split("?")[0],
    );
    if (match && !match.poster && v.poster) {
      match.poster = v.poster;
      changed = true;
    }
  }
  if (changed) {
    await persistTab(tabId, items);
    await updateBadge(tabId);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  void (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = msg as any;
      if (m?.type === "GET_MEDIA" && typeof m.tabId === "number") {
        sendResponse({ items: await getTabItems(m.tabId) });
      } else if (m?.type === "VIDEO_ELEMENTS" && typeof m.tabId === "number") {
        const fromSender = sender.tab?.id ?? m.tabId;
        await handleVideoSignals(fromSender, m.videos ?? [], m.pageTitle);
        sendResponse({ ok: true });
      } else if (m?.type === "RESCAN" && typeof m.tabId === "number") {
        // Ask the content script to re-collect <video> elements (covers
        // cached pages where webRequest saw nothing new).
        try {
          await chrome.tabs.sendMessage(m.tabId, { type: "COLLECT_NOW" });
        } catch {
          // Content script not injected (e.g. outside matches): inject a
          // one-shot collector via scripting API.
          try {
            await chrome.scripting.executeScript({
              target: { tabId: m.tabId },
              func: () => {
                const vids = Array.from(document.querySelectorAll("video")).map(
                  (v) => ({
                    currentSrc: v.currentSrc || v.src || "",
                    poster: (v as HTMLVideoElement).poster || undefined,
                    duration: Number.isFinite(v.duration) ? v.duration : undefined,
                    paused: v.paused,
                  }),
                );
                chrome.runtime.sendMessage({
                  type: "VIDEO_ELEMENTS",
                  tabId: -1, // background resolves via sender.tab
                  videos: vids,
                  pageTitle: document.title,
                });
              },
            });
          } catch (err) {
            sendResponse({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }
        }
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Unknown message" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // async response
});

// Initialize badge on SW startup.
void updateBadgeForActiveTab();
