import { cleanTitle, filenameForUrl, sanitizeStem } from "./lib/download";
import type { DownloadJobState, MediaItem, MediaType, MsSessionMeta, VideoSignal } from "./lib/types";

const listEl = document.getElementById("list") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const rescanBtn = document.getElementById("rescan") as HTMLButtonElement;

let currentTabId: number | null = null;
let currentHost = "";
let currentUrl = "";
let workerAlive = false;
let jobs: DownloadJobState[] = [];

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40 ? "…" + u.pathname.slice(-39) : u.pathname;
    return u.host + path;
  } catch {
    return url.slice(0, 60);
  }
}

function variantIsAudioOnly(v: { codecs?: string }): boolean {
  const c = (v.codecs ?? "").toLowerCase();
  return /(mp4a|opus|ec-3|ac-3|ac-4)/.test(c) && !/(avc|hev|hvc|vp0?9|av0?1)/.test(c);
}

function variantLabel(v: { resolution?: string; bandwidth?: number; codecs?: string }, idx: number): string {
  if (variantIsAudioOnly(v)) {
    const rate = v.bandwidth ? ` • ${Math.round(v.bandwidth / 1000)} kbps` : "";
    return `Audio only${rate}`;
  }
  const parts: string[] = [];
  if (v.resolution) {
    // "1920x1080" -> "1080p"
    const m = /(\d+)x(\d+)/.exec(v.resolution);
    parts.push(m ? `${m[2]}p` : v.resolution);
  } else {
    parts.push(`Variant ${idx + 1}`);
  }
  if (v.bandwidth) parts.push(`• ${(v.bandwidth / 1_000_000).toFixed(1)} Mbps`);
  return parts.join(" ");
}

