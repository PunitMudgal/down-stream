// Offscreen download orchestration (survives popup close).
// Moved verbatim from background.ts — zero behavior change.
//
// The offscreen document (runtime API only) assembles segment bytes;
// the worker performs the actual chrome.downloads.download(), which
// offscreen documents cannot call.
import { parseDashManifest } from "../lib/parseDash";
import { parseHlsManifest } from "../lib/parseHls";
import { classify } from "../lib/classify";
import { cleanTitle, defaultExtForType, filenameForUrl, sortSegmentsNatural } from "../lib/download";
import { basenameOf, joinDownloadPath, qualityLabel, renderFilename, withExtPreservingDir } from "../lib/filename";
import type { HistoryEntry } from "../lib/history";
import { normalizeUrl } from "../lib/target";
import { getSettings } from "../lib/settings";
import type {
  DownloadJobRequest,
  DownloadJobState,
  MediaItem,
  MediaType,
  NetReplay,
  Variant,
} from "../lib/types";
import { lookupNet } from "./headers";
import { fetchManifestText, parseStreamingItem } from "./manifests";
import { codecsOf, enforceCaps, hasAudioCodec, hasVideoCodec, patchItem, updateBadge } from "./media";
import { resetRate } from "./rate";
import { hasPendingSave } from "./saves";
import { ensureJobsLoaded, getTabItems, jobMemory, persistJobs, persistTab, upsertJob } from "./store";

export const OFFSCREEN_URL = "src/offscreen.html";

export function newJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function offscreenExists(): Promise<boolean> {
  try {
    // Preferred API (Chrome 116+).
    const rt = chrome.runtime as typeof chrome.runtime & {
      getContexts?: (filter: object) => Promise<Array<unknown>>;
    };
    if (typeof rt.getContexts === "function") {
      const contexts = await rt.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
      });
      return contexts.length > 0;
    }
    if (typeof chrome.offscreen?.hasDocument === "function") {
      return await chrome.offscreen.hasDocument();
    }
  } catch {
    /* fall through to create */
  }
  return false;
}

