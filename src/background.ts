import { parseHlsManifest } from "./lib/parseHls";
import { parseDashManifest } from "./lib/parseDash";
import { filenameForUrl } from "./lib/download";
import type {
  DownloadJobRequest,
  DownloadJobState,
  MediaItem,
  MediaType,
  VideoSignal,
} from "./lib/types";

// In-memory caches (fast path) + chrome.storage.session mirrors (survive SW suspend).
const memoryStore = new Map<number, MediaItem[]>();
const jobMemory = new Map<string, DownloadJobState>();
const lastUrlByTab = new Map<number, string>();
const SESSION_KEY = "mediaByTab";
const JOBS_KEY = "downloadJobs";
const OFFSCREEN_URL = "src/offscreen.html";
const MAX_ITEMS_PER_TAB = 60;
const MAX_BLOB_PER_TAB = 25;

function newJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readSessionKey<T>(key: string, fallback: T): Promise<T> {
  try {
    const got = await chrome.storage.session.get(key);
    const val = got[key];
    if (val && typeof val === "object") return val as T;
  } catch {
    /* storage.session unavailable — fall back to memory only */
  }
  return fallback;
}

async function persistTab(tabId: number, items: MediaItem[]): Promise<void> {
  memoryStore.set(tabId, items);
  try {
    const all = await readSessionKey<Record<string, MediaItem[]>>(SESSION_KEY, {});
    all[String(tabId)] = items;
    await chrome.storage.session.set({ [SESSION_KEY]: all });
  } catch {
    /* ignore persistence failures */
  }
}

async function getTabItems(tabId: number): Promise<MediaItem[]> {
  const mem = memoryStore.get(tabId);
  if (mem) return mem;
  const all = await readSessionKey<Record<string, MediaItem[]>>(SESSION_KEY, {});
  const items = all[String(tabId)] ?? [];
  memoryStore.set(tabId, items);
  return items;
}