/** Best quality first: height desc, then bandwidth desc. Audio-only last. */
function sortVariants<T extends { resolution?: string; bandwidth?: number; codecs?: string }>(list: T[]): T[] {
  const heightOf = (v: T): number => {
    const m = /(\d+)x(\d+)/.exec(v.resolution ?? "");
    return m ? Number(m[2]) : 0;
  };
  return [...list].sort((a, b) => {
    const aa = variantIsAudioOnly(a) ? 1 : 0;
    const ab = variantIsAudioOnly(b) ? 1 : 0;
    if (aa !== ab) return aa - ab;
    const h = heightOf(b) - heightOf(a);
    if (h !== 0) return h;
    return (b.bandwidth ?? 0) - (a.bandwidth ?? 0);
  });
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out — the background worker may be restarting. Reopen the popup.`)), ms),
    ),
  ]);
}

async function activeTab(): Promise<{ id: number | null; host: string; url: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  const url = tab?.url ?? "";
  try {
    if (url) host = new URL(url).host;
  } catch {
    /* ignore */
  }
  return { id: tab?.id ?? null, host, url };
}

/** Hosts the extension deliberately does not run on (see manifest). */
function unsupportedHostReason(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (/(^|\.)youtube\.com$/.test(h) || /(^|\.)youtu\.be$/.test(h) || /(^|\.)youtube-nocookie\.com$/.test(h)) {
      return "YouTube isn't supported by this extension (its delivery is encrypted/obfuscated). It works on other video sites — open one and try again.";
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Pages where extensions are forbidden from running at all. */
function blockedPageReason(url: string): string | null {
  if (!url) return "No page URL available.";
  if (/^(chrome|edge|about|chrome-extension|opera|brave|vivaldi):/.test(url))
    return "Extensions can't access browser system pages. Open a normal website tab instead.";
  if (/^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com)/.test(url))
    return "Extensions can't run on the Chrome Web Store page.";
  if (/^file:/.test(url))
    return "File URLs need 'Allow access to file URLs' enabled for this extension.";
  return null;
}

/** Local mirror of the worker's chunk rule (page-found URLs need it too). */
function looksLikeChunkBare(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  if (/\.(ts|m4s|cmfv|cmfa)$/.test(path)) return true;
  const tokens = path.split("/").filter(Boolean);
  let score = 0;
  let digitTokens = 0;
  for (const raw of tokens) {
    const t = raw.replace(/\.[a-z0-9]{2,5}$/, "");
    if (/^\d+$/.test(t)) {
      digitTokens++;
      continue;
    }
    if (/\d+x\d+/.test(t)) score += 2;
    if (/^(avc1|mp4a|hev1|hvc1|vp09|av01|ec-3|ec3|ac-3|ac-4|opus)$/.test(t)) score += 2;
    if (/(seg|chunk|frag|part|range|seq|stream|media|track|video|audio)[-_./]?\d/i.test(t)) score += 2;
  }
  score += Math.min(2, digitTokens);
  if (score >= 3) return true;
  if (/\.m4v$/.test(path) && score >= 2) return true;
  return false;
}

function classifyBare(url: string): MediaType | null {
  const lower = url.toLowerCase().split("?")[0].split("#")[0];
  if (lower.endsWith(".m3u8")) return "hls";
  if (lower.endsWith(".mpd")) return "dash";
  if (url.startsWith("blob:")) return "blob";
  if (looksLikeChunkBare(url)) return null;
  if (lower.endsWith(".mp4") || lower.endsWith(".m4v")) return "mp4";
  if (lower.endsWith(".webm")) return "webm";
  if (lower.endsWith(".ogv") || lower.endsWith(".ogg")) return "ogg";
  if (lower.endsWith(".mov")) return "mov";
  if (lower.endsWith(".mkv")) return "mkv";
  if (lower.endsWith(".avi")) return "avi";
  if (lower.endsWith(".flv") || lower.endsWith(".f4v")) return "flv";
  if (lower.endsWith(".wmv")) return "wmv";
  if (lower.endsWith(".mpg") || lower.endsWith(".mpeg")) return "mpg";
  if (lower.endsWith(".3gp") || lower.endsWith(".3g2")) return "mp4";
  return null;
}

/**
 * Worker-independent page scan: ask the tab's content script for its
 * <video> elements directly (no background worker involved). Falls back to
 * a one-shot injected collector when the content script isn't present
 * (e.g. tab hasn't reloaded since install). Never throws.
 */
async function scanPageDirect(tabId: number): Promise<{ videos: VideoSignal[]; msSessions: MsSessionMeta[]; pageTitle?: string }> {
  try {
    const res = await withTimeout(
      chrome.tabs.sendMessage(tabId, { type: "COLLECT_FOR_POPUP" }),
      4000,
      "Page scan",
    );
    if (res?.ok && Array.isArray(res.videos)) {
      return {
        videos: res.videos as VideoSignal[],
        msSessions: Array.isArray(res.msSessions) ? (res.msSessions as MsSessionMeta[]) : [],
        pageTitle: typeof res.pageTitle === "string" ? res.pageTitle : undefined,
      };
    }
  } catch {
    /* no content script in this tab — try one-shot injection */
  }
  try {
    const results = await withTimeout(
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const abs = (raw: string | null): string | null => {
            if (!raw) return null;
            const s = raw.trim();
            if (!s || s.startsWith("data:")) return null;
            try {
              return new URL(s, location.href).toString();
            } catch {
              return null;
            }
          };
          return Array.from(document.querySelectorAll("video")).flatMap((v) => {
            const cands: string[] = [];
            if ((v as HTMLVideoElement).currentSrc) cands.push((v as HTMLVideoElement).currentSrc);
            for (const a of ["src", "data-src", "data-url", "data-video-url"]) {
              const u = abs((v as HTMLVideoElement).getAttribute(a));
              if (u && !cands.includes(u)) cands.push(u);
            }
            v.querySelectorAll("source[src]").forEach((n) => {
              const u = abs(n.getAttribute("src"));
              if (u && !cands.includes(u)) cands.push(u);
            });
            if (!cands.length && !(v as HTMLVideoElement).poster) return [];
            const al = (v as HTMLVideoElement).getAttribute("aria-label") || (v as HTMLVideoElement).getAttribute("title") || undefined;
            return [
              {
                currentSrc: cands[0] ?? "",
                candidates: cands,
                poster: (v as HTMLVideoElement).poster || undefined,
                title: al || document.title || undefined,
              },
            ];
          });
        },
      }),
      6000,
      "Page injection",
    );
    const out: VideoSignal[] = [];
    for (const r of results ?? []) {
      const val = (r as chrome.scripting.InjectionResult)?.result as unknown;
      if (Array.isArray(val)) out.push(...(val as VideoSignal[]));
    }
    return { videos: out, msSessions: [], pageTitle: undefined };
  } catch {
    return { videos: [], msSessions: [], pageTitle: undefined };
  }
}

function mbShort(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Capture sessions -> display items without any worker (same refusal rules
 * as the background: EME-tainted or DRM-page sessions are refused rows).
 */
function domSessionsToItems(
  sessions: MsSessionMeta[],
  tabId: number,
  titleByBlob: Map<string, string>,
  pageTitle?: string,
): MediaItem[] {
  const items: MediaItem[] = [];
  const now = Date.now();
  const pageFallback = cleanTitle(pageTitle);
  for (const s of sessions) {
    if (!s || typeof s.id !== "string") continue;
    const elTitle = s.blobUrl ? cleanTitle(titleByBlob.get(s.blobUrl)) : "";
    const title = elTitle || pageFallback;
    for (const t of s.tracks ?? []) {
      const url = `capture:${s.id}:${t.idx}`;
      const kindLabel = t.kind === "video" ? "video" : t.kind === "audio" ? "audio" : "track";
      const sizeLabel = t.bytes > 0 ? ` • ${mbShort(t.bytes)}` : "";
      if (s.eme) {
        items.push({
          url, tabId, type: "capture", captureRef: `${s.id}:${t.idx}`,
            captureKind: t.kind, filename: "",
          title: title || undefined,
          titleFromPage: title ? !elTitle : undefined,
          detectedAt: now, drmProtected: true,
          drmReason: "Protected content — this player uses an encrypted media path (DRM). Cannot download.",
          meta: `${kindLabel}${sizeLabel} • captured buffer`,
        });
        continue;
      }
      if (s.pageEme) {
        items.push({
          url, tabId, type: "capture", captureRef: `${s.id}:${t.idx}`,
            captureKind: t.kind, filename: "",
          title: title || undefined,
          titleFromPage: title ? !elTitle : undefined,
          detectedAt: now, drmProtected: true,
          drmReason: "This page uses DRM playback, so buffered captures are disabled here to stay safe.",
          meta: `${kindLabel}${sizeLabel} • captured buffer`,
        });
        continue;
      }
      if (t.bytes <= 0) continue;
      const ts = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      items.push({
        url, tabId, type: "capture", captureRef: `${s.id}:${t.idx}`,
            captureKind: t.kind,
        filename: title ? `${sanitizeStem(title)}-${kindLabel}-${ts}.mp4` : `capture-${kindLabel}-${ts}.mp4`,
        title: title || undefined,
        titleFromPage: title ? !elTitle : undefined,
        autoNamed: !title,
        detectedAt: now, drmProtected: false,
        meta: `${kindLabel}${sizeLabel} • captured buffer${s.complete === false ? " • partial" : ""}`,
      });
    }
  }
  return items;
}

/** "1280×720 • 0:34 • playing" (local copy — background has its own). */
function describeDomSignal(v: VideoSignal): string | undefined {
  const parts: string[] = [];
  if (v.width && v.height) parts.push(`${v.width}×${v.height}`);
  if (v.duration != null && Number.isFinite(v.duration) && v.duration > 0) {
    const s = Math.floor(v.duration);
    parts.push(
      s >= 3600
        ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
        : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`,
    );
  }
  if (v.paused === false) parts.push("playing");
  return parts.length ? parts.join(" • ") : undefined;
}

