// Runtime message routing (replaces the giant if/else chain).
// Each message type has a focused handler in HANDLERS; routeMessage
// dispatches by type. Logic moved verbatim from background.ts —
// zero behavior change, only the routing structure is new.
import { cleanTitle, downloadDirect } from "../lib/download";
import { maybeCloseOffscreen, startDownload } from "./jobs";
import { getTabItems, getTabJobs, getMemoryItems, persistTab } from "./store";
import { ensureJobsLoaded, getJob, upsertJob } from "./store";
import { handleCaptureSessions, handleVideoSignals } from "./signals";
import { isExcludedUrl } from "./media";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMsg = any;
type Sender = chrome.runtime.MessageSender;
type Handler = (m: AnyMsg, sender: Sender) => Promise<unknown>;

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
    }
    // Capture + blob-file jobs also stream from the tab — stop the driver too.
    if (job.itemUrl.startsWith("capture:") || job.itemUrl.startsWith("blob:")) {
      try {
        await chrome.tabs.sendMessage(job.tabId, { type: "MS_CANCEL", jobId: m.jobId });
      } catch {
        /* driver ends on its own via abort flag or completion */
      }
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
    const { job, paired, merged } = await startDownload(m.tabId, m.itemUrl, m.variantId);
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
  await handleVideoSignals(fromSender, vids, m.pageTitle, sender.frameId, blobs);
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
  await handleCaptureSessions(fromSender, m.msSessions as any, posterByBlob, titleByBlob, m.pageTitle);
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

async function handleDownloadProgress(m: AnyMsg): Promise<unknown> {
  if (typeof m.jobId !== "string") return { ok: false, error: "Unknown message" };
  await ensureJobsLoaded();
  const job = getJob(m.jobId);
  if (job) {
    job.done = m.done ?? job.done;
    job.total = m.total ?? job.total;
    if (typeof m.bytesDone === "number") job.bytesDone = m.bytesDone;
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
  }
  void maybeCloseOffscreen();
  return { ok: true };
}

async function handleDownloadDone(m: AnyMsg): Promise<unknown> {
  if (typeof m.jobId !== "string") return { ok: false, error: "Unknown message" };
  // The offscreen document saved the file itself (anchor download —
  // no giant payloads through messaging). Mark the job complete.
  await ensureJobsLoaded();
  const job = getJob(m.jobId);
  if (job) {
    if (typeof m.filename === "string" && m.filename) job.filename = m.filename;
    if (typeof m.note === "string" && m.note) job.note = m.note;
    job.status = "done";
    job.done = job.total || job.done;
    await upsertJob(job);
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
        const downloadId = await downloadDirect(job.itemUrl, job.filename);
        void downloadId;
        job.status = "done";
        job.done = job.total || job.done;
      } catch (err) {
        job.status = "error";
        job.error = err instanceof Error ? err.message : String(err);
      }
      await upsertJob(job);
    } else {
      // A pause-then-cancel race can deliver a late abort after resume;
      // only terminal states from a non-paused job finalize as error.
      job.status = "error";
      job.error = m.error ?? "Download failed.";
      job.expired = m.expired === true;
      await upsertJob(job);
    }
  }
  void maybeCloseOffscreen();
  return { ok: true };
}

async function handleRescan(m: AnyMsg): Promise<unknown> {
  if (typeof m.tabId !== "number") return { ok: false, error: "Unknown message" };
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
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { ok: true };
}

async function handleIgnored(): Promise<unknown> {
  // Broadcast/offscreen traffic not addressed to the worker — ignore.
  return { ok: true };
}

const HANDLERS: Record<string, Handler> = {
  GET_MEDIA: handleGetMedia,
  GET_JOBS: handleGetJobs,
  CANCEL_JOB: handleCancelJob,
  PAUSE_JOB: handlePauseJob,
  RESUME_JOB: handleResumeJob,
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
  JOB_UPDATED: handleIgnored,
  OFFSCREEN_DOWNLOAD: handleIgnored,
  OFFSCREEN_CANCEL: handleIgnored,
  OFFSCREEN_PAUSE: handleIgnored,
  OFFSCREEN_RESUME: handleIgnored,
};

/** Dispatch one runtime message to its handler (PING is handled elsewhere). */
export async function routeMessage(m: AnyMsg, sender: Sender): Promise<unknown> {
  const handler = typeof m?.type === "string" ? HANDLERS[m.type] : undefined;
  if (!handler) return { ok: false, error: "Unknown message" };
  return handler(m, sender);
}
