import { BLOB_PLACEHOLDER_HINT } from "./lib/blobResolve";
import { classify as classifyBare } from "./lib/classify";
import { cleanTitle, filenameForUrl, sanitizeStem } from "./lib/download";
import { basenameOf } from "./lib/filename";
import { formatBytes, formatDuration, formatEta, formatProgressPair, formatSpeed } from "./lib/format";
import { forDisplay } from "./lib/target";
import type {
  BatchSnapshot,
  DownloadJobState,
  MediaItem,
  MediaType,
  MsSessionMeta,
  VideoSignal,
} from "./lib/types";

const listEl = document.getElementById("list") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const rescanBtn = document.getElementById("rescan") as HTMLButtonElement;
const searchEl = document.getElementById("search") as HTMLInputElement | null;
const countEl = document.getElementById("count") as HTMLElement | null;
const selectToggleBtn = document.getElementById("select-toggle") as HTMLButtonElement;
const settingsBtn = document.getElementById("settings") as HTMLButtonElement;
const batchEl = document.getElementById("batch") as HTMLElement;
const batchCountEl = document.getElementById("batch-count") as HTMLElement;
const batchStartBtn = document.getElementById("batch-start") as HTMLButtonElement;
const batchAllBtn = document.getElementById("batch-all") as HTMLButtonElement;
const batchClearBtn = document.getElementById("batch-clear") as HTMLButtonElement;
const queueEl = document.getElementById("queue") as HTMLElement;

let currentTabId: number | null = null;
let currentHost = "";
let currentUrl = "";
let workerAlive = false;
let jobs: DownloadJobState[] = [];
let totalCards = 0;

/** Batch selection mode + which item URLs are ticked. */
let selectMode = false;
const selected = new Set<string>();
/** Latest queue aggregate from the worker (drives the queue line). */
let batchSnapshot: BatchSnapshot | null = null;
let lastQueueActive = false;

/** Inline SVG icons (no emoji, no remote assets — extension sandbox safe). */
const ICONS: Record<string, string> = {
  play: '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
  copy: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  download:
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  search:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  alert:
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
};

/**
 * Failed state row. `retry` adds a button that re-reads the manifest forcing a
 * fresh attempt — the worker tries the page's own request context first, which
 * is the path that works on Referer/Origin/token-gated CDNs.
 */
function errorRow(message: string, retry?: MediaItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "error";
  const text = document.createElement("span");
  text.className = "error-text";
  text.textContent = message;
  row.appendChild(text);
  if (retry) {
    const btn = document.createElement("button");
    btn.className = "retry-btn";
    btn.textContent = "Retry";
    btn.title = "Read the stream list again using this page's own session";
    btn.onclick = () => void retryParseManifest(retry, btn, text);
    row.appendChild(btn);
  }
  return row;
}

/** Re-read one item's manifest (fresh read) and repaint on success. */
async function retryParseManifest(
  item: MediaItem,
  btn: HTMLButtonElement,
  label: HTMLElement,
): Promise<void> {
  if (currentTabId == null) return;
  btn.disabled = true;
  label.textContent = "Re-reading the stream list…";
  try {
    const res = (await withTimeout(
      chrome.runtime.sendMessage({ type: "RETRY_PARSE", tabId: currentTabId, itemUrl: item.url }),
      25000,
      "Retry",
    )) as { ok?: boolean; error?: string } | undefined;
    if (res?.ok) {
      setStatus("Stream list loaded.");
      await loadMedia();
      return;
    }
    label.textContent =
      res?.error ?? "Still unreadable. Play the video for a few seconds, then Retry again.";
  } catch (err) {
    label.textContent = `Retry failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    btn.disabled = false;
  }
}

function iconSpan(name: string, cls: string): HTMLElement {
  const s = document.createElement("span");
  s.className = cls;
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name] ?? "";
  return s;
}

/** Fraction 0..1 of job completion, or null when indeterminate. */
function jobFraction(job: DownloadJobState): number | null {
  if (job.status === "done") return 1;
  if (job.stage === "assembling" || job.stage === "saving") return null;
  if (job.unit === "bytes") {
    if (job.total > 0 && job.done >= 0) {
      return Math.min(0.999, job.done / job.total);
    }
    return (job.bytesDone ?? 0) > 0 ? null : 0;
  }
  if (job.total > 0) return Math.min(0.999, job.done / job.total);
  return null;
}

/** Paint the card's progress bar + state hook from a job line state. */
function setBar(card: HTMLElement, job: DownloadJobState | undefined, state: string): void {
  const bar = card.querySelector(".bar") as HTMLElement | null;
  const fill = card.querySelector(".bar-fill") as HTMLElement | null;
  if (!bar || !fill) return;
  card.dataset.state = state === "idle" ? "" : state;
  if (!job || state === "idle" || state === "cancelled") {
    bar.hidden = true;
    bar.classList.remove("indeterminate");
    bar.removeAttribute("aria-valuenow");
    return;
  }
  bar.hidden = false;
  const frac = jobFraction(job);
  if (frac == null) {
    bar.classList.add("indeterminate");
    bar.removeAttribute("aria-valuenow");
  } else {
    bar.classList.remove("indeterminate");
    fill.style.width = `${Math.round(frac * 100)}%`;
    bar.setAttribute("aria-valuenow", String(Math.round(frac * 100)));
  }
  if (state === "done") {
    fill.style.width = "100%";
    bar.setAttribute("aria-valuenow", "100");
  }
  if (state === "error") {
    const f = jobFraction(job);
    fill.style.width = f == null ? "100%" : `${Math.round(f * 100)}%`;
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40 ? "…" + u.pathname.slice(-39) : u.pathname;
    // Query strings often carry the per-video id (?id=…, ?token=…) — without
    // them, sibling cards from one endpoint look identical.
    const q = u.search.length > 1
      ? u.search.slice(0, 15) + (u.search.length > 15 ? "…" : "")
      : "";
    return u.host + path + q;
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

/**
 * How many bandwidth probes one popup session may start. Each probe costs a
 * few hundred KB, and the answer is only a hint — keep it cheap.
 */
const MAX_PROBES_PER_SESSION = 3;
let probesStarted = 0;

/**
 * Badge the variant this connection can comfortably sustain. The worker
 * measures the first few segments (cached per item) and recommends the highest
 * quality that fits; we append a "Recommended" marker to that option without
 * disturbing the user's preselection. Silent on every failure path — a missing
 * recommendation must never be an error, just an absent hint.
 */
async function markRecommendedQuality(item: MediaItem, sel: HTMLSelectElement): Promise<void> {
  if (probesStarted >= MAX_PROBES_PER_SESSION) return;
  probesStarted++;
  try {
    const res = (await withTimeout(
      chrome.runtime.sendMessage({ type: "PROBE_QUALITY", tabId: item.tabId, itemUrl: item.url }),
      20_000,
      "Speed check",
    )) as { ok?: boolean; recommendedId?: string; bps?: number } | undefined;
    if (!res?.ok || !res.recommendedId) return;
    const opt = Array.from(sel.options).find((o) => o.value === res.recommendedId);
    if (!opt || /Recommended/.test(opt.textContent ?? "")) return;
    opt.textContent = `${opt.textContent} (recommended)`;
    if (typeof res.bps === "number" && res.bps > 0) {
      sel.title = `Based on a measured ${formatSpeed(res.bps)} connection`;
    }
  } catch {
    /* no recommendation is a normal outcome (cached/auth-gated/offline) */
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out. The background worker may be restarting. Reopen the popup.`)), ms),
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
      return "YouTube isn't supported by this extension (its delivery is encrypted). It works on other video sites. Open one and try again.";
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