/** Turn raw DOM signals into display items (worker results win on merge). */
function domSignalsToItems(signals: VideoSignal[], tabId: number, pageTitle?: string): MediaItem[] {
  const items: MediaItem[] = [];
  const seen = new Set<string>();
  const pageFallback = cleanTitle(pageTitle);
  for (const v of signals) {
    const meta = describeDomSignal(v);
    const elTitle = cleanTitle(v.title);
    const title = elTitle || pageFallback;
    for (const src of [v.currentSrc, ...(v.candidates ?? [])]) {
      if (!src || seen.has(src)) continue;
      seen.add(src);
      const type = classifyBare(src);
      if (!type) continue;
      if (type === "blob") {
        items.push({
          url: src,
          tabId,
          type: "blob",
          filename: "",
          title: title || undefined,
          titleFromPage: title ? !elTitle : undefined,
          detectedAt: Date.now(),
          drmProtected: false,
          poster: v.poster,
          meta,
          error: "Blob/MSE stream (in-player buffer) — the file is captured from the network when it loads. Play the video, then Rescan.",
        });
      } else if (type === "hls" || type === "dash") {
        items.push({
          url: src,
          tabId,
          type,
          filename: filenameForUrl(src, type, title || undefined),
          title: title || undefined,
          titleFromPage: title ? !elTitle : undefined,
          autoNamed: !title,
          detectedAt: Date.now(),
          drmProtected: false,
          variants: [],
          poster: v.poster,
          meta,
          error: "Found on the page — waiting for the background worker to parse qualities. If the worker is down, reload the extension.",
        });
      } else {
        items.push({
          url: src,
          tabId,
          type,
          filename: filenameForUrl(src, type, title || undefined),
          title: title || undefined,
          titleFromPage: title ? !elTitle : undefined,
          autoNamed: !title,
          detectedAt: Date.now(),
          drmProtected: false,
          poster: v.poster,
          meta,
        });
      }
    }
  }
  return items;
}

