// Runtime message routing (replaces the giant if/else chain).
// Each message type has a focused handler in HANDLERS; routeMessage
// dispatches by type. Logic moved verbatim from background.ts —
// zero behavior change, only the routing structure is new.
import { cleanTitle, downloadDirect, recommendVariant } from "../lib/download";
import { extractHlsSegments } from "../lib/parseHls";
import { appendHistory, clearHistory, entryFromJob, getHistoryEntry, loadHistory } from "../lib/history";
import { getSettings, normalizeSettings, saveSettings } from "../lib/settings";
import type { DownloadJobState, MediaItem, NetReplay } from "../lib/types";
import { sendToFrame } from "./frames";
import { lookupNet } from "./headers";
import { fetchManifestText, parseStreamingItem } from "./manifests";
import { ensureOffscreen, maybeCloseOffscreen, newJobId, redownloadHistoryEntry, startDownload } from "./jobs";
import { notifyDownloadComplete } from "./notifications";
import { batchQueue } from "./queue";
import { dropRate, noteProgress } from "./rate";
import { rememberSave } from "./saves";
import { getTabItems, getTabJobs, getMemoryItems, persistTab } from "./store";
import { ensureJobsLoaded, getJob, upsertJob } from "./store";
import { handleCaptureSessions, handleVideoSignals } from "./signals";
import { isExcludedUrl } from "./media";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMsg = any;
type Sender = chrome.runtime.MessageSender;
type Handler = (m: AnyMsg, sender: Sender) => Promise<unknown>;

/**
 * Bandwidth-aware quality suggestion. Resolves the item's first few segment
 * URLs, has the offscreen document time a small sample fetch, then recommends
 * the best variant the connection can sustain. Results are cached per item for
 * a short window so reopening the popup doesn't re-probe.
 */
const SPEED_TTL_MS = 10 * 60_000;
const speedCache = new Map<string, { bps: number; at: number }>();
/** Probes are throttled: bounded concurrency + bounded queue (bandwidth cost). */
const MAX_PROBE_CONCURRENT = 2;
const MAX_PROBE_PENDING = 4;
let probesActive = 0;
const probeWaiters: Array<() => void> = [];

/**
 * Run a probe inside the throttle. When the queue is full the caller gets
 * `skip` immediately — a missing recommendation is always acceptable, a
 * bandwidth stampede is not.
 */
async function withProbeSlot<T>(fn: () => Promise<T>, skip: T): Promise<T> {
  if (probesActive >= MAX_PROBE_CONCURRENT) {
    if (probeWaiters.length >= MAX_PROBE_PENDING) return skip;
    await new Promise<void>((resolve) => probeWaiters.push(resolve));
  }
  probesActive++;
  try {
    return await fn();
  } finally {
    probesActive--;
    probeWaiters.shift()?.();
    // Only tidy the offscreen document once the LAST probe is done — closing
    // it mid-probe would drop another item's measurement.
    if (probesActive === 0) void maybeCloseOffscreen();
  }
}

async function sampleUrlsFor(tabId: number, item: MediaItem, variantId?: string): Promise<string[]> {
  const variant =
    item.variants?.find((v) => v.id === variantId) ?? item.variants?.[0];
  if (!variant) return [];
  if (variant.segments?.length) return variant.segments.slice(0, 3);
  if (item.type !== "hls") return [];
  // HLS: the variant URL is a media playlist — read it and take its first
  // segments (the same resolving path the downloader uses).
  try {
    const text = await fetchManifestText(tabId, variant.url, { frameId: item.frameId });
    return extractHlsSegments(text, variant.url).slice(0, 3);
  } catch {
    return [];
  }
}

