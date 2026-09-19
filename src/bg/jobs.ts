// Offscreen download orchestration (survives popup close).
// Moved verbatim from background.ts — zero behavior change.
//
// The offscreen document (runtime API only) assembles segment bytes;
// the worker performs the actual chrome.downloads.download(), which
// offscreen documents cannot call.
import { parseDashManifest } from "../lib/parseDash";
import { sortSegmentsNatural } from "../lib/download";
import type { DownloadJobRequest, DownloadJobState, NetReplay } from "../lib/types";
import { lookupNet } from "./headers";
import { fetchManifestText } from "./manifests";
import { codecsOf, hasAudioCodec, hasVideoCodec, patchItem } from "./media";
import { ensureJobsLoaded, getTabItems, jobMemory, persistJobs, upsertJob } from "./store";

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
  // close it while anything is running OR paused.
  const active = [...jobMemory.values()].some((j) => j.status === "running" || j.status === "paused");
  if (active) return;
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

export async function startDownload(
  tabId: number,
  itemUrl: string,
  variantId?: string,
): Promise<{ job: DownloadJobState; paired: boolean; merged: boolean }> {
  const items = await getTabItems(tabId);
  const item = items.find((x) => x.url === itemUrl);
  if (!item) throw new Error("Video no longer listed for this tab. Rescan and try again.");
  if (item.drmProtected) throw new Error(item.drmReason ?? "Protected content — cannot download.");
  if (item.type === "blob") throw new Error("Blob/MSE stream — not directly downloadable.");

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
      filename: item.filename || `video-${jobId}.mp4`,
      status: "running",
      done: 0,
      total: 0,
      bytesDone: 0,
      startedAt: Date.now(),
      stage: "fetching",
      updatedAt: Date.now(),
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
    return { job, paired: false, merged: false };
  }
  if (item.type === "capture") {
    if (!item.captureRef) throw new Error("Capture reference lost — Rescan while the video plays.");
    const [captureId, trackIdxRaw] = item.captureRef.split(":");
    const trackIdx = Number(trackIdxRaw) || 0;
    let pairTrackIdx: number | undefined;
    let filename = item.filename || `capture-${newJobId()}.mp4`;
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
    return { job, paired: pairTrackIdx !== undefined, merged: pairTrackIdx !== undefined };
  }

  const jobId = newJobId();
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
    const variant = item.variants?.find((v) => v.id === (variantId ?? item.variants?.[0]?.id)) ?? item.variants?.[0];
    if (!variant) throw new Error(item.error ?? "Manifest not parsed yet — reopen the popup in a moment and retry.");
    if (item.type === "hls") {
      consider(variant.url);
      req = { jobId, tabId, kind: "hls", url: variant.url, filename: item.filename, mime: "video/mp2t" };
      const cc = codecsOf(variant);
      if (hasVideoCodec(cc) && !hasAudioCodec(cc) && item.variants) {
        const audio = item.variants.find((v) => {
          const c = codecsOf(v);
          return hasAudioCodec(c) && !hasVideoCodec(c);
        });
        if (audio) {
          consider(audio.url);
          const stem = req.filename.replace(/\.[a-z0-9]+$/i, "");
          if (await probeHlsFmp4(tabId, variant.url)) {
            // Mux path: single merged .mp4 (offscreen fetches both playlists).
            req.pairUrl = audio.url;
            req.filename = `${stem}.mp4`;
          } else {
            // Non-fMP4 pair (e.g. TS): two files, as before.
            req.filename = `${stem}-video.ts`;
            pairReq = {
              jobId: newJobId(),
              tabId,
              kind: "hls",
              url: audio.url,
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
      req = { jobId, tabId, kind: "dash", url: item.url, segments: dashVariant.segments, filename: item.filename, mime: "video/mp4" };
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
    req = { jobId, tabId, kind: "dash", url: item.url, segments: orderedSegments, filename: item.filename, mime: "video/mp4" };
  } else {
    consider(item.url);
    req = { jobId, tabId, kind: "direct", url: item.url, filename: item.filename };
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

  const job: DownloadJobState = {
    jobId,
    tabId,
    itemUrl,
    variantId: variantId ?? (req.kind === "direct" ? undefined : item.variants?.[0]?.id),
    filename: req.filename,
    status: "running",
    done: 0,
    total: req.kind === "direct" ? 0 : (req.segments?.length ?? 0),
    unit: req.kind === "direct" ? "bytes" : "segments",
    bytesDone: 0,
    startedAt: Date.now(),
    updatedAt: Date.now(),
  };
  await upsertJob(job);

  // Direct files fetch in-app (offscreen) with the page's auth context so
  // gated endpoints serve the real video, with validation + byte progress.
  // Oversized files fall back to the browser via DOWNLOAD_ERROR fallback.
  await ensureOffscreen();
  await dispatchOffscreen(req, job);
  let paired = false;
  const merged = !pairReq && (!!req.pairUrl || !!req.pairSegments);
  if (pairReq) {
    const pairJob: DownloadJobState = {
      jobId: pairReq.jobId,
      tabId,
      itemUrl,
      variantId: undefined,
      filename: pairReq.filename,
      status: "running",
      done: 0,
      total: 0,
      bytesDone: 0,
      startedAt: Date.now(),
      stage: "fetching",
      updatedAt: Date.now(),
    };
    await upsertJob(pairJob);
    await dispatchOffscreen(pairReq, pairJob);
    paired = true;
  }
  return { job, paired: paired || merged, merged };
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

/** Startup recovery: jobs orphaned by a restart can never resume (parts lost). */
export async function markInterruptedJobs(): Promise<void> {
  try {
    await ensureJobsLoaded();
    // An offscreen document from BEFORE the restart holds no fetched parts for
    // these jobs (they were created in a prior session) — close it so its
    // existence doesn't wrongly signal "still running" below.
    if (await offscreenExists()) {
      try {
        await chrome.offscreen.closeDocument();
      } catch {
        /* best-effort */
      }
    }
    let dirty = false;
    for (const job of jobMemory.values()) {
      if (job.status === "running" || job.status === "paused") {
        job.status = "error";
        job.error = "Interrupted by a browser/extension restart — fetched parts were lost. Hit Retry for fresh URLs.";
        job.expired = true;
        job.updatedAt = Date.now();
        dirty = true;
      }
    }
    if (dirty) {
      await persistJobs();
    }
  } catch {
    /* best-effort */
  }
}