function jobForItem(itemUrl: string): DownloadJobState | undefined {
  const related = jobs.filter((j) => j.itemUrl === itemUrl);
  return related.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

function mbPair(done: number, total: number): string {
  const f = (b: number) =>
    b < 1_000_000 ? `${Math.max(0, Math.round(b / 1000))} KB` : `${(b / 1_000_000).toFixed(1)} MB`;
  return total > 0 ? `${f(done)}/${f(total)}` : f(done);
}

function runningText(job: DownloadJobState): string {
  const tail = "(safe to close popup)";
  if (job.itemUrl.startsWith("capture:") || job.itemUrl.startsWith("blob:")) {
    if (job.stage === "assembling") return `Assembling capture… ${tail}`;
    if (job.stage === "saving") return `Saving download… ${tail}`;
    return `Capturing… ${mbPair(job.done, job.total)} ${tail}`;
  }
  if (job.stage === "assembling") return `Assembling file… ${tail}`;
  if (job.stage === "saving") return `Saving download… ${tail}`;
  if (job.total > 1) return `Fetching… ${job.done}/${job.total} segments ${tail}`;
  return `Downloading… ${tail}`;
}

async function loadMedia(): Promise<void> {
  setStatus("Scanning…");
  listEl.innerHTML = "";
  jobs = [];
  workerAlive = false;

  // 1. Find the tab; bail early on pages extensions can't touch.
  let id: number | null;
  try {
    const t = await withTimeout(activeTab(), 5000, "Finding active tab");
    id = t.id;
    currentHost = t.host;
    currentUrl = t.url;
    currentTabId = id;
    if (id == null) {
      setStatus("No active tab found.");
      return;
    }
    const blocked = blockedPageReason(t.url);
    if (blocked) {
      setStatus("");
      const div = document.createElement("div");
      div.className = "empty";
      div.textContent = blocked;
      listEl.appendChild(div);
      return;
    }
    const unsupported = unsupportedHostReason(t.url);
    if (unsupported) {
      setStatus("");
      const div = document.createElement("div");
      div.className = "empty";
      div.textContent = unsupported;
      listEl.appendChild(div);
      return;
    }
  } catch (err) {
    showFatal(err instanceof Error ? err.message : String(err));
    return;
  }

  // 2. Run the worker path and the direct page scan IN PARALLEL — neither
  // may block or kill the other. The popup shows whatever comes back.
  const tabId: number = id;
  const workerPromise = (async (): Promise<MediaItem[]> => {
    await withTimeout(chrome.runtime.sendMessage({ type: "PING" }), 3500, "Ping");
    workerAlive = true;
    const mediaRes = await withTimeout(
      chrome.runtime.sendMessage({ type: "GET_MEDIA", tabId }),
      8000,
      "Reading detections",
    );
    // Jobs are best-effort and never block rendering.
    try {
      const jobsRes = await withTimeout(
        chrome.runtime.sendMessage({ type: "GET_JOBS", tabId }),
        5000,
        "Reading download jobs",
      );
      jobs = jobsRes?.jobs ?? [];
    } catch {
      jobs = [];
    }
    return (mediaRes?.items ?? []) as MediaItem[];
  })();
  const pagePromise = scanPageDirect(tabId);

  const [workerSettled, pageSettled] = await Promise.allSettled([workerPromise, pagePromise]);
  const workerItems = workerSettled.status === "fulfilled" ? workerSettled.value : [];
  const pageScan = pageSettled.status === "fulfilled"
    ? pageSettled.value
    : { videos: [], msSessions: [], pageTitle: undefined };
  const titleByBlob = new Map<string, string>();
  for (const v of pageScan.videos) {
    if (v.currentSrc.startsWith("blob:") && v.title) {
      const t = cleanTitle(v.title);
      if (t) titleByBlob.set(v.currentSrc, t);
    }
  }
  const pageItems = [
    ...domSignalsToItems(pageScan.videos, tabId, pageScan.pageTitle),
    ...domSessionsToItems(pageScan.msSessions, tabId, titleByBlob, pageScan.pageTitle),
  ];

  // Merge: worker detections win on exact URL; page-only signals fill gaps.
  // Extra blob placeholders collapse to one row (all mean "player buffer").
  const byUrl = new Map<string, MediaItem>();
  for (const it of workerItems) byUrl.set(it.url, it);
  for (const it of pageItems) {
    if (byUrl.has(it.url)) continue;
    if (it.type === "blob" && [...byUrl.values()].some((x) => x.type === "blob")) continue;
    byUrl.set(it.url, it);
  }
  const merged = [...byUrl.values()];

  // Production display filter: parsed manifests strictly dominate raw
  // chunk groups and player-buffer placeholders. When at least one HLS/DASH
  // item with qualities exists, blob + segments rows are pure noise — hide
  // them (storage keeps them for manifest-less sites).
  const hasManifest = merged.some(
    (x) => (x.type === "hls" || x.type === "dash") && (x.variants?.length ?? 0) > 0 && !x.drmProtected,
  );
  const items = merged
    .filter((x) => {
      if (!hasManifest) return true;
      return x.type !== "blob" && x.type !== "segments";
    })
    .sort((a, b) => b.detectedAt - a.detectedAt);

  if (!workerAlive && pageItems.length > 0) {
    showWorkerWarning();
  }

  if (items.length === 0) {
    if (!workerAlive) {
      showFatal("Background worker isn't answering, and no <video> found on the page itself.");
      return;
    }
    setStatus("");
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = currentHost
      ? `No video detected on ${currentHost} yet. Play the video, then hit Rescan.`
      : "No video detected yet. Play the video, then hit Rescan.";
    listEl.appendChild(div);
    return;
  }
  const downloadable = items.filter((x) => x.type !== "blob").length;
  setStatus(
    workerAlive
      ? downloadable > 0
        ? `${downloadable} downloadable video${downloadable > 1 ? "s" : ""} detected.`
        : "Found player streams, but no direct file yet — play the video, then Rescan."
      : "Worker unreachable — showing what the page itself exposes. Direct files can still download; qualities need the worker.",
  );
  for (const item of items) listEl.appendChild(renderCard(item));
}

/** Banner (not a dead end): page scan worked, worker didn't. */
function showWorkerWarning(): void {
  const banner = document.createElement("div");
  banner.className = "card";
  const meta = document.createElement("div");
  meta.className = "meta";
  const note = document.createElement("div");
  note.className = "error";
  note.textContent =
    "Background worker isn't answering (it may have crashed). Page-level videos are shown below; direct files can still download. Reload the extension to restore quality lists and background downloads.";
  meta.appendChild(note);
  const reload = document.createElement("button");
  reload.className = "dl";
  reload.textContent = "Reload extension now";
  reload.onclick = () => {
    try {
      chrome.runtime.reload();
    } catch (err) {
      setStatus(`Reload failed: ${err instanceof Error ? err.message : String(err)}. Use chrome://extensions instead.`);
    }
  };
  meta.appendChild(reload);
  banner.appendChild(meta);
  listEl.appendChild(banner);
}

/** Terminal error state — never leave the UI stuck on "Scanning…". */
function showFatal(message: string): void {
  setStatus(message);
  listEl.innerHTML = "";
  const div = document.createElement("div");
  div.className = "empty";
  const p = document.createElement("div");
  p.textContent = "Could not load detections.";
  div.appendChild(p);
  const hint = document.createElement("div");
  hint.className = "url";
  hint.textContent =
    "If this keeps happening: chrome://extensions → Developer mode → this extension → 'Service worker' shows its crash log.";
  div.appendChild(hint);

  const retry = document.createElement("button");
  retry.className = "dl";
  retry.textContent = "Retry";
  retry.onclick = () => void loadMedia();
  div.appendChild(retry);

  const reload = document.createElement("button");
  reload.id = "rescan";
  reload.style.marginTop = "8px";
  reload.textContent = "Reload extension";
  reload.title = "Restart the background worker, then reopen the popup";
  reload.onclick = () => {
    try {
      chrome.runtime.reload();
    } catch (err) {
      setStatus(`Reload failed: ${err instanceof Error ? err.message : String(err)}. Use chrome://extensions instead.`);
    }
  };
  div.appendChild(reload);
  listEl.appendChild(div);
}

function renderCard(item: MediaItem): HTMLElement {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.itemUrl = item.url;

  if (item.poster) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = item.poster;
    img.alt = "";
    card.appendChild(img);
  } else {
    const fb = document.createElement("div");
    fb.className = "thumb-fallback";
    fb.textContent = "▶";
    card.appendChild(fb);
  }

  const meta = document.createElement("div");
  meta.className = "meta";

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = item.type.toUpperCase();
  meta.appendChild(badge);

  if (item.title) {
    const heading = document.createElement("div");
    heading.className = "vtitle";
    heading.textContent = item.title;
    heading.title = item.title;
    meta.appendChild(heading);
  }

  const urlDiv = document.createElement("div");
  urlDiv.className = "url";
  urlDiv.textContent = shortUrl(item.url);
  urlDiv.title = item.url;
  meta.appendChild(urlDiv);

  if (item.meta) {
    const metaLine = document.createElement("div");
    metaLine.className = "url";
    metaLine.textContent = item.meta;
    meta.appendChild(metaLine);
  }

  // Copy-link needs a real URL (blob:/capture: rows have none fetchable).
  if (item.type !== "blob" && item.type !== "capture" && item.type !== "blobfile") {
    const copy = document.createElement("button");
    copy.className = "ghost";
    copy.textContent = "Copy link";
    copy.title = "Copy the video URL to the clipboard";
    copy.onclick = () => void copyLink(item.url, copy);
    meta.appendChild(copy);
  }

  if (item.error && !item.variants?.length && !isDirect(item)) {
    const e = document.createElement("div");
    e.className = "error";
    e.textContent = item.error;
    meta.appendChild(e);
  }

  if (item.drmProtected) {
    const p = document.createElement("div");
    p.className = "protected";
    p.textContent = item.drmReason ?? "Protected content — cannot download.";
    meta.appendChild(p);
  } else if (isDirect(item)) {
    const btn = document.createElement("button");
    btn.className = "dl";
    btn.textContent = "Download";
    btn.onclick = () => void handleStartDownload(item, undefined, btn);
    meta.appendChild(btn);
  } else if (item.type === "hls" || item.type === "dash") {
    if (!item.variants || item.variants.length === 0) {
      const note = document.createElement("div");
      note.className = "error";
      note.textContent = item.error ?? "Parsing manifest… reopen popup in a moment.";
      meta.appendChild(note);
    } else {
      // Best quality first, preselected — one click downloads the best.
      const ordered = sortVariants(item.variants);
      const btn = document.createElement("button");
      btn.className = "dl";
      if (ordered.length === 1) {
        btn.textContent = `Download (${variantLabel(ordered[0], 0)})`;
        btn.onclick = () => void handleStartDownload(item, ordered[0].id, btn);
        meta.appendChild(btn);
      } else {
        const sel = document.createElement("select");
        ordered.forEach((v, i) => {
          const opt = document.createElement("option");
          opt.value = v.id;
          opt.textContent = variantLabel(v, i);
          sel.appendChild(opt);
        });
        const existing = jobForItem(item.url);
        if (existing?.variantId) {
          const idx = ordered.findIndex((v) => v.id === existing.variantId);
          if (idx >= 0) sel.selectedIndex = idx;
        }
        meta.appendChild(sel);

        btn.textContent = "Download";
        btn.onclick = () => void handleStartDownload(item, sel.value, btn);
        meta.appendChild(btn);
      }
    }
  } else if (item.type === "segments") {
    const n = item.segments?.length ?? 0;
    if (n === 0) {
      const note = document.createElement("div");
      note.className = "error";
      note.textContent = item.error ?? "Grouped player chunks expired — play the video, then Rescan.";
      meta.appendChild(note);
    } else {
      const btn = document.createElement("button");
      btn.className = "dl";
      btn.textContent = `Download (${n} grouped chunks)`;
      btn.onclick = () => void handleStartDownload(item, undefined, btn);
      meta.appendChild(btn);
    }
  } else if (item.type === "capture") {
    // DRM-protected captures are handled by the drmProtected branch above.
    const btn = document.createElement("button");
    btn.className = "dl";
    btn.textContent = "Download capture";
    btn.title = "Download the exact bytes the player buffered (lossless)";
    btn.onclick = () => void handleStartDownload(item, undefined, btn);
    meta.appendChild(btn);
  } else if (item.type === "blob") {
    const note = document.createElement("div");
    note.className = "error";
    note.textContent = item.error ?? "Blob stream — not directly downloadable.";
    meta.appendChild(note);
  }

  const prog = document.createElement("div");
  prog.className = "progress";
  prog.hidden = true;
  meta.appendChild(prog);

  card.appendChild(meta);
  paintJobState(card, item);
  return card;
}