/**
 * Worker-independent page scan: ask the tab's content script for its
 * <video> elements directly (no background worker involved). Falls back to
 * a one-shot injected collector when the content script isn't present
 * (e.g. tab hasn't reloaded since install). Never throws.
 */
async function scanPageDirect(tabId: number): Promise<{
  videos: VideoSignal[];
  msSessions: MsSessionMeta[];
  pageTitle?: string;
  adapterItems: MediaItem[];
}> {
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
        adapterItems: Array.isArray(res.adapterItems) ? (res.adapterItems as MediaItem[]) : [],
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
    return { videos: out, msSessions: [], pageTitle: undefined, adapterItems: [] };
  } catch {
    return { videos: [], msSessions: [], pageTitle: undefined, adapterItems: [] };
  }
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
      const sizeLabel = t.bytes > 0 ? ` • ${formatBytes(t.bytes)}` : "";
      if (s.eme) {
        items.push({
          url, tabId, type: "capture", captureRef: `${s.id}:${t.idx}`,
            captureKind: t.kind, filename: "",
          title: title || undefined,
          titleFromPage: title ? !elTitle : undefined,
          detectedAt: now, drmProtected: true,
          drmReason: "Protected content. This player uses an encrypted media path (DRM). Cannot download.",
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
  const duration = formatDuration(v.duration);
  if (duration) parts.push(duration);
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
      const type = classifyBare(src, "");
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
          error: BLOB_PLACEHOLDER_HINT,
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
          error: "Found on the page. Waiting for the background worker to parse qualities. If the worker is down, reload the extension.",
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
  return jobsForItem(itemUrl)[0];
}

/** All jobs for one card, newest first (paired A/V downloads create two). */
function jobsForItem(itemUrl: string): DownloadJobState[] {
  return jobs
    .filter((j) => j.itemUrl === itemUrl)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** The job whose fraction best represents the card (furthest active part). */
function barJob(related: DownloadJobState[]): DownloadJobState | undefined {
  const active = related.filter((j) => j.status === "running" || j.status === "paused");
  const pool = active.length > 0 ? active : related;
  let best: DownloadJobState | undefined;
  let bestFrac = -1;
  for (const j of pool) {
    const f = jobFraction(j) ?? 0;
    if (f >= bestFrac) {
      bestFrac = f;
      best = j;
    }
  }
  return best;
}

/**
 * Combined label for cards with two active part-jobs (split A/V two-file
 * downloads share one itemUrl). Without this the card flickers between the
 * two jobs on every progress tick.
 */
function combinedLine(related: DownloadJobState[], direct: boolean): { label: string; state: string } {
  const active = related.filter((j) => j.status === "running" || j.status === "paused");
  if (active.length > 1) {
    const anyRunning = active.some((j) => j.status === "running");
    const segs = active.map((j) => `${j.done}/${j.total}`).join(" + ");
    const bytes = active.reduce((n, j) => n + (j.bytesDone ?? 0), 0);
    const mb = bytes > 0 ? ` • ${formatBytes(bytes)}` : "";
    const tail = "(safe to close popup)";
    if (!anyRunning) return { label: `Paused (${segs} segments). Resume to continue.`, state: "paused" };
    return { label: `Fetching 2 parts… ${segs} segments${mb} ${tail}`, state: "running" };
  }
  // One part still active while its sibling finished: keep showing progress,
  // never a premature "Done".
  if (active.length === 1) return jobLine(active[0], direct);
  if (related.length > 1 && related.every((j) => j.status === "done")) {
    const note = related.find((j) => j.note)?.note;
    return { label: `Done. Check your downloads folder.${note ? ` ${note}` : ""}`, state: "done" };
  }
  const job = related[0];
  if (!job) return { label: "", state: "idle" };
  return jobLine(job, direct);
}

/**
 * Speed + ETA for the progress line. Prefers the worker's rolling rate
 * (`rateBps`, a short sliding window) so the number reflects the transfer right
 * now; falls back to a cumulative average for rows from older sessions. ETA is
 * exact for byte streams and an average-segment extrapolation for playlists.
 */
function speedEta(job: DownloadJobState): string {
  const bytes = job.bytesDone ?? 0;
  if (bytes < 50_000) return "";
  const elapsed = Math.max(1, (Date.now() - (job.startedAt ?? job.updatedAt ?? Date.now())) / 1000);
  const rate = job.rateBps && job.rateBps > 0 ? job.rateBps : bytes / elapsed;
  const speedStr = formatSpeed(rate);
  if (!speedStr) return "";
  let remaining: number | undefined;
  if (job.unit === "bytes") {
    if (job.total > 0) remaining = Math.max(0, job.total - (job.bytesDone ?? job.done));
  } else if (job.done >= 2 && job.total > job.done) {
    remaining = (bytes / job.done) * (job.total - job.done);
  }
  if (remaining == null || remaining <= 0) return ` • ${speedStr}`;
  const eta = formatEta(remaining / rate);
  return ` • ${speedStr}${eta ? ` • ${eta}` : ""}`;
}

function runningText(job: DownloadJobState): string {
  const tail = "(safe to close popup)";
  if (job.status === "paused") {
    const segs = job.total > 1 ? ` ${job.done}/${job.total} segments` : "";
    return `Paused${segs}. Resume to continue.`;
  }
  if (job.itemUrl.startsWith("capture:") || job.itemUrl.startsWith("blob:")) {
    if (job.stage === "assembling") return `Assembling capture… ${tail}`;
    if (job.stage === "saving") return `Saving download… ${tail}`;
    return `Capturing… ${formatProgressPair(job.done, job.total)} ${tail}`;
  }
  // Direct single-stream downloads report raw bytes (done/total are bytes,
  // total may be 0 when the server omits content-length).
  if (job.unit === "bytes") {
    if (job.stage === "assembling") return `Assembling file… ${tail}`;
    if (job.stage === "saving") return `Saving download… ${tail}`;
    const have = formatBytes(job.bytesDone ?? job.done);
    const want = job.total > 0 ? `/${formatBytes(job.total)}` : "";
    return `Downloading… ${have}${want}${speedEta(job)} ${tail}`;
  }
  if (job.stage === "assembling") return `Assembling file… ${tail}`;
  if (job.stage === "saving") return `Saving download… ${tail}`;
  if (job.total > 1) {
    const mb = job.bytesDone && job.bytesDone > 0 ? ` • ${formatBytes(job.bytesDone)}` : "";
    return `Fetching… ${job.done}/${job.total} segments${mb}${speedEta(job)} ${tail}`;
  }
  return `Downloading… ${tail}`;
}

async function loadMedia(): Promise<void> {
  setStatus("Scanning…");
  listEl.innerHTML = "";
  jobs = [];
  totalCards = 0;
  updateCount();
  workerAlive = false;
  selected.clear();
  batchSnapshot = null;
  lastQueueActive = false;
  renderQueue();
  updateBatchBar();

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
      div.appendChild(iconSpan("alert", "empty-icon"));
      const bt = document.createElement("div");
      bt.className = "empty-title";
      bt.textContent = "Can't run here";
      div.appendChild(bt);
      const bm = document.createElement("div");
      bm.className = "url";
      bm.textContent = blocked;
      div.appendChild(bm);
      listEl.appendChild(div);
      totalCards = 0;
      updateCount();
      return;
    }
    const unsupported = unsupportedHostReason(t.url);
    if (unsupported) {
      setStatus("");
      const div = document.createElement("div");
      div.className = "empty";
      div.appendChild(iconSpan("alert", "empty-icon"));
      const ut = document.createElement("div");
      ut.className = "empty-title";
      ut.textContent = "Not supported on this site";
      div.appendChild(ut);
      const um = document.createElement("div");
      um.className = "url";
      um.textContent = unsupported;
      div.appendChild(um);
      listEl.appendChild(div);
      totalCards = 0;
      updateCount();
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
  let workerItems = workerSettled.status === "fulfilled" ? workerSettled.value : [];
  const pageScan = pageSettled.status === "fulfilled"
    ? pageSettled.value
    : { videos: [], msSessions: [], pageTitle: undefined, adapterItems: [] };
  // COLLECT_FOR_POPUP pushes VIDEO_ELEMENTS (blobs/captures) before it
  // answers — re-read so a blob: player that just became downloadable
  // shows a button instead of the placeholder error.
  if (workerAlive) {
    try {
      const mediaRes = await withTimeout(
        chrome.runtime.sendMessage({ type: "GET_MEDIA", tabId }),
        4000,
        "Refreshing detections",
      );
      if (Array.isArray(mediaRes?.items)) workerItems = mediaRes.items as MediaItem[];
    } catch {
      /* keep the first worker snapshot */
    }
  }
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

  // Merge: worker detections win on exact URL unless the worker row is still
  // a blob placeholder and the page has a real row for the same URL.
  // Adapter items are authoritative rows from a specialized extractor.
  // Extra blob placeholders collapse to one row (all mean "player buffer").
  const byUrl = new Map<string, MediaItem>();
  for (const it of workerItems) byUrl.set(it.url, it);
  for (const it of pageItems) {
    const prev = byUrl.get(it.url);
    if (prev) {
      if (prev.type === "blob" && it.type !== "blob") byUrl.set(it.url, it);
      continue;
    }
    if (it.type === "blob" && [...byUrl.values()].some((x) => x.type === "blob")) continue;
    byUrl.set(it.url, it);
  }
  const adapterIds = new Set<string>();
  for (const it of pageScan.adapterItems ?? []) {
    if (!it || typeof it.url !== "string" || adapterIds.has(it.url)) continue;
    adapterIds.add(it.url);
    const row: MediaItem = {
      ...it,
      tabId,
      pageTitle: it.pageTitle ?? pageScan.pageTitle,
    };
    byUrl.set(it.url, row);
  }
  const merged = [...byUrl.values()];

  const items = forDisplay(merged).sort((a, b) => b.detectedAt - a.detectedAt);

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
    div.appendChild(iconSpan("search", "empty-icon"));
    const title = document.createElement("div");
    title.className = "empty-title";
    title.textContent = currentHost ? `No video on ${currentHost} yet` : "No video detected yet";
    div.appendChild(title);
    const steps = document.createElement("div");
    steps.className = "hint-steps";
    steps.innerHTML = "";
    const s1 = document.createElement("div");
    s1.innerHTML = "<b>1.</b> Play the video on the page";
    const s2 = document.createElement("div");
    s2.innerHTML = "<b>2.</b> Hit Rescan up top";
    const s3 = document.createElement("div");
    s3.innerHTML = "<b>3.</b> Pick a quality and download";
    steps.append(s1, s2, s3);
    div.appendChild(steps);
    listEl.appendChild(div);
    totalCards = 0;
    updateCount();
    return;
  }
  // Every non-DRM row is actionable now (a blob row resolves its source at
  // click time), so the nudge is only for a page with nothing downloadable.
  const usable = items.filter((x) => !x.drmProtected).length;
  setStatus(
    workerAlive
      ? usable > 0
        ? ""
        : "Every video on this page is DRM-protected — these can't be downloaded."
      : "Worker unreachable. Direct files can still download; quality lists need a reload.",
  );
  for (const item of items) listEl.appendChild(renderCard(item));
  totalCards = items.length;
  if (searchEl) searchEl.value = "";
  applyFilter();
}

/** Toolbar: live-filter cards by title/URL/type + count pill. */
function applyFilter(): void {
  const q = (searchEl?.value ?? "").trim().toLowerCase();
  let visible = 0;
  for (const child of Array.from(listEl.children)) {
    const el = child as HTMLElement;
    if (!el.dataset?.itemUrl) continue; // banners / empty notes stay as-is
    const hit = !q || (el.dataset.search ?? "").includes(q);
    el.hidden = !hit;
    if (hit) visible++;
  }
  updateCount(visible);
  let none = listEl.querySelector(".empty-filter") as HTMLElement | null;
  if (visible === 0 && totalCards > 0) {
    if (!none) {
      none = document.createElement("div");
      none.className = "empty empty-filter";
      none.appendChild(iconSpan("search", "empty-icon"));
      const t = document.createElement("div");
      t.className = "empty-title";
      t.textContent = "No videos match this filter.";
      none.appendChild(t);
      listEl.appendChild(none);
    }
    none.hidden = false;
  } else if (none) {
    none.hidden = true;
  }
}

function updateCount(visible?: number): void {
  if (!countEl) return;
  if (totalCards <= 0) {
    countEl.textContent = "";
    countEl.hidden = true;
    return;
  }
  countEl.hidden = false;
  const v = visible ?? totalCards;
  countEl.textContent = v === totalCards ? `${totalCards}` : `${v}/${totalCards}`;
  countEl.title = `${v} of ${totalCards} videos shown`;
}

/** Banner (not a dead end): page scan worked, worker didn't. */
function showWorkerWarning(): void {
  const banner = document.createElement("div");
  banner.className = "card notice";
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
  totalCards = 0;
  updateCount();
  const div = document.createElement("div");
  div.className = "empty";
  div.appendChild(iconSpan("alert", "empty-icon"));
  const p = document.createElement("div");
  p.className = "empty-title";
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

// ---- batch selection ------------------------------------------------------

/** Items that make sense in a batch: real downloads, never DRM rows. */
function isSelectable(item: MediaItem): boolean {
  if (item.drmProtected) return false;
  if (item.type === "hls" || item.type === "dash") return (item.variants?.length ?? 0) > 0;
  if (item.type === "segments") return (item.segments?.length ?? 0) > 0;
  return true;
}

function cards(): HTMLElement[] {
  return Array.from(listEl.querySelectorAll<HTMLElement>(".card[data-item-url]"));
}

function cardFor(url: string): HTMLElement | null {
  return listEl.querySelector<HTMLElement>(`[data-item-url="${CSS.escape(url)}"]`);
}

function updateBatchBar(): void {
  if (!selectMode) return;
  const n = selected.size;
  batchCountEl.textContent =
    n === 0 ? "Select videos to download together" : `${n} selected`;
  batchStartBtn.disabled = n === 0;
  batchStartBtn.textContent = n > 0 ? `Download ${n} selected` : "Download selected";
}

function setSelectMode(on: boolean): void {
  selectMode = on;
  selectToggleBtn.setAttribute("aria-pressed", String(on));
  batchEl.hidden = !on;
  if (!on) selected.clear();
  for (const card of cards()) {
    const pick = card.querySelector<HTMLInputElement>("input.pick");
    if (!pick) continue;
    pick.hidden = !on;
    pick.checked = selected.has(card.dataset.itemUrl ?? "");
    card.classList.toggle("pickable", on);
    card.classList.toggle("selected", pick.checked);
  }
  if (on) setStatus("Pick the videos you want, then hit Download selected. They queue 2 at a time.");
  updateBatchBar();
}

function toggleSelected(url: string, on: boolean): void {
  if (on) selected.add(url);
  else selected.delete(url);
  const card = cardFor(url);
  if (card) {
    card.classList.toggle("selected", on);
    const pick = card.querySelector<HTMLInputElement>("input.pick");
    if (pick) pick.checked = on;
  }
  updateBatchBar();
}

function renderQueue(): void {
  const snap = batchSnapshot;
  if (!snap || !snap.active) {
    queueEl.hidden = true;
    return;
  }
  const parts = [`${snap.running} downloading`, `${snap.queued} waiting`];
  if (snap.done) parts.push(`${snap.done} done`);
  if (snap.failed) parts.push(`${snap.failed} failed`);
  queueEl.textContent = `Queue: ${parts.join(" • ")}`;
  queueEl.hidden = false;
}

/** Poll the worker's queue aggregate while a batch is in flight. */
async function pollQueue(): Promise<void> {
  try {
    const res = (await chrome.runtime.sendMessage({ type: "GET_BATCH" })) as
      | { ok?: boolean; snapshot?: BatchSnapshot }
      | undefined;
    if (!res?.ok || !res.snapshot) return;
    batchSnapshot = res.snapshot;
    renderQueue();
    if (lastQueueActive && !batchSnapshot.active) {
      const { done, total, failed } = batchSnapshot;
      setStatus(`Batch finished: ${done}/${total} saved${failed ? `, ${failed} failed` : ""}.`);
      batchStartBtn.disabled = selected.size === 0;
      void refreshJobs();
    }
    lastQueueActive = batchSnapshot.active;
  } catch {
    /* worker restarting — keep the last known state */
  }
}

/** Re-read job rows and repaint (used after a batch starts/finishes). */
async function refreshJobs(): Promise<void> {
  if (currentTabId == null) return;
  try {
    const res = await withTimeout(
      chrome.runtime.sendMessage({ type: "GET_JOBS", tabId: currentTabId }),
      5000,
      "Reading download jobs",
    );
    jobs = (res?.jobs ?? []) as DownloadJobState[];
    for (const j of jobs) refreshCard(j.itemUrl);
  } catch {
    /* ignore */
  }
}

/** Queue every ticked video; the worker runs them a few at a time. */
async function startBatch(): Promise<void> {
  if (currentTabId == null) {
    setStatus("No active tab found.");
    return;
  }
  if (selected.size === 0) return;
  const items = [...selected].map((url) => ({
    itemUrl: url,
    variantId: cardFor(url)?.querySelector<HTMLSelectElement>("select")?.value,
  }));
  batchStartBtn.disabled = true;
  try {
    const res = (await withTimeout(
      chrome.runtime.sendMessage({ type: "START_BATCH", tabId: currentTabId, items }),
      15000,
      "Starting batch",
    )) as { ok?: boolean; error?: string; snapshot?: BatchSnapshot } | undefined;
    if (!res?.ok) {
      setStatus(`Batch failed: ${res?.error ?? "unknown error"}`);
      batchStartBtn.disabled = false;
      return;
    }
    batchSnapshot = res.snapshot ?? null;
    lastQueueActive = batchSnapshot?.active ?? false;
    renderQueue();
    setStatus(
      `Queued ${items.length} download${items.length > 1 ? "s" : ""}. Running ${batchSnapshot?.concurrency ?? 2} at a time. You can close this popup.`,
    );
    window.setTimeout(() => void refreshJobs(), 700);
  } catch (err) {
    setStatus(`Batch failed: ${err instanceof Error ? err.message : String(err)}`);
    batchStartBtn.disabled = false;
  }
}

function renderCard(item: MediaItem): HTMLElement {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.itemUrl = item.url;

  if (isSelectable(item)) {
    card.dataset.selectable = "1";
    card.classList.toggle("pickable", selectMode);
    const pick = document.createElement("input");
    pick.type = "checkbox";
    pick.className = "pick";
    pick.hidden = !selectMode;
    pick.checked = selected.has(item.url);
    pick.setAttribute("aria-label", `Select ${item.title ?? item.type} for batch download`);
    pick.onchange = () => toggleSelected(item.url, pick.checked);
    // In select mode the whole card is a big tap target (except its controls).
    card.addEventListener("click", (e) => {
      if (!selectMode) return;
      if ((e.target as HTMLElement).closest("button, select, input, a")) return;
      pick.checked = !pick.checked;
      toggleSelected(item.url, pick.checked);
    });
    card.appendChild(pick);
  }

  if (item.poster) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = item.poster;
    img.alt = item.title ? `Thumbnail for ${item.title}` : "Video thumbnail";
    img.loading = "lazy";
    card.appendChild(img);
  } else {
    const fb = document.createElement("div");
    fb.className = "thumb-fallback";
    fb.appendChild(iconSpan("play", ""));
    card.appendChild(fb);
  }

  const meta = document.createElement("div");
  meta.className = "meta";

  const badgeRow = document.createElement("div");
  badgeRow.className = "badge-row";
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = item.type.toUpperCase();
  badgeRow.appendChild(badge);

  if (item.meta) {
    const chip = document.createElement("span");
    chip.className = "size-chip";
    chip.textContent = item.meta;
    chip.title = item.meta;
    badgeRow.appendChild(chip);
  }
  const spacer = document.createElement("span");
  spacer.className = "spacer";
  badgeRow.appendChild(spacer);

  // Copy-link needs a real URL (blob:/capture: rows have none fetchable).
  if (item.type !== "blob" && item.type !== "capture" && item.type !== "blobfile") {
    const copy = document.createElement("button");
    copy.className = "copy-btn";
    copy.title = "Copy the video URL to the clipboard";
    copy.setAttribute("aria-label", "Copy the video URL to the clipboard");
    copy.appendChild(iconSpan("copy", ""));
    const label = document.createElement("span");
    label.className = "copy-label";
    label.textContent = "Copy link";
    copy.appendChild(label);
    copy.onclick = () => void copyLink(item.url, copy);
    badgeRow.appendChild(copy);
  }
  meta.appendChild(badgeRow);

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

  // Searchable text for the toolbar filter (title + url + type).
  card.dataset.search = `${item.title ?? ""} ${item.url} ${item.type}`.toLowerCase();

  // One error row per card: the type branches below render their own state
  // (previously a failed HLS row painted the same message twice).
  if (item.drmProtected) {
    const p = document.createElement("div");
    p.className = "protected";
    p.textContent = item.drmReason ?? "Protected content. Cannot download.";
    meta.appendChild(p);
  } else if (isDirect(item)) {
    const btn = document.createElement("button");
    btn.className = "dl";
    btn.textContent = "Download";
    btn.onclick = () => void handleStartDownload(item, undefined, btn);
    meta.appendChild(btn);
  } else if (item.type === "hls" || item.type === "dash") {
    if (!item.variants || item.variants.length === 0) {
      meta.appendChild(
        errorRow(item.error ?? "Parsing manifest… reopen popup in a moment.", item),
      );
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
        // Ask the worker to measure this connection and badge the quality it
        // can sustain (async — the select renders immediately, the badge
        // appears when the probe returns).
        void markRecommendedQuality(item, sel);

        btn.textContent = "Download";
        btn.onclick = () => void handleStartDownload(item, sel.value, btn);
        meta.appendChild(btn);
      }
    }
  } else if (item.type === "segments") {
    const n = item.segments?.length ?? 0;
    if (n === 0) {
      meta.appendChild(
        errorRow(item.error ?? "Grouped player chunks expired. Play the video, then Rescan."),
      );
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
    // A blob: player IS downloadable: at click time the page is asked for the
    // video's bytes — the file behind the object URL when it is Blob-backed,
    // or the segments its player already appended when it is a MediaSource
    // buffer. The hint stays visible because "play it first" is the honest
    // state of this row (previously this row had nothing to click at all).
    const btn = document.createElement("button");
    btn.className = "dl";
    btn.textContent = "Download";
    btn.title = "Read this video out of the page — file bytes or the buffer its player filled";
    btn.onclick = () => void handleStartDownload(item, undefined, btn);
    meta.appendChild(btn);
    meta.appendChild(errorRow(item.error ?? BLOB_PLACEHOLDER_HINT));
  } else if (item.error) {
    // Any other type that failed to resolve — surface it rather than hide it.
    meta.appendChild(errorRow(item.error));
  }

  // Group quality select + download into one action row (styled via .actions).
  const actionEls = Array.from(meta.children).filter(
    (el) => el instanceof HTMLSelectElement || (el instanceof HTMLButtonElement && el.classList.contains("dl")),
  );
  if (actionEls.length > 0) {
    const row = document.createElement("div");
    row.className = "actions";
    for (const el of actionEls) row.appendChild(el);
    meta.appendChild(row);
  }

  const bar = document.createElement("div");
  bar.className = "bar";
  bar.hidden = true;
  bar.setAttribute("role", "progressbar");
  bar.setAttribute("aria-label", "Download progress");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  const fill = document.createElement("div");
  fill.className = "bar-fill";
  bar.appendChild(fill);
  meta.appendChild(bar);

  const prog = document.createElement("div");
  prog.className = "progress";
  prog.hidden = true;
  meta.appendChild(prog);

  // Utility buttons (Cancel / Pause) mount here as a row.
  const util = document.createElement("div");
  util.className = "util-row";
  meta.appendChild(util);

  card.appendChild(meta);
  paintJobState(card, item);
  return card;
}

const DIRECT_BADGES = new Set(["MP4", "WEBM", "OGG", "MOV", "MKV", "AVI", "FLV", "WMV", "MPG", "BLOBFILE"]);

function isDirect(item: MediaItem): boolean {
  return DIRECT_BADGES.has(item.type.toUpperCase());
}

function jobLine(job: DownloadJobState, direct: boolean): { label: string; state: string } {
  if (job.status === "paused") return { label: runningText(job), state: "paused" };
  if (job.status === "running") return { label: runningText(job), state: "running" };
  if (job.status === "done") {
    return { label: `Done. Check your downloads folder.${job.note ? ` ${job.note}` : ""}`, state: "done" };
  }
  if (/cancelled/i.test(job.error ?? "")) return { label: "Cancelled.", state: "cancelled" };
  if (job.expired) return { label: `Link expired mid-download: ${job.error ?? ""} Hit Refresh & Retry for fresh URLs.`, state: "error" };
  return { label: `Failed: ${job.error ?? "unknown error"}`, state: "error" };
}

/** Segmented jobs (HLS/DASH/groups) support pause; direct streams + capture/blob do not. */
function isPausableJob(job: DownloadJobState): boolean {
  if (job.unit === "bytes") return false;
  if (job.itemUrl.startsWith("capture:") || job.itemUrl.startsWith("blob:")) return false;
  return true;
}

function paintJobButtons(card: HTMLElement, job: DownloadJobState | undefined, direct: boolean): void {
  // Resolve the full related set: paired A/V downloads share one card, so
  // Cancel/Pause must act on BOTH part-jobs, not just the latest tick.
  const itemUrl = card.dataset.itemUrl ?? job?.itemUrl ?? "";
  const related = itemUrl ? jobsForItem(itemUrl) : job ? [job] : [];
  const activeRelated = related.filter((j) => j.status === "running" || j.status === "paused");
  let cancel = card.querySelector("button.cancelbtn") as HTMLButtonElement | null;
  let pause = card.querySelector("button.pausebtn") as HTMLButtonElement | null;
  // Direct downloads finish near-instantly via the browser — cancel only
  // makes sense for multi-segment HLS/DASH jobs. Page-blob ("blobfile")
  // downloads stream slices for a while, so they keep Cancel too.
  const isBlobFile = (card.dataset.itemUrl ?? "").startsWith("blob:");
  // Direct in-app fetches are abortable streams, so they keep Cancel too.
  const cancellable = activeRelated.filter((j) => !direct || isBlobFile || j.unit === "bytes");
  const showCancel = cancellable.length > 0;
  if (showCancel) {
    if (!cancel) {
      cancel = document.createElement("button");
      cancel.className = "ghost cancelbtn";
      cancel.textContent = "Cancel";
      (card.querySelector(".util-row") ?? card.querySelector(".meta"))?.appendChild(cancel);
    }
    cancel.hidden = false;
    // Rebind every tick: retries create new jobIds for the same card, and
    // paired downloads need every active part cancelled.
    const ids = cancellable.map((j) => j.jobId);
    cancel.onclick = (): void => {
      void (async () => {
        for (const id of ids) await cancelJob(id);
      })();
    };
  } else if (cancel) {
    cancel.hidden = true;
  }
  const pausable = activeRelated.filter((j) => !direct && isPausableJob(j));
  const showPause = pausable.length > 0;
  if (showPause) {
    if (!pause) {
      pause = document.createElement("button");
      pause.className = "ghost pausebtn";
      (card.querySelector(".util-row") ?? card.querySelector(".meta"))?.appendChild(pause);
    }
    pause.hidden = false;
    const allPaused = pausable.every((j) => j.status === "paused");
    pause.textContent = allPaused ? "Resume" : "Pause";
    const ids = pausable.map((j) => j.jobId);
    pause.onclick = (): void => {
      void (async () => {
        for (const id of ids) await (allPaused ? resumeJob(id) : pauseJob(id));
      })();
    };
  } else if (pause) {
    pause.hidden = true;
  }
}

/** Reflect the latest known job for this item (survives popup reopen). */
function paintJobState(card: HTMLElement, item: MediaItem): void {
  const prog = card.querySelector(".progress") as HTMLElement | null;
  const btn = card.querySelector("button.dl") as HTMLButtonElement | null;
  if (!prog || !btn) return;
  const related = jobsForItem(item.url);
  const job = related[0];
  if (!job) {
    prog.hidden = true;
    btn.disabled = false;
    setBar(card, undefined, "idle");
    return;
  }
  const direct = isDirect(item);
  const line = combinedLine(related, direct);
  if (line.state === "running" || line.state === "paused") {
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
    btn.textContent = related.some((j) => j.expired) ? "Refresh & Retry" : "Retry";
    prog.hidden = false;
    prog.textContent = line.label;
  }
  setBar(card, barJob(related), line.state);
  paintJobButtons(card, job, direct);
}

function refreshCard(itemUrl: string): void {
  const card = listEl.querySelector(`[data-item-url="${CSS.escape(itemUrl)}"]`) as HTMLElement | null;
  if (!card) return;
  const prog = card.querySelector(".progress") as HTMLElement | null;
  const btn = card.querySelector("button.dl") as HTMLButtonElement | null;
  if (!prog || !btn) return;
  const related = jobsForItem(itemUrl);
  const job = related[0];
  if (!job) return;
  const badge = card.querySelector(".badge")?.textContent ?? "";
  const direct = DIRECT_BADGES.has(badge);
  const line = combinedLine(related, direct);
  if (line.state === "running" || line.state === "paused") {
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
    btn.textContent = related.some((j) => j.expired) ? "Refresh & Retry" : "Retry";
    prog.hidden = false;
    prog.textContent = line.label;
  }
  setBar(card, barJob(related), line.state);
  paintJobButtons(card, job, direct);
}

async function pauseJob(jobId: string): Promise<void> {
  try {
    await withTimeout(
      chrome.runtime.sendMessage({ type: "PAUSE_JOB", jobId }),
      8000,
      "Pausing",
    );
    setStatus("Paused. Resume anytime. Fetched parts are kept.");
  } catch (err) {
    setStatus(`Pause failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function resumeJob(jobId: string): Promise<void> {
  // A restart-interrupted job was marked paused with a resume hint, but its
  // offscreen document is gone — flag-toggling can't revive it. Re-dispatch
  // it (RETRY_JOB reuses the jobId) so it resumes from OPFS-persisted parts.
  const interrupted = jobs.find(
    (j) => j.jobId === jobId && j.status === "paused" && /restart/i.test(j.error ?? ""),
  );
  try {
    await withTimeout(
      chrome.runtime.sendMessage(interrupted ? { type: "RETRY_JOB", jobId } : { type: "RESUME_JOB", jobId }),
      8000,
      "Resuming",
    );
    setStatus(interrupted ? "Resuming from where it stopped…" : "Resuming…");
  } catch (err) {
    setStatus(`Resume failed: ${err instanceof Error ? err.message : String(err)}`);
  }
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
  // The button holds an icon + label span — update only the label so the
  // icon survives the "Copied!" swap.
  const label = btn.querySelector(".copy-label") as HTMLElement | null;
  const done = (msg: string) => {
    if (label) {
      const orig = label.textContent ?? "Copy link";
      label.textContent = msg;
      setTimeout(() => {
        label.textContent = orig;
      }, 1500);
    } else {
      const orig = "Copy link";
      btn.textContent = msg;
      setTimeout(() => {
        btn.textContent = orig;
      }, 1500);
    }
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
      setStatus("Copy failed. Right-click the URL text to copy manually.");
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
  const expired = jobsForItem(item.url).some((j) => j.expired);
  if (expired) setStatus("Refreshing stream URLs and restarting download…");
  // Preferred path: background worker (tracks jobs, offscreen for HLS/DASH).
  if (workerAlive && currentTabId != null) {
    try {
      const res = await withTimeout(
        chrome.runtime.sendMessage({
          type: "START_DOWNLOAD",
          tabId: currentTabId,
          itemUrl: item.url,
          variantId,
          refresh: expired,
          resumeJobId: jobsForItem(item.url).find((j) => j.expired)?.jobId,
        }),
        45000,
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
            ? "Merging video + audio into one file with sound. You can close this popup."
            : res.paired
              ? "Downloading video + audio as 2 files (this stream can't be merged in-app). You can close this popup."
              : `Download running in the background for ${basenameOf(job.filename)}. You can close this popup.`,
        );
      } else {
        setStatus(`Download running in the background for ${basenameOf(job.filename)}. You can close this popup.`);
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
      prog.textContent = "Done. Check your downloads folder.";
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

// 1s ticker so speed/ETA on running jobs stays live even between segments,
// and the batch queue aggregate stays current alongside the cards.
setInterval(() => {
  try {
    for (const j of jobs) {
      if (j.status === "running" || j.status === "paused") refreshCard(j.itemUrl);
    }
    if (batchSnapshot?.active) void pollQueue();
  } catch {
    /* ignore */
  }
}, 1000);

selectToggleBtn.onclick = () => setSelectMode(!selectMode);

settingsBtn.onclick = () => {
  try {
    void chrome.runtime.openOptionsPage();
  } catch (err) {
    setStatus(`Could not open settings: ${err instanceof Error ? err.message : String(err)}`);
  }
};

batchStartBtn.onclick = () => void startBatch();

batchAllBtn.onclick = () => {
  for (const card of cards()) {
    if (card.hidden || card.dataset.selectable !== "1") continue;
    toggleSelected(card.dataset.itemUrl ?? "", true);
  }
};

batchClearBtn.onclick = () => {
  for (const url of [...selected]) toggleSelected(url, false);
};

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

searchEl?.addEventListener("input", () => applyFilter());

void loadMedia();