async function persistJobs(): Promise<void> {
  try {
    // Prune: keep the 30 most recent jobs so session storage stays small.
    const sorted = [...jobMemory.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    jobMemory.clear();
    for (const j of sorted.slice(0, 30)) jobMemory.set(j.jobId, j);
    const all: Record<string, DownloadJobState> = {};
    for (const [id, job] of jobMemory) all[id] = job;
    await chrome.storage.session.set({ [JOBS_KEY]: all });
  } catch {
    /* ignore */
  }
}

async function ensureJobsLoaded(): Promise<void> {
  if (jobMemory.size > 0) return;
  const all = await readSessionKey<Record<string, DownloadJobState>>(JOBS_KEY, {});
  for (const [id, job] of Object.entries(all)) jobMemory.set(id, job);
}

async function getTabJobs(tabId: number): Promise<DownloadJobState[]> {
  await ensureJobsLoaded();
  return [...jobMemory.values()]
    .filter((j) => j.tabId === tabId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

const lastJobPersist = new Map<string, number>();

async function upsertJob(job: DownloadJobState, persist = true): Promise<void> {
  job.updatedAt = Date.now();
  jobMemory.set(job.jobId, job);
  // Progress ticks arrive per segment — throttle session writes (quota),
  // but always broadcast so an open popup stays live.
  if (persist) {
    await persistJobs();
    lastJobPersist.set(job.jobId, Date.now());
  } else {
    const last = lastJobPersist.get(job.jobId) ?? 0;
    if (Date.now() - last > 2000) {
      await persistJobs();
      lastJobPersist.set(job.jobId, Date.now());
    }
  }
  // Broadcast so an open popup updates live (content scripts ignore it).
  try {
    await chrome.runtime.sendMessage({ type: "JOB_UPDATED", job });
  } catch {
    /* popup closed — state reconciles via GET_JOBS on reopen */
  }
}

/** Badge counts real network detections (direct/HLS/DASH), not blob placeholders. */
async function updateBadge(tabId: number): Promise<void> {
  try {
    const items = await getTabItems(tabId);
    const count = items.filter((x) => x.type !== "blob").length;
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
  // NOTE: video/mp2t and octet-stream are segment/chunk types — never items.
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

/** Bound per-tab growth (infinite feeds) — drop oldest blob placeholders first. */
function enforceCaps(items: MediaItem[]): MediaItem[] {
  let out = items;
  const blobs = out.filter((x) => x.type === "blob");
  if (blobs.length > MAX_BLOB_PER_TAB) {
    const drop = new Set(blobs.slice(0, blobs.length - MAX_BLOB_PER_TAB).map((x) => x.url));
    out = out.filter((x) => !drop.has(x.url));
  }
  if (out.length > MAX_ITEMS_PER_TAB) {
    out = out.slice(out.length - MAX_ITEMS_PER_TAB);
  }
  return out;
}

async function upsertItem(tabId: number, item: MediaItem): Promise<void> {
  const items = await getTabItems(tabId);
  // Deduplicate by full URL — keep signed query params intact.
  if (items.some((x) => x.url === item.url)) return;
  items.push(item);
  await persistTab(tabId, enforceCaps(items));
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
  lastUrlByTab.set(details.tabId, details.url);
  await persistTab(details.tabId, []);
  await updateBadge(details.tabId);
});

// SPA navigation (X/Twitter feed -> tweet detail etc.): new URL = stale detections.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const prev = lastUrlByTab.get(details.tabId);
  if (prev && new URL(prev).pathname !== new URL(details.url).pathname) {
    await persistTab(details.tabId, []);
    await updateBadge(details.tabId);
  }
  lastUrlByTab.set(details.tabId, details.url);
});

chrome.tabs.onActivated.addListener((info) => {
  void updateBadge(info.tabId);
});

chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
  if (info.status === "complete" && tab.url && tab.id != null) {
    lastUrlByTab.set(tab.id, tab.url);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  memoryStore.delete(tabId);
  lastUrlByTab.delete(tabId);
  try {
    const all = await readSessionKey<Record<string, MediaItem[]>>(SESSION_KEY, {});
    delete all[String(tabId)];
    await chrome.storage.session.set({ [SESSION_KEY]: all });
  } catch {
    /* ignore */
  }
});

// Enrichment from content script: attach posters, surface blob: videos,
// and create items for direct URLs webRequest missed (e.g. cached media).
async function handleVideoSignals(
  tabId: number,
  videos: VideoSignal[],
  pageTitle?: string,
): Promise<void> {
  const items = await getTabItems(tabId);
  let changed = false;
  const touch = (url: string, poster?: string) => {
    const match = items.find(
      (x) => x.url === url || x.url.split("?")[0] === url.split("?")[0],
    );
    if (match && poster && !match.poster) {
      match.poster = poster;
      changed = true;
    }
  };

  for (const v of videos) {
    const candidates = [v.currentSrc, ...(v.candidates ?? [])].filter(Boolean);
    for (const src of candidates) {
      if (!src || src.startsWith("data:")) continue;
      if (src.startsWith("blob:")) {
        const existing = items.find((x) => x.url === src);
        if (!existing) {
          items.push({
            url: src,
            tabId,
            type: "blob",
            filename: "",
            detectedAt: Date.now(),
            drmProtected: false,
            poster: v.poster,
            pageTitle,
            error: "Blob/MSE stream (in-player buffer) — the downloadable file is captured from the network when it loads. Try playing, then Rescan.",
          });
          changed = true;
        } else if (v.poster && !existing.poster) {
          existing.poster = v.poster;
          changed = true;
        }
        continue;
      }
      if (!src.startsWith("http://") && !src.startsWith("https://")) continue;
      const type = classify(src, "");
      if (type === "hls" || type === "dash") {
        if (!items.some((x) => x.url === src)) {
          const item: MediaItem = {
            url: src,
            tabId,
            type,
            filename: filenameForUrl(src, type),
            detectedAt: Date.now(),
            drmProtected: false,
            variants: [],
            poster: v.poster,
            pageTitle,
          };
          items.push(item);
          changed = true;
          void parseStreamingItem(tabId, item);
        } else {
          touch(src, v.poster);
        }
      } else if (type === "mp4" || type === "webm" || type === "ogg" || type === "mov") {
        // Direct file the network listener missed (cached before install etc.)
        if (!items.some((x) => x.url === src || x.url.split("?")[0] === src.split("?")[0])) {
          items.push({
            url: src,
            tabId,
            type,
            filename: filenameForUrl(src, type),
            detectedAt: Date.now(),
            drmProtected: false,
            poster: v.poster,
            pageTitle,
          });
          changed = true;
        } else {
          touch(src, v.poster);
        }
      } else {
        touch(src, v.poster);
      }
    }
  }
  if (changed) {
    await persistTab(tabId, enforceCaps(items));
    await updateBadge(tabId);
  }
}

// ---- Offscreen download orchestration (survives popup close) ----
async function ensureOffscreen(): Promise<void> {
  try {
    if (typeof chrome.offscreen?.hasDocument === "function") {
      if (await chrome.offscreen.hasDocument()) return;
    }
  } catch {
    /* fall through to create */
  }
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_URL),
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: "Fetch video segments and assemble the download file after the popup closes.",
    });
  } catch (err) {
    // Already-exists race between concurrent callers.
    if (!(err instanceof Error && /already exists|only one/i.test(err.message))) throw err;
  }
}