const DIRECT_BADGES = new Set(["MP4", "WEBM", "OGG", "MOV", "MKV", "AVI", "FLV", "WMV", "MPG", "BLOBFILE"]);

function isDirect(item: MediaItem): boolean {
  return DIRECT_BADGES.has(item.type.toUpperCase());
}

function jobLine(job: DownloadJobState, direct: boolean): { label: string; state: string } {
  if (job.status === "running") return { label: runningText(job), state: "running" };
  if (job.status === "done") return { label: "Done — check your downloads folder.", state: "done" };
  if (/cancelled/i.test(job.error ?? "")) return { label: "Cancelled.", state: "cancelled" };
  return { label: `Failed: ${job.error ?? "unknown error"}`, state: "error" };
}

function paintJobButtons(card: HTMLElement, job: DownloadJobState | undefined, direct: boolean): void {
  let cancel = card.querySelector("button.cancelbtn") as HTMLButtonElement | null;
  // Direct downloads finish near-instantly via the browser — cancel only
  // makes sense for multi-segment HLS/DASH jobs. Page-blob ("blobfile")
  // downloads stream slices for a while, so they keep Cancel too.
  const isBlobFile = (card.dataset.itemUrl ?? "").startsWith("blob:");
  const showCancel = job?.status === "running" && (!direct || isBlobFile);
  if (showCancel) {
    if (!cancel) {
      const jid = job.jobId;
      cancel = document.createElement("button");
      cancel.className = "ghost cancelbtn";
      cancel.textContent = "Cancel";
      cancel.onclick = () => void cancelJob(jid);
      card.querySelector(".meta")?.appendChild(cancel);
    }
    cancel.hidden = false;
  } else if (cancel) {
    cancel.hidden = true;
  }
}