async function probeQuality(tabId: number, item: MediaItem): Promise<{ bps: number } | null> {
  const cached = speedCache.get(item.url);
  if (cached && Date.now() - cached.at < SPEED_TTL_MS) return { bps: cached.bps };
  const urls = await sampleUrlsFor(tabId, item);
  if (urls.length === 0) return null;
  // Reuse the page's auth context so gated sample segments answer.
  const byOrigin: Record<string, NetReplay> = {};
  for (const u of urls) {
    const net = lookupNet(tabId, u);
    if (!net) continue;
    try {
      byOrigin[new URL(u).origin] = net;
    } catch {
      /* ignore */
    }
  }
  await ensureOffscreen();
  const res = (await chrome.runtime.sendMessage({
    type: "OFFSCREEN_PROBE",
    probeId: newJobId(),
    urls,
    netScope: Object.keys(byOrigin).length ? { byOrigin } : undefined,
  })) as { ok?: boolean; bps?: number } | undefined;
  if (!res?.ok || typeof res.bps !== "number" || res.bps <= 0) return null;
  speedCache.set(item.url, { bps: res.bps, at: Date.now() });
  return { bps: res.bps };
}

async function handleProbeQuality(m: AnyMsg): Promise<unknown> {
  if (typeof m.tabId !== "number" || typeof m.itemUrl !== "string") {
    return { ok: false, error: "Unknown message" };
  }
  const items = getMemoryItems(m.tabId) ?? (await getTabItems(m.tabId));
  const item = items.find((x) => x.url === m.itemUrl);
  if (!item) return { ok: false, error: "Video no longer listed for this tab." };
  if (!item.variants || item.variants.length < 2) return { ok: true, recommendedId: undefined };
  try {
    const probed = await withProbeSlot(() => probeQuality(m.tabId, item), null);
    if (!probed) return { ok: true, recommendedId: undefined };
    const recommendedId = recommendVariant(item.variants, probed.bps);
    return { ok: true, recommendedId, bps: Math.round(probed.bps) };
  } catch (err) {
    // A failed probe is not a failure of the item — just no recommendation.
    return { ok: true, recommendedId: undefined, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleGetMedia(m: AnyMsg): Promise<unknown> {
  if (typeof m.tabId !== "number") return { ok: false, error: "Unknown message" };
  // Fast path first: memory answers instantly; session read is
  // internally timeout-guarded and can never hang this response.
  const mem = getMemoryItems(m.tabId);
  return { items: mem ?? (await getTabItems(m.tabId)) };
}

async function handleGetJobs(m: AnyMsg): Promise<unknown> {
  if (typeof m.tabId !== "number") return { ok: false, error: "Unknown message" };
  return { jobs: await getTabJobs(m.tabId) };
}

async function handleCancelJob(m: AnyMsg): Promise<unknown> {
  if (typeof m.jobId !== "string") return { ok: false, error: "Unknown message" };
  await ensureJobsLoaded();
  const job = getJob(m.jobId);
  if (job && (job.status === "running" || job.status === "paused")) {
    // Ask the offscreen document to abort; it reports back via
    // DOWNLOAD_ERROR("Download cancelled.") which finalizes the job.
    try {
      await chrome.runtime.sendMessage({ type: "OFFSCREEN_CANCEL", jobId: m.jobId });
    } catch {
      job.status = "error";
      job.error = "Download cancelled.";
      await upsertJob(job);
      dropRate(job.jobId);
      await afterJobSettled(job, "cancelled");
    }
    // Capture + blob-file jobs also stream from the tab — stop the driver too.
    if (job.itemUrl.startsWith("capture:") || job.itemUrl.startsWith("blob:")) {
      try {
        await sendToFrame(job.tabId, job.frameId, { type: "MS_CANCEL", jobId: m.jobId });
      } catch {
        /* driver ends on its own via abort flag or completion */
      }
    }
    // A cancelled download won't resume — drop its persisted segments.
    try {
      await chrome.runtime.sendMessage({ type: "PURGE_JOB_DATA", jobId: m.jobId });
    } catch {
      /* offscreen may be gone */
    }
    return { ok: true };
  }
  return { ok: false, error: "Job is not running." };
}

async function handlePauseJob(m: AnyMsg): Promise<unknown> {
  if (typeof m.jobId !== "string") return { ok: false, error: "Unknown message" };
  await ensureJobsLoaded();
  const job = getJob(m.jobId);
  if (job && job.status === "running") {
    job.status = "paused";
    await upsertJob(job);
    try {
      await chrome.runtime.sendMessage({ type: "OFFSCREEN_PAUSE", jobId: m.jobId });
    } catch {
      /* offscreen will pick it up via flag on next tick; state already paused */
    }
    return { ok: true };
  }
  return { ok: false, error: "Job is not running." };
}

async function handleRetryJob(m: AnyMsg): Promise<unknown> {
  if (typeof m.jobId !== "string") return { ok: false, error: "Unknown message" };
  await ensureJobsLoaded();
  const job = getJob(m.jobId);
  if (!job) return { ok: false, error: "Job not found." };
  if (job.status === "running") return { ok: false, error: "Job is already running." };
  // Re-dispatch under the SAME jobId so the offscreen resumes from the
  // segments persisted to OPFS before the interruption (HLS/DASH/grouped).
  try {
    const { job: resumed } = await startDownload(job.tabId, job.itemUrl, job.variantId, job.jobId);
    return { ok: true, job: resumed };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleResumeJob(m: AnyMsg): Promise<unknown> {
  if (typeof m.jobId !== "string") return { ok: false, error: "Unknown message" };
  await ensureJobsLoaded();
  const job = getJob(m.jobId);
  if (job && job.status === "paused") {
    job.status = "running";
    await upsertJob(job);
    try {
      await chrome.runtime.sendMessage({ type: "OFFSCREEN_RESUME", jobId: m.jobId });
    } catch {
      /* workers poll the flag; resume takes effect on next tick */
    }
    return { ok: true };
  }
  return { ok: false, error: "Job is not paused." };
}

async function handleStartDownload(m: AnyMsg): Promise<unknown> {
  if (typeof m.tabId !== "number" || typeof m.itemUrl !== "string") {
    return { ok: false, error: "Unknown message" };
  }
  try {
    const resumeJobId = typeof m.resumeJobId === "string" ? m.resumeJobId : undefined;
    const { job, paired, merged } = await startDownload(
      m.tabId,
      m.itemUrl,
      m.variantId,
      resumeJobId,
      { refresh: m.refresh === true, cardUrl: m.itemUrl },
    );
    return { ok: true, job, paired, merged };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleVideoElements(m: AnyMsg, sender: Sender): Promise<unknown> {
  if (typeof m.tabId !== "number") return { ok: false, error: "Unknown message" };
  const fromSender = sender.tab?.id ?? m.tabId;
  if (fromSender >= 0 && sender.tab?.url && isExcludedUrl(sender.tab.url)) {
    return { ok: true };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vids = (m.videos ?? []) as any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const blobs = Array.isArray(m.blobs) ? (m.blobs as any) : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const adapterItems = Array.isArray(m.adapterItems) ? (m.adapterItems as any) : undefined;
  await handleVideoSignals(fromSender, vids, m.pageTitle, sender.frameId, blobs, adapterItems);
  // Posters/titles keyed by blob: URL for capture-session rows.
  const posterByBlob = new Map<string, string>();
  const titleByBlob = new Map<string, string>();
  for (const v of vids) {
    if (typeof v?.currentSrc === "string" && v.currentSrc.startsWith("blob:")) {
      if (typeof v?.poster === "string") posterByBlob.set(v.currentSrc, v.poster);
      const vt = cleanTitle(typeof v?.title === "string" ? v.title : "");
      if (vt) titleByBlob.set(v.currentSrc, vt);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await handleCaptureSessions(
    fromSender,
    m.msSessions as any,
    posterByBlob,
    titleByBlob,
    m.pageTitle,
    sender.frameId,
  );
  return { ok: true };
}

async function handleManifestMeta(m: AnyMsg, sender: Sender): Promise<unknown> {
  if (!Array.isArray(m.pairs)) return { ok: false, error: "Unknown message" };
  // Poster URLs seen next to a manifest URL in the same API response.
  const fromTab = sender.tab?.id ?? (typeof m.tabId === "number" ? m.tabId : -1);
  if (fromTab >= 0) {
    const items = await getTabItems(fromTab);
    let changed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const p of m.pairs as any[]) {
      if (typeof p?.manifest !== "string" || !Array.isArray(p?.thumbs) || !p.thumbs.length) continue;
      const item = items.find((x) => x.url === p.manifest && !x.poster);
      const thumb = (p.thumbs as unknown[]).find((t): t is string => typeof t === "string");
      if (item && thumb) {
        item.poster = thumb;
        changed = true;
      }
    }
    if (changed) await persistTab(fromTab, items);
  }
  return { ok: true };
}

/**
 * Shared post-settlement bookkeeping: advance the batch queue, record the
 * history row, and raise a completion notification. Every terminal path funnels
 * through here so the three stay consistent (and DRY).
 */
async function afterJobSettled(
  job: DownloadJobState,
  status: "done" | "error" | "cancelled",
): Promise<void> {
  batchQueue.onJobSettled(job.jobId);
  try {
    await appendHistory(entryFromJob(job, status));
  } catch {
    /* history is best-effort */
  }
  if (status === "done") await notifyDownloadComplete(job);
}

async function handleDownloadProgress(m: AnyMsg): Promise<unknown> {
  if (typeof m.jobId !== "string") return { ok: false, error: "Unknown message" };
  await ensureJobsLoaded();
  const job = getJob(m.jobId);
  if (job) {
    job.done = m.done ?? job.done;
    job.total = m.total ?? job.total;
    if (typeof m.bytesDone === "number") {
      job.bytesDone = m.bytesDone;
      // Rolling window rate — a cumulative average lags and never recovers
      // after a stall; this reflects the speed right now.
      const rate = noteProgress(m.jobId, m.bytesDone);
      if (rate && rate > 0) job.rateBps = rate;
    }
    if (!job.startedAt) job.startedAt = Date.now();
    await upsertJob(job, false);
  }
  return { ok: true };
}

async function handleJobStage(m: AnyMsg): Promise<unknown> {
  if (typeof m.jobId !== "string") return { ok: false, error: "Unknown message" };
  await ensureJobsLoaded();
  const job = getJob(m.jobId);
  if (job && (m.stage === "fetching" || m.stage === "assembling" || m.stage === "saving")) {
    job.stage = m.stage;
    await upsertJob(job, false);
  }
  return { ok: true };
}

async function handleMsTrack(m: AnyMsg): Promise<unknown> {
  if (typeof m.jobId !== "string") return { ok: false, error: "Unknown message" };
  // Capture-transfer traffic is addressed to the offscreen document
  // (which acks it); the worker only notes the total for progress.
  if (m.type === "MS_TRACK_START" && typeof m.total === "number") {
    await ensureJobsLoaded();
    const job = getJob(m.jobId);
    if (job && job.status === "running") {
      job.total = m.total;
      job.stage = "fetching";
      await upsertJob(job, false);
    }
  }
  return { ok: true };
}

async function handleDownloadBlob(m: AnyMsg): Promise<unknown> {
  if (typeof m.jobId !== "string") return { ok: false, error: "Unknown message" };
  // Final handoff: the worker (full API access) saves the file the
  // offscreen document assembled. data: URLs work with downloads.
  await ensureJobsLoaded();
  const job = getJob(m.jobId);
  if (job) {
    if (typeof m.dataUrl !== "string" || !m.dataUrl.startsWith("data:")) {
      job.status = "error";
      job.error = "Background worker received a corrupt file payload.";
    } else {
      try {
        const downloadId = await chrome.downloads.download({
          url: m.dataUrl,
          filename: typeof m.filename === "string" && m.filename ? m.filename : job.filename,
          saveAs: false,
        });
        job.status = "done";
        job.downloadId = downloadId;
        job.done = job.total || job.done;
      } catch (err) {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
      }
    }
    await upsertJob(job);
    dropRate(job.jobId);
    await afterJobSettled(job, job.status === "done" ? "done" : "error");
  }
  void maybeCloseOffscreen();
  return { ok: true };
}

async function handleDownloadDone(m: AnyMsg): Promise<unknown> {
  if (typeof m.jobId !== "string") return { ok: false, error: "Unknown message" };
  // The offscreen document saved the file itself (no giant payloads through
  // messaging). Mark the job complete, then record + announce it.
  await ensureJobsLoaded();
  const job = getJob(m.jobId);
  if (job) {
    if (typeof m.filename === "string" && m.filename) job.filename = m.filename;
    if (typeof m.note === "string" && m.note) job.note = m.note;
    if (typeof m.downloadId === "number") job.downloadId = m.downloadId;
    job.status = "done";
    job.done = job.total || job.done;
    job.rateBps = undefined;
    await upsertJob(job);
    dropRate(job.jobId);
    await afterJobSettled(job, "done");
    // Drop the capture's buffered parts — a done capture can hold >1 GB.
    try {
      await chrome.runtime.sendMessage({ type: "PURGE_CAPTURE", jobId: m.jobId });
    } catch {
      /* offscreen already closing */
    }
  }
  void maybeCloseOffscreen();
  return { ok: true };
}

async function handleDownloadError(m: AnyMsg): Promise<unknown> {
  if (typeof m.jobId !== "string") return { ok: false, error: "Unknown message" };
  await ensureJobsLoaded();
  const job = getJob(m.jobId);
  if (job) {
    // Oversized in-app fetches hand over to the browser, which has no
    // memory cap — the download still completes, just without progress.
    if (m.fallbackDirect === true && job.unit === "bytes") {
      try {
        job.downloadId = await downloadDirect(job.itemUrl, job.filename);
        job.status = "done";
        job.done = job.total || job.done;
      } catch (err) {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
      }
      await upsertJob(job);
      dropRate(job.jobId);
      await afterJobSettled(job, job.status === "done" ? "done" : "error");
    } else {
      // A pause-then-cancel race can deliver a late abort after resume;
      // only terminal states from a non-paused job finalize as error.
      job.status = "error";
      job.error = m.error ?? "Download failed.";
      job.expired = m.expired === true;
      await upsertJob(job);
      dropRate(job.jobId);
      await afterJobSettled(job, /cancelled/i.test(job.error ?? "") ? "cancelled" : "error");
    }
  }
  void maybeCloseOffscreen();
  return { ok: true };
}

/**
 * Retry one item's manifest read (popup "Retry" on a failed row). The read is
 * forced past the cache so a fresh page-context fetch is attempted — the layer
 * that actually works on Referer/Origin/token-gated CDNs.
 */
async function handleRetryParse(m: AnyMsg): Promise<unknown> {
  if (typeof m.tabId !== "number" || typeof m.itemUrl !== "string") {
    return { ok: false, error: "Unknown message" };
  }
  const items = getMemoryItems(m.tabId) ?? (await getTabItems(m.tabId));
  const item = items.find((x) => x.url === m.itemUrl);
  if (!item) return { ok: false, error: "Video no longer listed for this tab." };
  await parseStreamingItem(m.tabId, item, { forceNetwork: true });
  const after =
    (getMemoryItems(m.tabId) ?? (await getTabItems(m.tabId))).find((x) => x.url === m.itemUrl) ??
    item;
  if (after.error && !after.variants?.length) return { ok: false, error: after.error };
  return { ok: true, item: after };
}

// ---- page-relayed segment bytes (offscreen <-> tab) -----------------------

/** transferId -> the tab a page relay is streaming from (bounded, short-lived). */
const pageRelayTabs = new Map<string, number>();
const PAGE_RELAY_TAB_MAX = 16;

/**
 * Offscreen -> worker: this document is refused a stream chunk, so ask the
 * job's tab to fetch that one URL with the page's own request context. The
 * bytes come back as PAGE_BYTES_CHUNK broadcasts (the offscreen assembles
 * them) — this handler only validates and forwards the request.
 */
async function handleRequestPageBytes(m: AnyMsg): Promise<unknown> {
  if (typeof m.transferId !== "string" || typeof m.url !== "string") {
    return { ok: false, error: "Unknown message" };
  }
  await ensureJobsLoaded();
  const job = typeof m.jobId === "string" ? getJob(m.jobId) : undefined;
  const tabId = job?.tabId;
  if (tabId == null || tabId < 0) {
    return { ok: false, error: "No live tab to relay through — re-download from the page." };
  }
  try {
    await sendToFrame(tabId, job?.frameId, {
      type: "PAGE_FETCH_BYTES",
      transferId: m.transferId,
      url: m.url,
      jobId: typeof m.jobId === "string" ? m.jobId : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      error: `The page can't fetch this chunk (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
  pageRelayTabs.set(m.transferId, tabId);
  while (pageRelayTabs.size > PAGE_RELAY_TAB_MAX) {
    const oldest = pageRelayTabs.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    pageRelayTabs.delete(oldest);
  }
  return { ok: true };
}

/** Offscreen -> worker: stop a transfer (cancelled, timed out, or failed). */
async function handlePageBytesCancel(m: AnyMsg): Promise<unknown> {
  if (typeof m.transferId !== "string") return { ok: false, error: "Unknown message" };
  const tabId = pageRelayTabs.get(m.transferId);
  pageRelayTabs.delete(m.transferId);
  if (tabId == null) return { ok: true };
  try {
    // Deliberately tab-wide: only the frame streaming this transferId reacts,
    // and cancelling must still land if that frame's id has since changed.
    await chrome.tabs.sendMessage(tabId, { type: "PAGE_BYTES_CANCEL", transferId: m.transferId });
  } catch {
    /* tab closed mid-transfer */
  }
  return { ok: true };
}

/**
 * Content -> runtime broadcast of relayed slices. The offscreen document owns
 * the bytes; here we only retire the transfer mapping. (Content scripts cannot
 * hear runtime broadcasts, so cancels are forwarded to them explicitly.)
 */
async function handlePageBytesTraffic(m: AnyMsg): Promise<unknown> {
  if (typeof m.transferId !== "string") return { ok: false, error: "Unknown message" };
  if (m.type === "PAGE_BYTES_FAILED" || m.done === true) pageRelayTabs.delete(m.transferId);
  return { ok: true };
}

/** Offscreen -> worker: stamp a note on a running job (e.g. page relay used). */
async function handleJobNote(m: AnyMsg): Promise<unknown> {
  if (typeof m.jobId !== "string" || typeof m.note !== "string") {
    return { ok: false, error: "Unknown message" };
  }
  await ensureJobsLoaded();
  const job = getJob(m.jobId);
  if (job && job.status === "running") {
    job.note = m.note.slice(0, 200);
    await upsertJob(job, false);
  }
  return { ok: true };
}

async function handleRescan(m: AnyMsg): Promise<unknown> {
  if (typeof m.tabId !== "number") return { ok: false, error: "Unknown message" };
  // Ask the content script to re-collect <video> elements (covers
  // cached pages where webRequest saw nothing new).
  try {
    // Tab-wide by design: a rescan wants every frame's <video> elements.
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
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { ok: true };
}

// ---- settings, history, batch ---------------------------------------------

async function handleGetSettings(): Promise<unknown> {
  return { ok: true, settings: await getSettings() };
}

async function handleSaveSettings(m: AnyMsg): Promise<unknown> {
  const patch = normalizeSettings(m.settings);
  return { ok: true, settings: await saveSettings(patch) };
}

async function handleGetHistory(): Promise<unknown> {
  return { ok: true, entries: await loadHistory() };
}

async function handleClearHistory(): Promise<unknown> {
  await clearHistory();
  return { ok: true };
}

async function handleRedownload(m: AnyMsg): Promise<unknown> {
  if (typeof m.entryId !== "string") return { ok: false, error: "Unknown message" };
  const entry = await getHistoryEntry(m.entryId);
  if (!entry) return { ok: false, error: "That history entry no longer exists." };
  try {
    const job = await redownloadHistoryEntry(entry);
    // A direct re-download finishes synchronously (the browser fetches it), so
    // it needs its history row and notification here; manifest re-downloads
    // settle later through the normal DOWNLOAD_DONE path.
    if (job.status === "done") {
      await appendHistory(entryFromJob(job, "done"));
      await notifyDownloadComplete(job);
    }
    return { ok: true, job };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleStartBatch(m: AnyMsg): Promise<unknown> {
  if (typeof m.tabId !== "number" || !Array.isArray(m.items)) {
    return { ok: false, error: "Unknown message" };
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const items = (m.items as any[])
    .filter((x) => x && typeof x.itemUrl === "string")
    .map((x) => ({
      itemUrl: x.itemUrl as string,
      variantId: typeof x.variantId === "string" ? (x.variantId as string) : undefined,
    }));
  if (items.length === 0) return { ok: false, error: "Nothing selected." };
  const known = getMemoryItems(m.tabId) ?? (await getTabItems(m.tabId));
  const titleByUrl = new Map(known.map((i) => [i.url, i.title]));
  await batchQueue.add(
    m.tabId,
    items.map((i) => ({ ...i, title: titleByUrl.get(i.itemUrl) })),
  );
  return { ok: true, snapshot: batchQueue.snapshot() };
}

async function handleGetBatch(): Promise<unknown> {
  await ensureJobsLoaded();
  return { ok: true, snapshot: batchQueue.snapshot() };
}

/**
 * Offscreen -> worker: save an assembled Blob through chrome.downloads so the
 * configured subfolder/filename apply and the file is tracked (download id for
 * "Show in folder"). The blob URL stays alive until the transfer completes.
 */
async function handleSaveBlobUrl(m: AnyMsg): Promise<unknown> {
  if (typeof m.blobUrl !== "string" || typeof m.filename !== "string") {
    return { ok: false, error: "Unknown message" };
  }
  try {
    const downloadId = await chrome.downloads.download({
      url: m.blobUrl,
      filename: m.filename,
      saveAs: false,
    });
    rememberSave(downloadId, m.blobUrl);
    return { ok: true, downloadId };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function handleIgnored(): Promise<unknown> {
  // Broadcast/offscreen traffic not addressed to the worker — ignore.
  return { ok: true };
}

const HANDLERS: Record<string, Handler> = {
  GET_MEDIA: handleGetMedia,
  GET_JOBS: handleGetJobs,
  PROBE_QUALITY: handleProbeQuality,
  CANCEL_JOB: handleCancelJob,
  PAUSE_JOB: handlePauseJob,
  RESUME_JOB: handleResumeJob,
  RETRY_JOB: handleRetryJob,
  START_DOWNLOAD: handleStartDownload,
  VIDEO_ELEMENTS: handleVideoElements,
  MANIFEST_META: handleManifestMeta,
  DOWNLOAD_PROGRESS: handleDownloadProgress,
  JOB_STAGE: handleJobStage,
  MS_TRACK_START: handleMsTrack,
  MS_TRACK_CHUNK: handleMsTrack,
  MS_TRACK_END: handleMsTrack,
  DOWNLOAD_BLOB: handleDownloadBlob,
  DOWNLOAD_DONE: handleDownloadDone,
  DOWNLOAD_ERROR: handleDownloadError,
  RESCAN: handleRescan,
  RETRY_PARSE: handleRetryParse,
  REQUEST_PAGE_BYTES: handleRequestPageBytes,
  PAGE_BYTES_CANCEL: handlePageBytesCancel,
  PAGE_BYTES_CHUNK: handlePageBytesTraffic,
  PAGE_BYTES_FAILED: handlePageBytesTraffic,
  JOB_NOTE: handleJobNote,
  GET_SETTINGS: handleGetSettings,
  SAVE_SETTINGS: handleSaveSettings,
  GET_HISTORY: handleGetHistory,
  CLEAR_HISTORY: handleClearHistory,
  REDOWNLOAD: handleRedownload,
  START_BATCH: handleStartBatch,
  GET_BATCH: handleGetBatch,
  SAVE_BLOB_URL: handleSaveBlobUrl,
  RELEASE_BLOB_URL: handleIgnored,
  JOB_UPDATED: handleIgnored,
  OFFSCREEN_DOWNLOAD: handleIgnored,
  OFFSCREEN_CANCEL: handleIgnored,
  OFFSCREEN_PAUSE: handleIgnored,
  OFFSCREEN_RESUME: handleIgnored,
  OFFSCREEN_STATUS: handleIgnored,
  OFFSCREEN_PROBE: handleIgnored,
  CONTEXT_DOWNLOAD: handleIgnored,
  PURGE_CAPTURE: handleIgnored,
  PURGE_JOB_DATA: handleIgnored,
};

/** Dispatch one runtime message to its handler (PING is handled elsewhere). */
export async function routeMessage(m: AnyMsg, sender: Sender): Promise<unknown> {
  const handler = typeof m?.type === "string" ? HANDLERS[m.type] : undefined;
  if (!handler) return { ok: false, error: "Unknown message" };
  return handler(m, sender);
}