async function maybeCloseOffscreen(): Promise<void> {
  await ensureJobsLoaded();
  const running = [...jobMemory.values()].some((j) => j.status === "running");
  if (running) return;
  try {
    if (await chrome.offscreen.hasDocument()) {
      await chrome.offscreen.closeDocument();
    }
  } catch {
    /* best-effort */
  }
}

async function startDownload(
  tabId: number,
  itemUrl: string,
  variantId?: string,
): Promise<DownloadJobState> {
  const items = await getTabItems(tabId);
  const item = items.find((x) => x.url === itemUrl);
  if (!item) throw new Error("Video no longer listed for this tab. Rescan and try again.");
  if (item.drmProtected) throw new Error(item.drmReason ?? "Protected content — cannot download.");
  if (item.type === "blob") throw new Error("Blob/MSE stream — not directly downloadable.");

  const jobId = newJobId();
  let req: DownloadJobRequest;
  if (item.type === "hls" || item.type === "dash") {
    const variant = item.variants?.find((v) => v.id === (variantId ?? item.variants?.[0]?.id)) ?? item.variants?.[0];
    if (!variant) throw new Error(item.error ?? "Manifest not parsed yet — reopen the popup in a moment and retry.");
    if (item.type === "hls") {
      req = { jobId, tabId, kind: "hls", url: variant.url, filename: item.filename, mime: "video/mp2t" };
    } else {
      if (!variant.segments?.length) throw new Error("No segments listed for this DASH variant.");
      req = { jobId, tabId, kind: "dash", url: item.url, segments: variant.segments, filename: item.filename, mime: "video/mp4" };
    }
  } else {
    req = { jobId, tabId, kind: "direct", url: item.url, filename: item.filename };
  }

  const job: DownloadJobState = {
    jobId,
    tabId,
    itemUrl,
    variantId: variantId ?? (req.kind === "direct" ? undefined : item.variants?.[0]?.id),
    filename: req.filename,
    status: "running",
    done: 0,
    total: req.kind === "direct" ? 1 : (req.segments?.length ?? 0),
    updatedAt: Date.now(),
  };
  await upsertJob(job);

  if (req.kind === "direct") {
    // Browser handles natively — no offscreen needed, popup may close safely.
    try {
      await chrome.downloads.download({ url: req.url, filename: req.filename, saveAs: false });
      job.status = "done";
      job.done = 1;
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
    }
    await upsertJob(job);
    return job;
  }

  await ensureOffscreen();
  // Deliver to the offscreen document (content scripts ignore this type).
  // Retry briefly — the document may still be initializing its listener.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await chrome.runtime.sendMessage({ type: "OFFSCREEN_DOWNLOAD", job: req });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (lastErr) {
    job.status = "error";
    job.error = "Background downloader unreachable. Reload the extension and retry.";
    await upsertJob(job);
  }
  return job;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  void (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = msg as any;
      if (m?.type === "GET_MEDIA" && typeof m.tabId === "number") {
        sendResponse({ items: await getTabItems(m.tabId) });
      } else if (m?.type === "GET_JOBS" && typeof m.tabId === "number") {
        sendResponse({ jobs: await getTabJobs(m.tabId) });
      } else if (m?.type === "START_DOWNLOAD" && typeof m.tabId === "number" && typeof m.itemUrl === "string") {
        try {
          const job = await startDownload(m.tabId, m.itemUrl, m.variantId);
          sendResponse({ ok: true, job });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      } else if (m?.type === "VIDEO_ELEMENTS" && typeof m.tabId === "number") {
        const fromSender = sender.tab?.id ?? m.tabId;
        await handleVideoSignals(fromSender, m.videos ?? [], m.pageTitle);
        sendResponse({ ok: true });
      } else if (m?.type === "DOWNLOAD_PROGRESS" && typeof m.jobId === "string") {
        await ensureJobsLoaded();
        const job = jobMemory.get(m.jobId);
        if (job) {
          job.done = m.done ?? job.done;
          job.total = m.total ?? job.total;
          await upsertJob(job, false);
        }
        sendResponse({ ok: true });
      } else if (m?.type === "DOWNLOAD_DONE" && typeof m.jobId === "string") {
        await ensureJobsLoaded();
        const job = jobMemory.get(m.jobId);
        if (job) {
          job.status = "done";
          job.done = job.total || job.done;
          await upsertJob(job);
        }
        void maybeCloseOffscreen();
        sendResponse({ ok: true });
      } else if (m?.type === "DOWNLOAD_ERROR" && typeof m.jobId === "string") {
        await ensureJobsLoaded();
        const job = jobMemory.get(m.jobId);
        if (job) {
          job.status = "error";
          job.error = m.error ?? "Download failed.";
          await upsertJob(job);
        }
        void maybeCloseOffscreen();
        sendResponse({ ok: true });
      } else if (m?.type === "RESCAN" && typeof m.tabId === "number") {
        // Ask the content script to re-collect <video> elements (covers
        // cached pages where webRequest saw nothing new).
        try {
          await chrome.tabs.sendMessage(m.tabId, { type: "COLLECT_NOW" });
        } catch {
          // Content script not injected: inject a one-shot collector.
          try {
            await chrome.scripting.executeScript({
              target: { tabId: m.tabId },
              func: () => {
                const pick = (el: HTMLVideoElement): string[] => {
                  const out: string[] = [];
                  if (el.currentSrc) out.push(el.currentSrc);
                  const s = el.getAttribute("src");
                  if (s) {
                    try {
                      out.push(new URL(s, location.href).toString());
                    } catch {
                      /* ignore */
                    }
                  }
                  el.querySelectorAll("source[src]").forEach((n) => {
                    const v = n.getAttribute("src");
                    if (v) {
                      try {
                        out.push(new URL(v, location.href).toString());
                      } catch {
                        /* ignore */
                      }
                    }
                  });
                  return out;
                };
                const vids = Array.from(document.querySelectorAll("video")).flatMap((v) => {
                  const c = pick(v as HTMLVideoElement);
                  return c.length
                    ? [{ currentSrc: c[0], candidates: c, poster: (v as HTMLVideoElement).poster || undefined }]
                    : [];
                });
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
      } else if (m?.type === "JOB_UPDATED" || m?.type === "OFFSCREEN_DOWNLOAD") {
        // Broadcast/offscreen traffic not addressed to the worker — ignore.
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