/** Reflect the latest known job for this item (survives popup reopen). */
function paintJobState(card: HTMLElement, item: MediaItem): void {
  const prog = card.querySelector(".progress") as HTMLElement | null;
  const btn = card.querySelector("button.dl") as HTMLButtonElement | null;
  if (!prog || !btn) return;
  const job = jobForItem(item.url);
  if (!job) {
    prog.hidden = true;
    btn.disabled = false;
    return;
  }
  const direct = isDirect(item);
  const line = jobLine(job, direct);
  if (line.state === "running") {
    btn.disabled = true;
    prog.hidden = false;
    prog.textContent = line.label;
  } else if (line.state === "done") {
    btn.disabled = false;
    btn.textContent = direct ? "Download again" : "Download variant again";
    prog.hidden = false;
    prog.textContent = line.label;
  } else {
    btn.disabled = false;
    prog.hidden = false;
    prog.textContent = line.label;
  }
  paintJobButtons(card, job, direct);
}

function refreshCard(itemUrl: string): void {
  const card = listEl.querySelector(`[data-item-url="${CSS.escape(itemUrl)}"]`) as HTMLElement | null;
  if (!card) return;
  const prog = card.querySelector(".progress") as HTMLElement | null;
  const btn = card.querySelector("button.dl") as HTMLButtonElement | null;
  if (!prog || !btn) return;
  const job = jobForItem(itemUrl);
  if (!job) return;
  const badge = card.querySelector(".badge")?.textContent ?? "";
  const direct = DIRECT_BADGES.has(badge);
  const line = jobLine(job, direct);
  if (line.state === "running") {
    btn.disabled = true;
    prog.hidden = false;
    prog.textContent = line.label;
  } else if (line.state === "done") {
    btn.disabled = false;
    btn.textContent = direct ? "Download again" : "Download variant again";
    prog.hidden = false;
    prog.textContent = line.label;
  } else {
    btn.disabled = false;
    prog.hidden = false;
    prog.textContent = line.label;
  }
  paintJobButtons(card, job, direct);
}