export async function ensureOffscreen(): Promise<void> {
  if (await offscreenExists()) return;
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

export async function maybeCloseOffscreen(): Promise<void> {
  await ensureJobsLoaded();
  // Paused jobs keep their fetched parts in the offscreen document — never
  // close it while anything is running OR paused. A blob URL a completed job
  // handed to chrome.downloads must also stay alive until the browser has
  // streamed it, so a pending save pins the document too.
  const active = [...jobMemory.values()].some((j) => j.status === "running" || j.status === "paused");
  if (active || hasPendingSave()) return;
  try {
    if (await offscreenExists()) {
      await chrome.offscreen.closeDocument();
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Peek at an HLS variant playlist to decide mux-vs-split: fMP4 (EXT-X-MAP
 * or .m4s/.mp4 segments) muxes into one file; TS stays two files.
 * Fail-closed to false (two files) on any fetch/parse problem.
 */
export async function probeHlsFmp4(tabId: number, variantUrl: string): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const net = lookupNet(tabId, variantUrl);
    const res = await fetch(variantUrl, {
      credentials: "include",
      signal: ctrl.signal,
      headers: net?.headers,
      referrer: net?.referrer,
      referrerPolicy: net?.referrer ? "unsafe-url" : undefined,
    });
    if (!res.ok) return false;
    const text = await res.text();
    if (/#EXT-X-MAP\s*:/i.test(text)) return true;
    const m = /^[^#\r\n]*\.(m4s|mp4|m4v|cmfv|cmfa)(\?[^#\r\n]*)?$/im.exec(text);
    if (m) return true;
    if (/^[^#\r\n]*\.ts(\?[^#\r\n]*)?$/im.test(text)) return false;
    return false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Segment lists starting with init-style fMP4 chunks. */
export function looksFmp4Segments(segments: string[]): boolean {
  const first = segments.find((s) => /\.(m4s|mp4|m4v|cmfv|cmfa)(\?|#|$)/i.test(s.split("?")[0]));
  if (first) return true;
  return !segments.some((s) => /\.ts(\?|#|$)/i.test(s.split("?")[0]));
}

// ---- naming + job construction -------------------------------------------

/** Extension from a detected filename, falling back to the media-type default. */
function extOfName(name: string, type: string): string {
  const m = /\.([a-z0-9]{2,5})$/i.exec(name ?? "");
  return m ? m[1].toLowerCase() : defaultExtForType(type);
}

/**
 * Final destination for an item: the user's filename template rendered with the
 * video's own metadata, placed inside the configured subfolder. An empty
 * template keeps the detected name (the subfolder still applies).
 */
async function computeDestination(
  item: MediaItem,
  variant?: Variant,
  overrideName?: string,
): Promise<{ filename: string; quality: string }> {
  const settings = await getSettings();
  const detected = overrideName
    ? basenameOf(overrideName)
    : item.filename || filenameForUrl(item.url, item.type, item.title);
  const quality = qualityLabel(variant);
  if (!settings.filenameTemplate) {
    return { filename: joinDownloadPath(settings.subfolder, detected), quality };
  }
  const name = renderFilename(
    settings.filenameTemplate,
    { title: item.title, quality, ext: extOfName(detected, item.type), host: item.url, type: item.type },
    detected.replace(/\.[a-z0-9]+$/i, ""),
  );
  return { filename: joinDownloadPath(settings.subfolder, name), quality };
}

/** Identity/metadata carried onto the job for the UI and the history page. */
interface JobMeta {
  itemUrl: string;
  variantId?: string;
  title?: string;
  pageUrl?: string;
  quality?: string;
  type?: MediaType;
}

function newJobState(req: DownloadJobRequest, meta: JobMeta): DownloadJobState {
  return {
    jobId: req.jobId,
    tabId: req.tabId,
    itemUrl: meta.itemUrl,
    variantId: meta.variantId,
    filename: req.filename,
    status: "running",
    done: 0,
    total: req.kind === "direct" ? 0 : (req.segments?.length ?? 0),
    unit: req.kind === "direct" ? "bytes" : "segments",
    bytesDone: 0,
    startedAt: Date.now(),
    stage: "fetching",
    updatedAt: Date.now(),
    title: meta.title,
    pageUrl: meta.pageUrl,
    quality: meta.quality,
    mediaType: meta.type,
  };
}

/** Persist, start the offscreen downloader, and hand it the request. */
async function createJob(req: DownloadJobRequest, meta: JobMeta): Promise<DownloadJobState> {
  const job = newJobState(req, meta);
  await upsertJob(job);
  await ensureOffscreen();
  await dispatchOffscreen(req, job);
  return job;
}

/** The tab's current URL (best-effort — pages may already be gone). */
async function pageUrlFor(tabId: number): Promise<string | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return typeof tab?.url === "string" ? tab.url : undefined;
  } catch {
    return undefined;
  }
}

export async function startDownload(
  tabId: number,
  itemUrl: string,
  variantId?: string,
  /** Reuse an interrupted job's id so its OPFS-persisted segments resume. */
  resumeJobId?: string,
): Promise<{ job: DownloadJobState; paired: boolean; merged: boolean; jobIds: string[] }> {
  const items = await getTabItems(tabId);
  const item = items.find((x) => x.url === itemUrl);
  if (!item) throw new Error("Video no longer listed for this tab. Rescan and try again.");
  if (item.drmProtected) throw new Error(item.drmReason ?? "Protected content — cannot download.");
  if (item.type === "blob") throw new Error("Blob/MSE stream — not directly downloadable.");

  const existing = resumeJobId ? jobMemory.get(resumeJobId) : undefined;
  const chosenVariant =
    item.variants?.find((v) => v.id === (variantId ?? item.variants?.[0]?.id)) ?? item.variants?.[0];
  const dest = await computeDestination(item, chosenVariant, existing?.filename);
  const metaFields: Omit<JobMeta, "itemUrl" | "variantId"> = {
    title: item.title,
    pageUrl: await pageUrlFor(tabId),
    quality: dest.quality,
    type: item.type,
  };

  // MSE capture downloads route through the tab's content script, which
  // pulls bytes from the page hook and streams them to the offscreen
  // document (existing DOWNLOAD_BLOB finalization). A video track pairs
  // with its session's audio track into ONE merged file.
  if (item.type === "blobfile") {
    // Page-held Blob: the content script slices the exact bytes out of the
    // page and streams them to the offscreen document (never re-fetched —
    // one-time URLs keep working).
    const jobId = newJobId();
    const job: DownloadJobState = {
      jobId,
      tabId,
      itemUrl,
      filename: dest.filename,
      status: "running",
      done: 0,
      total: 0,
      bytesDone: 0,
      startedAt: Date.now(),
      stage: "fetching",
      updatedAt: Date.now(),
      ...metaFields,
    };
    await upsertJob(job);
    await ensureOffscreen();
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "BLOB_DOWNLOAD",
        jobId,
        url: item.url,
        filename: job.filename,
      });
    } catch (err) {
      job.status = "error";
      job.error = `Could not reach the page: ${err instanceof Error ? err.message : String(err)} Reload the tab and retry.`;
      await upsertJob(job);
    }
    return { job, paired: false, merged: false, jobIds: [jobId] };
  }
  if (item.type === "capture") {
    if (!item.captureRef) throw new Error("Capture reference lost — Rescan while the video plays.");
    const [captureId, trackIdxRaw] = item.captureRef.split(":");
    const trackIdx = Number(trackIdxRaw) || 0;
    let pairTrackIdx: number | undefined;
    let filename = dest.filename;
    if (item.captureKind === "video") {
      const sessionPrefix = `capture:${captureId}:`;
      const sibling = items.find(
        (x) =>
          x.type === "capture" &&
          !x.drmProtected &&
          x.url !== itemUrl &&
          x.url.startsWith(sessionPrefix) &&
          x.captureKind === "audio",
      );
      if (sibling?.captureRef) {
        const parts = sibling.captureRef.split(":");
        pairTrackIdx = Number(parts[1]) || 0;
        // Single merged output (no -video/-audio split).
        filename = filename.replace(/-(video|audio)(?=\.[a-z0-9]+$)/i, "");
        if (!/\.[a-z0-9]+$/i.test(filename)) filename += ".mp4";
      }
    }
    const jobId = newJobId();
    const job: DownloadJobState = {
      jobId,
      tabId,
      itemUrl,
      filename,
      status: "running",
      done: 0,
      total: 0,
      bytesDone: 0,
      startedAt: Date.now(),
      stage: "fetching",
      updatedAt: Date.now(),
      ...metaFields,
    };
    await upsertJob(job);
    await ensureOffscreen();
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "MS_DOWNLOAD",
        jobId,
        captureId,
        trackIdx,
        pairTrackIdx,
        filename: job.filename,
      });
    } catch (err) {
      job.status = "error";
      job.error = `Could not reach the page capture: ${err instanceof Error ? err.message : String(err)} Reload the tab and retry.`;
      await upsertJob(job);
    }
    return { job, paired: pairTrackIdx !== undefined, merged: pairTrackIdx !== undefined, jobIds: [jobId] };
  }

  const jobId = resumeJobId ?? newJobId();
  // Per-origin replay scopes for every host this job will touch (cap 10).
  const scopeUrls: string[] = [];
  const seenOrigins = new Set<string>();
  const consider = (u: string | undefined) => {
    if (!u || seenOrigins.size >= 10) return;
    try {
      const o = new URL(u).origin;
      if (!seenOrigins.has(o)) {
        seenOrigins.add(o);
        scopeUrls.push(u);
      }
    } catch {
      /* ignore */
    }
  };
  let req: DownloadJobRequest;
  // Paired audio sibling for split A/V masters (e.g. X: video-only avc1
  // playlist + audio-only mp4a playlist). fMP4 pairs mux into ONE file;
  // anything else falls back to two files (today's pairReq path).
  let pairReq: DownloadJobRequest | null = null;
  if (item.type === "hls" || item.type === "dash") {
    const variant = chosenVariant;
    if (!variant) throw new Error(item.error ?? "Manifest not parsed yet — reopen the popup in a moment and retry.");
    if (item.type === "hls") {
      consider(variant.url);
      req = { jobId, tabId, kind: "hls", url: variant.url, filename: dest.filename, mime: "video/mp2t" };
      const cc = codecsOf(variant);
      if (hasVideoCodec(cc) && !hasAudioCodec(cc)) {
        // Audio for a video-only variant comes from either (a) a sibling
        // audio-only variant in the list, or (b) an #EXT-X-MEDIA audio
        // rendition playlist attached at parse time (variant.audioUrl).
        const audioVariant = item.variants?.find((v) => {
          const c = codecsOf(v);
          return hasAudioCodec(c) && !hasVideoCodec(c);
        });
        const audioUrl = audioVariant?.url ?? variant.audioUrl;
        if (audioUrl) {
          consider(audioUrl);
          const stem = req.filename.replace(/\.[a-z0-9]+$/i, "");
          // Mux only when BOTH tracks are fMP4 (TS audio can't merge into mp4).
          const [vFmp4, aFmp4] = await Promise.all([
            probeHlsFmp4(tabId, variant.url),
            probeHlsFmp4(tabId, audioUrl),
          ]);
          if (vFmp4 && aFmp4) {
            req.pairUrl = audioUrl;
            req.filename = `${stem}.mp4`;
          } else {
            // Non-fMP4 pair (e.g. TS): two files, as before.
            req.filename = `${stem}-video.ts`;
            pairReq = {
              jobId: newJobId(),
              tabId,
              kind: "hls",
              url: audioUrl,
              filename: `${stem}-audio.m4a`,
              mime: "video/mp4",
            };
          }
        }
      }
    } else {
      // DASH: re-resolve the manifest at download time so signed segment
      // URLs are fresh (stored variants may have expired since detection).
      let dashVariant = variant;
      let dashAudio = item.variants?.find((v) => {
        const c = codecsOf(v);
        return hasAudioCodec(c) && !hasVideoCodec(c) && (v.segments?.length ?? 0) > 0;
      });
      try {
        const freshText = await fetchManifestText(tabId, item.url);
        const fresh = parseDashManifest(freshText, item.url);
        const fv = fresh.variants.find((v) => v.id === variant.id) ?? fresh.variants[0];
        if (fv?.segments?.length) {
          dashVariant = { ...variant, segments: fv.segments };
          const fa = fresh.variants.find((v) => {
            const c = codecsOf(v);
            return hasAudioCodec(c) && !hasVideoCodec(c) && (v.segments?.length ?? 0) > 0;
          });
          if (fa?.segments?.length) {
            dashAudio = { ...dashAudio, ...fa } as typeof dashAudio;
          }
          // Persist fresh segments so an immediate retry doesn't reuse stale URLs.
          await patchItem(tabId, item.url, { variants: fresh.variants });
        }
      } catch {
        /* offline/expired manifest — fall back to stored segments */
      }
      if (!dashVariant.segments?.length) throw new Error("No segments listed for this DASH variant.");
      consider(item.url);
      for (const s of dashVariant.segments) consider(s);
      req = { jobId, tabId, kind: "dash", url: item.url, segments: dashVariant.segments, filename: dest.filename, mime: "video/mp4" };
      const cc = codecsOf(dashVariant);
      if (hasVideoCodec(cc) && !hasAudioCodec(cc)) {
        const audio = dashAudio;
        if (audio?.segments?.length) {
          for (const s of audio.segments) consider(s);
          const stem = req.filename.replace(/\.[a-z0-9]+$/i, "");
          if (looksFmp4Segments(dashVariant.segments ?? []) && looksFmp4Segments(audio.segments)) {
            req.pairSegments = [...audio.segments];
            req.filename = `${stem}.mp4`;
          } else {
            req.filename = `${stem}-video.mp4`;
            pairReq = {
              jobId: newJobId(),
              tabId,
              kind: "dash",
              url: item.url,
              segments: [...audio.segments],
              filename: `${stem}-audio.m4a`,
              mime: "video/mp4",
            };
          }
        }
      }
    }
  } else if (item.type === "segments") {
    // Auto-grouped chunk traffic: same byte-concat path as DASH, container
    // sniffed at assembly time. No manifest, no DRM signals by construction
    // (encrypted chunks would fail closed at fetch/parse with a clear error).
    if (!item.segments?.length) throw new Error("No grouped segments for this video (group expired — Rescan while it plays).");
    consider(item.url);
    // Observed in network-arrival order (breaks on seeks/retries) — restore
    // numeric order before dispatch; the assembler validates playability.
    const orderedSegments = sortSegmentsNatural(item.segments);
    for (const s of orderedSegments) consider(s);
    req = { jobId, tabId, kind: "dash", url: item.url, segments: orderedSegments, filename: dest.filename, mime: "video/mp4" };
  } else {
    consider(item.url);
    req = { jobId, tabId, kind: "direct", url: item.url, filename: dest.filename };
  }
  // Attach per-origin replay contexts (auth scoped to capture origin).
  // Direct files need this too: script endpoints (.php) gate on the page's
  // referrer/cookies/headers — a bare download gets a stub instead.
  {
    const byOrigin: Record<string, NetReplay> = {};
    for (const u of scopeUrls) {
      const net = lookupNet(tabId, u);
      if (net) {
        try {
          byOrigin[new URL(u).origin] = net;
        } catch {
          /* ignore */
        }
      }
    }
    if (Object.keys(byOrigin).length) {
      req.netScope = { byOrigin };
      if (pairReq) pairReq.netScope = { byOrigin };
    }
  }

  // On resume, preserve the original job row (progress, startedAt) so the UI
  // reflects the continued download; only reset it to running (and clear the
  // stale speed samples for the reused id).
  if (resumeJobId) resetRate(resumeJobId);
  const job: DownloadJobState = existing
    ? {
        ...existing,
        status: "running",
        error: undefined,
        expired: undefined,
        stage: "fetching",
        updatedAt: Date.now(),
        ...metaFields,
      }
    : newJobState(req, {
        ...metaFields,
        itemUrl,
        variantId: variantId ?? (req.kind === "direct" ? undefined : item.variants?.[0]?.id),
      });
  await upsertJob(job);

  // Direct files fetch in-app (offscreen) with the page's auth context so
  // gated endpoints serve the real video, with validation + byte progress.
  // Oversized files fall back to the browser via DOWNLOAD_ERROR fallback.
  await ensureOffscreen();
  await dispatchOffscreen(req, job);
  let paired = false;
  const merged = !pairReq && (!!req.pairUrl || !!req.pairSegments);
  if (pairReq) {
    const pairJob = newJobState(pairReq, { ...metaFields, itemUrl, variantId: undefined });
    await upsertJob(pairJob);
    await dispatchOffscreen(pairReq, pairJob);
    paired = true;
  }
  const jobIds = [job.jobId];
  if (pairReq) jobIds.push(pairReq.jobId);
  return { job, paired: paired || merged, merged, jobIds };
}

/**
 * Register an item for a URL the worker hasn't seen (e.g. a direct file the
 * page loaded from cache, or a manifest reached before webRequest recorded
 * it). Manifests are parsed immediately so the download can start right away.
 * Returns the usable item, or undefined when the URL isn't downloadable.
 */
export async function ensureItemForUrl(
  tabId: number,
  candidates: string[],
  title?: string,
): Promise<MediaItem | undefined> {
  const httpish = candidates.filter((u) => /^https?:\/\//i.test(u));
  for (const url of httpish) {
    const items = await getTabItems(tabId);
    const found = items.find((x) => x.url === url);
    if (found) return found;
    const type = classify(url, "");
    if (!type || type === "blob" || type === "capture" || type === "blobfile") continue;
    const stem = title ? cleanTitle(title) : "";
    const item: MediaItem = {
      url,
      tabId,
      type,
      filename: filenameForUrl(url, type, stem || undefined),
      title: stem || undefined,
      autoNamed: !stem,
      detectedAt: Date.now(),
      drmProtected: false,
    };
    items.push(item);
    await persistTab(tabId, enforceCaps(items));
    await updateBadge(tabId);
    if (type === "hls" || type === "dash") {
      // Populate variants so startDownload can pick a quality immediately.
      // A parse failure is left on the item — startDownload surfaces its text.
      await parseStreamingItem(tabId, item);
      const after = await getTabItems(tabId);
      return after.find((x) => x.url === url) ?? item;
    }
    return item;
  }
  return undefined;
}

/** Deliver one assembled download to the offscreen document (with retries). */
export async function dispatchOffscreen(req: DownloadJobRequest, job: DownloadJobState): Promise<void> {
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
}

/**
 * Startup recovery. Ask the live offscreen document (if any) which job it is
 * actually running; only jobs it is NOT running were orphaned by a restart.
 * Re-fetchable kinds (HLS/DASH/grouped) resume from OPFS-persisted segments —
 * they become `paused` with a resume hint. Non-resumable kinds (direct /
 * capture, whose bytes lived only in the lost page/document) become errors.
 */
export async function markInterruptedJobs(): Promise<void> {
  try {
    await ensureJobsLoaded();
    // Several jobs can run at once (batch mode), so the live document reports
    // every job it is running, not just the most recent one.
    const activeJobIds = new Set<string>();
    if (await offscreenExists()) {
      try {
        const res = (await chrome.runtime.sendMessage({ type: "OFFSCREEN_STATUS" })) as
          | { activeJobId?: string | null; activeJobIds?: string[] }
          | undefined;
        for (const id of res?.activeJobIds ?? []) activeJobIds.add(id);
        if (res?.activeJobId) activeJobIds.add(res.activeJobId);
      } catch {
        // unreachable doc — treat everything as orphaned
      }
    }
    let dirty = false;
    for (const job of jobMemory.values()) {
      if (job.status !== "running" && job.status !== "paused") continue;
      if (activeJobIds.has(job.jobId)) continue; // genuinely still running
      job.updatedAt = Date.now();
      dirty = true;
      if (isResumableKind(job.itemUrl)) {
        // Segments persisted to OPFS survive; the user resumes without losing
        // progress. Keep the job resumable rather than dead.
        job.status = "paused";
        job.error =
          "Interrupted by a restart — downloaded segments were kept. Hit Resume to continue where it left off.";
      } else {
        job.status = "error";
        job.error =
          "Interrupted by a browser/extension restart — this stream can't be resumed. Hit Retry to start over.";
        job.expired = true;
      }
    }
    if (dirty) await persistJobs();
  } catch {
    /* best-effort */
  }
}

/** HLS/DASH/grouped are re-fetchable; direct/capture/blob streams are not. */
function isResumableKind(itemUrl: string): boolean {
  return !itemUrl.startsWith("capture:") && !itemUrl.startsWith("blob:");
}

// ---- history re-download --------------------------------------------------

/** Plain fetch (no page context) used to refresh a manifest for a re-download. */
async function fetchTextUnscoped(url: string): Promise<string> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Manifest fetch failed (${res.status})`);
  return res.text();
}

/** The live tab still showing this page — the richest re-download context. */
async function findTabForPage(pageUrl?: string): Promise<number | undefined> {
  if (!pageUrl) return undefined;
  let target: URL;
  try {
    target = new URL(pageUrl);
  } catch {
    return undefined;
  }
  try {
    for (const tab of await chrome.tabs.query({})) {
      if (tab.id == null || !tab.url) continue;
      if (tab.url === pageUrl) return tab.id;
      try {
        const u = new URL(tab.url);
        if (u.origin === target.origin && u.pathname === target.pathname) return tab.id;
      } catch {
        /* ignore malformed tab URLs */
      }
    }
  } catch {
    /* tabs API unavailable */
  }
  return undefined;
}

/** Direct-file kinds a history entry can reissue from its stored URL alone. */
const HISTORY_DIRECT_TYPES = new Set<MediaType>([
  "mp4", "webm", "ogg", "mov", "mkv", "avi", "flv", "wmv", "mpg",
]);

/**
 * Re-download a history entry. Prefers the original page (full auth context and
 * the site's own freshly re-signed URLs); otherwise rebuilds the job straight
 * from the stored source and lets the normal refresh-and-retry machinery
 * re-resolve fresh URLs from the manifest. Throws a clear, user-facing error
 * for sources whose bytes only ever lived in the page (captures, grouped
 * chunks) — those must be re-downloaded from the page itself.
 */
export async function redownloadHistoryEntry(entry: HistoryEntry): Promise<DownloadJobState> {
  const tabId = await findTabForPage(entry.pageUrl);
  if (tabId != null) {
    const items = await getTabItems(tabId);
    const match =
      items.find((x) => x.url === entry.itemUrl) ??
      items.find((x) => normalizeUrl(x.url) === normalizeUrl(entry.itemUrl));
    if (match && !match.drmProtected && match.type !== "blob") {
      const { job } = await startDownload(tabId, match.url, entry.variantId ?? match.variants?.[0]?.id);
      return job;
    }
  }
  return startHistoryJob(entry);
}

async function startHistoryJob(entry: HistoryEntry): Promise<DownloadJobState> {
  const type: MediaType = entry.type ?? classify(entry.itemUrl, "") ?? "unknown";
  const item: MediaItem = {
    url: entry.itemUrl,
    tabId: entry.tabId ?? -1,
    type,
    filename: entry.filename,
    title: entry.title,
    detectedAt: Date.now(),
    drmProtected: false,
  };
  const dest = await computeDestination(item);
  const jobId = newJobId();
  const tabId = entry.tabId ?? -1;
  const meta: JobMeta = {
    itemUrl: entry.itemUrl,
    title: entry.title,
    pageUrl: entry.pageUrl,
    type,
  };
  if (type === "hls") {
    const parsed = parseHlsManifest(await fetchTextUnscoped(entry.itemUrl), entry.itemUrl);
    if (parsed.drmProtected) throw new Error(parsed.drmReason ?? "Protected content — cannot download.");
    const variant = parsed.variants.find((v) => v.id === entry.variantId) ?? parsed.variants[0];
    if (!variant) throw new Error("This manifest no longer lists a downloadable quality.");
    let filename = dest.filename;
    let pairUrl: string | undefined;
    if (variant.audioUrl) {
      const [vFmp4, aFmp4] = await Promise.all([
        probeHlsFmp4(tabId, variant.url),
        probeHlsFmp4(tabId, variant.audioUrl),
      ]);
      if (!vFmp4 || !aFmp4) {
        throw new Error(
          "This video keeps its audio in a separate track that can't be merged outside its page — open the page and download there.",
        );
      }
      pairUrl = variant.audioUrl;
      filename = withExtPreservingDir(dest.filename, ".mp4");
    }
    return createJob(
      { jobId, tabId, kind: "hls", url: variant.url, pairUrl, filename, mime: "video/mp2t" },
      { ...meta, variantId: variant.id, quality: qualityLabel(variant) },
    );
  }
  if (type === "dash") {
    const parsed = parseDashManifest(await fetchTextUnscoped(entry.itemUrl), entry.itemUrl);
    if (parsed.drmProtected) throw new Error(parsed.drmReason ?? "Protected content — cannot download.");
    const variant = parsed.variants.find((v) => v.id === entry.variantId) ?? parsed.variants[0];
    if (!variant?.segments?.length) throw new Error("This manifest no longer lists downloadable segments.");
    return createJob(
      {
        jobId,
        tabId,
        kind: "dash",
        url: entry.itemUrl,
        segments: [...variant.segments],
        filename: dest.filename,
        mime: "video/mp4",
      },
      { ...meta, variantId: variant.id, quality: qualityLabel(variant) },
    );
  }
  if (HISTORY_DIRECT_TYPES.has(type)) {
    // The browser fetches it directly — no in-app assembly needed.
    const job = newJobState(
      { jobId, tabId, kind: "direct", url: entry.itemUrl, filename: dest.filename },
      meta,
    );
    await upsertJob(job);
    const downloadId = await chrome.downloads.download({
      url: entry.itemUrl,
      filename: dest.filename,
      saveAs: false,
    });
    job.downloadId = downloadId;
    job.status = "done";
    job.done = job.total || job.done;
    await upsertJob(job);
    return job;
  }
  throw new Error(
    "This download can't be rebuilt from its link (page-held capture or grouped stream). Open the page and download it there.",
  );
}