async function cancelJob(jobId: string): Promise<void> {
  try {
    await withTimeout(
      chrome.runtime.sendMessage({ type: "CANCEL_JOB", jobId }),
      8000,
      "Cancelling",
    );
    setStatus("Cancelling…");
  } catch (err) {
    setStatus(`Cancel failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function copyLink(url: string, btn: HTMLButtonElement): Promise<void> {
  const done = (msg: string) => {
    const orig = "Copy link";
    btn.textContent = msg;
    setTimeout(() => {
      btn.textContent = orig;
    }, 1500);
  };
  try {
    await navigator.clipboard.writeText(url);
    done("Copied!");
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      done("Copied!");
    } catch {
      setStatus("Copy failed — right-click the URL text to copy manually.");
      done("Copy link");
    }
  }
}

async function handleStartDownload(
  item: MediaItem,
  variantId: string | undefined,
  btn: HTMLButtonElement,
): Promise<void> {
  if (currentTabId == null) {
    setStatus("No active tab found.");
    return;
  }
  btn.disabled = true;
  // Preferred path: background worker (tracks jobs, offscreen for HLS/DASH).
  if (workerAlive && currentTabId != null) {
    try {
      const res = await withTimeout(
        chrome.runtime.sendMessage({
          type: "START_DOWNLOAD",
          tabId: currentTabId,
          itemUrl: item.url,
          variantId,
        }),
        15000,
        "Starting download",
      );
      if (!res?.ok) {
        // Worker knows the item but refused (e.g. DRM, unknown variant):
        // surface its reason, but still allow the direct fallback below
        // when the worker simply doesn't know this page-found URL.
        const reason: string = res?.error ?? "unknown error";
        if (workerAlive && isDirect(item) && item.type !== "blobfile" && /no longer listed|Unknown message/i.test(reason)) {
          await downloadDirectFallback(item, btn);
          return;
        }
        setStatus(`Download failed: ${reason}`);
        btn.disabled = false;
        return;
      }
      const job = res.job as DownloadJobState;
      jobs = [job, ...jobs.filter((j) => j.jobId !== job.jobId)];
      if (item.type === "hls" || item.type === "dash" || item.type === "segments" || item.type === "capture") {
        setStatus(
          res.merged
            ? "Merging video + audio into one file with sound — you can close this popup."
            : res.paired
              ? "Downloading video + audio as 2 files (this stream can't be merged in-app) — you can close this popup."
              : `Download running in background for ${item.filename || filenameForUrl(item.url, item.type)} — you can close this popup.`,
        );
      } else {
        setStatus("Download started.");
      }
      refreshCard(item.url);
      return;
    } catch (err) {
      // Worker call failed — fall through to the direct fallback.
      workerAlive = false;
      void err;
    }
  }
  // Fallback path (worker unreachable): direct files need no worker —
  // the popup can hand the URL to chrome.downloads itself. Page-held blobs
  // are NOT fetchable from here (blob: URLs are page-scoped), so blobfile
  // items always need the worker.
  if (isDirect(item) && item.type !== "blobfile") {
    await downloadDirectFallback(item, btn);
    return;
  }
  setStatus("Download failed: background worker isn't answering (needed for HLS/DASH/grouped/capture/page-blob downloads). Reload the extension and retry.");
  btn.disabled = false;
}

/** Worker-independent download for direct files. */
async function downloadDirectFallback(item: MediaItem, btn: HTMLButtonElement): Promise<void> {
  try {
    await chrome.downloads.download({
      url: item.url,
      filename: item.filename || filenameForUrl(item.url, item.type),
      saveAs: false,
    });
    setStatus("Download started.");
    const card = listEl.querySelector(`[data-item-url="${CSS.escape(item.url)}"]`);
    const prog = card?.querySelector(".progress") as HTMLElement | null;
    if (prog) {
      prog.hidden = false;
      prog.textContent = "Done — check your downloads folder.";
    }
  } catch (err) {
    setStatus(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    btn.disabled = false;
  }
}

// Live updates while the popup stays open (optional — state persists regardless).
chrome.runtime.onMessage.addListener((msg) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = msg as any;
  if (m?.type === "JOB_UPDATED" && m.job) {
    const job = m.job as DownloadJobState;
    jobs = [job, ...jobs.filter((j) => j.jobId !== job.jobId)];
    refreshCard(job.itemUrl);
  }
  return false;
});

rescanBtn.onclick = () => {
  void (async () => {
    setStatus("Rescanning…");
    if (currentTabId == null) {
      const t = await activeTab();
      currentTabId = t.id;
      currentHost = t.host;
      currentUrl = t.url;
    }
    if (currentTabId == null) {
      setStatus("No active tab found.");
      return;
    }
    try {
      await withTimeout(
        chrome.runtime.sendMessage({ type: "RESCAN", tabId: currentTabId }),
        8000,
        "Rescan",
      );
      // Give the content script a moment to report back, then reload list.
      setTimeout(() => void loadMedia(), 900);
    } catch (err) {
      setStatus(`Rescan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
};

void loadMedia();
