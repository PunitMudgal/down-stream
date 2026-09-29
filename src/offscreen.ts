import {
  blobToDataUrl,
  capPartials,
  fetchDirectBlob,
  fetchSegmentedParts,
  fetchSegments,
  findInitChunk,
  isCapExceeded,
  isExpiredFailure,
  isGateFailure,
  isPlayableMp4,
  orderAndValidateSegmentParts,
  partFilename,
  planCaptureSplit,
  probeSpeed,
  sniffKind,
  type SegmentRelayFn,
  type SegmentedPart,
} from "./lib/download";
import { extractHlsSegments, parseHlsMediaPlaylist } from "./lib/parseHls";
import { parseDashManifest } from "./lib/parseDash";
import { resolveDashForDownload, resolveHlsForDownload, segmentConcurrencyFor } from "./lib/freshStream";
import { recordLive, type LivePollSnapshot, type LiveRecorderOptions, type LiveTrackDef } from "./lib/liveRecorder";
import {
  liveClear,
  liveCount,
  liveLoadInit,
  liveLoadMeta,
  liveLoadRange,
} from "./lib/liveRecord";
import { basenameOf, withExtPreservingDir } from "./lib/filename";
import { cleanCapturedStream, countInitTraks, describeCaptureCleanup } from "./lib/captureClean";
import { muxFmp4 } from "./lib/mp4mux";
import {
  clearJob as persistClearJob,
  loadSegments,
  persistSupported,
  saveMeta,
  saveSegment,
} from "./lib/persist";
import type { DownloadJobRequest, DownloadJobStage } from "./lib/types";

const controllers = new Map<string, AbortController>();
/** Jobs currently paused — fetch workers wait instead of taking new segments. */
const pausedJobs = new Set<string>();
/** Live recordings the user asked to stop (finish with what exists). */
const stoppingLive = new Set<string>();
/** Jobs this offscreen document instance is actively running (startup recovery).
 *  A Set because batch mode can run more than one download at once. */
const activeJobIds = new Set<string>();

/** Upper bound for one assembled file (matches the fetch-side cap). */
const MAX_ASSEMBLED_BYTES = 1_500_000_000;
/** Data-URL fallback ceiling — anything bigger must use direct save. */
const DIRECT_SAVE_FALLBACK_BYTES = 12_000_000;

interface CaptureAcc {
  parts: ArrayBuffer[];
  pairParts: ArrayBuffer[];
  received: number;
  total: number;
  mime: string;
  filename: string;
  /** Part counts per track once any track crosses the cap (undefined = fits). */
  split?: number[];
  /** Next part number per track (1-based) when splitting. */
  partNo: number[];
  /** Byte offset within each track's buffered parts. */
  offset: number[];
  /** The page hit its per-track capture cap — the tail was never buffered. */
  truncated?: boolean;
}
const captures = new Map<string, CaptureAcc>();
const cancelledCaptures = new Set<string>();

function report(msg: object): void {
  try {
    void chrome.runtime.sendMessage(msg);
  } catch {
    /* background may be momentarily unreachable — job state reconciles on GET_JOBS */
  }
}

function stage(jobId: string, s: DownloadJobStage): void {
  report({ type: "JOB_STAGE", jobId, stage: s });
}

// ---- page relay: bytes this document is not allowed to fetch ---------------
// A CDN can refuse THIS document's request (403/404, an error page served as
// video, a CORS refusal) while the page fetches the very same URL happily: the
// token, the Referer/Origin/Sec-Fetch-* context, the cookies, the TLS
// fingerprint and any bot clearance all belong to the page. So a refused
// segment (or variant playlist) is re-requested through the page — the worker
// forwards it to that tab's content script, whose MAIN-world hook fetches it
// and streams the bytes back in ≤4MB slices over the same broadcast channel
// the MSE capture already uses.
const PAGE_RELAY_TIMEOUT_MS = 120_000;
/** Page-side fetches are serialized: each holds a whole segment in the page. */
const PAGE_RELAY_CONCURRENCY = 2;
/** Per-job bound — a fully gated CDN must fail with a reason, not forever. */
const PAGE_RELAY_MAX_PER_JOB = 40;

interface PageTransfer {
  chunks: ArrayBuffer[];
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (buf: ArrayBuffer) => void;
  reject: (err: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}
const pageTransfers = new Map<string, PageTransfer>();
const relayedByJob = new Map<string, number>();
let relayActive = 0;
const relayWaiters: Array<() => void> = [];

/** Finish (or fail) one in-flight page transfer exactly once. */
function relaySettle(transferId: string, err: Error | null, buf?: ArrayBuffer): void {
  const t = pageTransfers.get(transferId);
  if (!t) return;
  pageTransfers.delete(transferId);
  clearTimeout(t.timer);
  if (t.onAbort) t.signal?.removeEventListener("abort", t.onAbort);
  if (!err) {
    t.resolve(buf ?? new ArrayBuffer(0));
    return;
  }
  // Nobody is waiting for these bytes anymore — tell the page to stop.
  report({ type: "PAGE_BYTES_CANCEL", transferId });
  t.reject(err);
}

async function acquireRelaySlot(signal?: AbortSignal): Promise<void> {
  while (relayActive >= PAGE_RELAY_CONCURRENCY) {
    if (signal?.aborted) throw new Error("Download cancelled.");
    await new Promise<void>((resolve) => relayWaiters.push(resolve));
  }
  relayActive++;
}

function releaseRelaySlot(): void {
  relayActive = Math.max(0, relayActive - 1);
  relayWaiters.shift()?.();
}

/** Ask the page to fetch one URL and collect the slices it streams back. */
function relaySegmentThroughPage(
  url: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  const transferId = `pg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        relaySettle(
          transferId,
          new Error("The page relay timed out — the page stopped sending bytes."),
        ),
      PAGE_RELAY_TIMEOUT_MS,
    );
    const entry: PageTransfer = { chunks: [], bytes: 0, timer, resolve, reject, signal };
    const onAbort = (): void => relaySettle(transferId, new Error("Download cancelled."));
    entry.onAbort = onAbort;
    pageTransfers.set(transferId, entry);
    if (signal) {
      if (signal.aborted) {
        relaySettle(transferId, new Error("Download cancelled."));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    void chrome.runtime
      .sendMessage({ type: "REQUEST_PAGE_BYTES", jobId, transferId, url })
      .then((res) => {
        const r = res as { ok?: boolean; error?: string } | undefined;
        if (!r?.ok) {
          relaySettle(
            transferId,
            new Error(r?.error ?? "The page relay is unavailable for this download."),
          );
        }
      })
      .catch((err: unknown) =>
        relaySettle(transferId, err instanceof Error ? err : new Error(String(err))),
      );
  });
}

/** Per-job relay transport: bounded count and bounded concurrency. */
function pageRelayFor(jobId: string): SegmentRelayFn {
  return async (url, signal) => {
    const used = relayedByJob.get(jobId) ?? 0;
    if (used >= PAGE_RELAY_MAX_PER_JOB) {
      throw new Error(
        `This site refused ${PAGE_RELAY_MAX_PER_JOB} stream chunks and the page relay hit its limit — replay the video, hit Rescan, and retry right away.`,
      );
    }
    await acquireRelaySlot(signal);
    try {
      const buf = await relaySegmentThroughPage(url, jobId, signal);
      relayedByJob.set(jobId, used + 1);
      if (used === 0) {
        report({
          type: "JOB_NOTE",
          jobId,
          note: "Fetched through this page's own session — the site blocks direct requests.",
        });
      }
      return buf;
    } finally {
      releaseRelaySlot();
    }
  };
}

/** Drop per-job relay bookkeeping (called when a job settles). */
function clearRelayStats(jobId: string): void {
  relayedByJob.delete(jobId);
}

// Blob URLs this document created and has not revoked yet (RELEASE_BLOB_URL
// arrives once chrome.downloads has finished streaming them).
const liveBlobUrls = new Set<string>();

function revokeBlobUrl(url: string): void {
  liveBlobUrls.delete(url);
  try {
    URL.revokeObjectURL(url);
  } catch {
    /* ignore */
  }
}

/** Safety valve: never leak a blob URL if a completion event goes missing. */
function revokeLater(url: string, ms: number): void {
  liveBlobUrls.add(url);
  setTimeout(() => revokeBlobUrl(url), ms);
}

/**
 * Save an assembled Blob and return its chrome.downloads id (when tracked).
 *
 * PRIMARY: hand the blob URL to the background worker, which owns
 * `chrome.downloads.download` — that is what makes the configured subfolder AND
 * templated filename apply, and yields a download id for "Show in folder". The
 * worker revokes the URL once the transfer finishes, so the URL (and this
 * document) stay alive until then.
 *
 * FALLBACK (worker unreachable): anchor download from this document. Chrome
 * ignores path separators in the `download` attribute, so only the basename is
 * honoured — the bytes still land, just at the downloads root.
 */
async function saveBlob(jobId: string, blob: Blob, filename: string): Promise<number | undefined> {
  if (!blob || blob.size === 0) {
    throw new Error("Assembled file is empty — nothing was captured.");
  }
  const url = URL.createObjectURL(blob);
  try {
    const res = (await chrome.runtime.sendMessage({
      type: "SAVE_BLOB_URL",
      jobId,
      blobUrl: url,
      filename,
    })) as { ok?: boolean; downloadId?: number } | undefined;
    if (res?.ok && typeof res.downloadId === "number") {
      revokeLater(url, 6 * 3_600_000);
      return res.downloadId;
    }
  } catch {
    /* worker unreachable — fall through to the anchor */
  }
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = basenameOf(filename);
    (document.body ?? document.documentElement).appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    revokeBlobUrl(url);
    throw err;
  }
  // The browser streams the download FROM the blob URL for the whole
  // transfer — revoking early aborts slow/large downloads. A 1.5 GB file
  // at 0.5 Mbps needs ~7h; keep the URL alive 12h (the offscreen document
  // closing reclaims it sooner anyway).
  revokeLater(url, 12 * 3_600_000);
  // Grace period for the browser to claim the blob URL before reporting.
  await new Promise((r) => setTimeout(r, 1500));
  return undefined;
}

/**
 * Save an assembled file. PRIMARY PATH: anchor download straight from this
 * document — zero bytes cross extension messaging, so files of any size
 * work and oversized-payload failures ("corrupt file payload") disappear.
 * FALLBACK: small files only, via the legacy data-URL worker handoff.
 */
async function finalizeJobFile(
  jobId: string,
  blob: Blob,
  filename: string,
  note?: string,
): Promise<void> {
  stage(jobId, "saving");
  try {
    const downloadId = await saveBlob(jobId, blob, filename);
    report({ type: "DOWNLOAD_DONE", jobId, filename, note, downloadId });
  } catch (err) {
    if (blob.size > DIRECT_SAVE_FALLBACK_BYTES) throw err;
    const dataUrl = await blobToDataUrl(blob);
    try {
      await chrome.runtime.sendMessage({
        type: "DOWNLOAD_BLOB",
        jobId,
        dataUrl,
        filename,
      });
    } catch (e) {
      throw new Error(
        `Assembled ${(blob.size / 1_000_000).toFixed(1)} MB but the handoff to the background worker failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/**
 * Name the output by actual container: MPEG-TS starts with sync byte 0x47,
 * fragmented MP4 starts with an 'ftyp' box. HLS can be either.
 */
async function sniffExtension(blob: Blob, fallback: string): Promise<string> {
  try {
    const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
    if (head[0] === 0x47) return ".ts";
    if (head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) {
      return ".mp4"; // ftyp
    }
  } catch {
    /* fall through */
  }
  return fallback;
}

/** Swap the extension while keeping the configured subfolder intact. */
function withExtension(filename: string, ext: string): string {
  return withExtPreservingDir(filename, ext);
}

type NetScope = NonNullable<DownloadJobRequest["netScope"]>;

async function textWithNet(url: string, scope: NetScope | undefined, signal: AbortSignal): Promise<string> {
  let net;
  try {
    net = scope?.byOrigin[new URL(url).origin];
  } catch {
    net = undefined;
  }
  const res = await fetch(url, {
    credentials: "include",
    cache: "no-store",
    signal,
    headers: net?.headers,
    referrer: net?.referrer,
    referrerPolicy: net?.referrer ? "unsafe-url" : undefined,
  });
  if (!res.ok) throw new Error(`Playlist fetch failed (${res.status})`);
  return res.text();
}

/**
 * Read a playlist, falling back to the page's own request context when this
 * document is refused. The gate that blocks segments usually blocks the
 * variant playlist too, and nothing downloads if that read fails.
 */
async function textWithNetRelayed(
  job: DownloadJobRequest,
  url: string,
  scope: NetScope | undefined,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await textWithNet(url, scope, signal);
  } catch (err) {
    if (signal.aborted || !isGateFailure(err)) throw err;
    try {
      const buf = await pageRelayFor(job.jobId)(url, signal);
      return new TextDecoder().decode(buf);
    } catch {
      throw err; // the original, more specific failure
    }
  }
}

/**
 * Resolve the audio sibling's segment list for a paired job.
 * Returns null when this job has no pair (normal single-track path).
 */
async function resolvePairSegments(
  job: DownloadJobRequest,
  scope: NetScope | undefined,
  signal: AbortSignal,
): Promise<string[] | null> {
  if (job.pairSegments?.length) return [...job.pairSegments];
  if (job.kind === "hls" && job.pairUrl) {
    const text = await textWithNetRelayed(job, job.pairUrl, scope, signal);
    const segs = extractHlsSegments(text, job.pairUrl);
    if (!segs.length) throw new Error("Paired audio playlist has no segments.");
    return segs;
  }
  return null;
}

function toU8(parts: ArrayBuffer[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let off = 0;
  for (const p of parts) {
    out.set(new Uint8Array(p), off);
    off += p.byteLength;
  }
  return out;
}

type ByteProgress = (done: number, total: number, bytesDone?: number) => void;

/** Split containers: continuation parts stay playable (TS concatenates; fMP4 gets the init header). */
type SplittableContainer = "ts" | "fmp4";

interface TrackSaveOpts {
  jobId: string;
  baseFilename: string;
  mime: string;
  fallbackExt: string;
  urls: string[];
  scope: NetScope | undefined;
  signal: AbortSignal;
  isPaused: () => boolean;
  /** Re-resolve the segment list when signed URLs expire (HLS); absent = fail like before. */
  refreshUrls?: () => Promise<string[] | null>;
  /** Parallel segment fetches (lower on short-lived signed CDNs). */
  concurrency?: number;
  /** Playlist-ordered progress across the whole track. */
  onSegs: (done: number, total: number, bytesDone: number) => void;
  /** When true, even a lone part saves without reporting DONE (caller reports once for several tracks). */
  deferDone?: boolean;
  /** Persist each fetched segment (absolute index) for restart-resume. */
  onSegmentDone?: (absIndex: number, buf: ArrayBuffer) => void;
  /** Segments recovered from a prior session (absolute indices; holes refetch). */
  resumedParts?: Array<ArrayBuffer | undefined>;
}

interface TrackSaveResult {
  parts: number;
  multi: boolean;
  bytes: number;
  firstFile: string;
  lastFile: string;
}

/**
 * Fetch one track's segments and save them, splitting into sequential
 * `.partN` files when the total exceeds the in-app safety cap instead of
 * failing. Files under the cap take the exact legacy path (single fetch,
 * validate, Blob, finalize with data-URL fallback). Every part is
 * validated before saving; fMP4 continuation parts get the cached init
 * header prepended so each part plays standalone. Buffers are released
 * after each part, so peak memory stays near one part, not the whole file.
 */
async function saveTrackInParts(opts: TrackSaveOpts): Promise<TrackSaveResult> {
  const total = opts.urls.length;
  if (total === 0) throw new Error("No segments listed for this variant.");
  let savedSegs = 0;
  let savedBytes = 0;
  let winDone = 0;
  let winBytes = 0;
  let initChunk: ArrayBuffer | undefined;
  let container: SplittableContainer | "other" | undefined;
  let firstFile = "";
  let lastFile = "";

  const reportSegs = (): void => {
    opts.onSegs(savedSegs + winDone, total, savedBytes + winBytes);
  };

  const fetchRange = async (
    win: string[],
    ropts: {
      start: number;
      end: number;
      existingParts?: Array<ArrayBuffer | undefined>;
    },
  ): Promise<ArrayBuffer[]> => {
    winDone = 0;
    winBytes = 0;
    reportSegs();
    const prog = (_d: number, _t: number, b?: number): void => {
      winDone = _d;
      if (typeof b === "number") winBytes = b;
      reportSegs();
    };
    const attempt = (
      u: string[],
      existing?: Array<ArrayBuffer | undefined>,
    ): Promise<ArrayBuffer[]> =>
      fetchSegments(u, prog, opts.signal, opts.scope, {
        isPaused: opts.isPaused,
        relay: pageRelayFor(opts.jobId),
        existingParts: existing,
        concurrency: opts.concurrency,
        refreshUrls: opts.refreshUrls
          ? async () => {
              const all = await opts.refreshUrls!();
              if (!all || all.length !== total) return null;
              for (let i = 0; i < all.length; i++) opts.urls[i] = all[i];
              return all.slice(ropts.start, ropts.end);
            }
          : undefined,
        onSegmentDone: opts.onSegmentDone
          ? (i, buf) => {
              try {
                opts.onSegmentDone!(ropts.start + i, buf);
              } catch {
                /* best-effort */
              }
            }
          : undefined,
      });
    // Overlay any segments recovered from a prior session onto this window so
    // they are never refetched after a restart.
    let windowExisting = ropts.existingParts;
    if (opts.resumedParts) {
      const slice = opts.resumedParts.slice(ropts.start, ropts.end);
      if (slice.some(Boolean)) {
        windowExisting = windowExisting
          ? windowExisting.map((b, i) => b ?? slice[i])
          : slice;
      }
    }
    try {
      return await attempt(win, windowExisting);
    } catch (err) {
      if (opts.signal.aborted) throw err;
      if (isCapExceeded(err)) throw err; // the splitter binary-searches a fitting range
      if (!opts.refreshUrls || opts.isPaused() || !isExpiredFailure(err)) throw err;
      // One playlist refresh per window: signed segment URLs expire
      // mid-download (403/410); fresh URLs for the same indices resume it.
      let fresh: string[] | null = null;
      try {
        fresh = await opts.refreshUrls();
      } catch {
        throw err; // refresh itself failed — surface the original expiry error
      }
      if (!fresh || fresh.length !== total) throw err;
      const partials = capPartials(err);
      return await attempt(
        fresh.slice(ropts.start, ropts.end),
        partials && partials.length === win.length ? partials : undefined,
      );
    }
  };

  const savePart = async (part: SegmentedPart, partNo: number, multi: boolean): Promise<void> => {
    if (opts.signal.aborted) throw new Error("Download cancelled.");
    stage(opts.jobId, "assembling");
    let ordered: ArrayBuffer[];
    try {
      ordered = orderAndValidateSegmentParts(part.buffers);
    } catch (err) {
      const missingInit =
        err instanceof Error && /header segment wasn't captured/i.test(err.message);
      if (partNo > 1 && initChunk && missingInit) {
        ordered = orderAndValidateSegmentParts([initChunk, ...part.buffers]);
      } else {
        throw err;
      }
    }
    if (partNo === 1) {
      const head = new Uint8Array(ordered[0], 0, Math.min(8, ordered[0].byteLength));
      const kind = sniffKind(head);
      if (kind === "fmp4") {
        container = "fmp4";
        initChunk = findInitChunk(ordered);
      } else if (kind === "ts") {
        container = "ts";
      } else {
        container = "other";
      }
    } else if (container !== "ts" && container !== "fmp4") {
      throw new Error(
        "This video is too large for a single file, and its format can't be split into parts — pick a lower quality from the quality dropdown and retry.",
      );
    }
    let blobParts = ordered;
    if (multi && container === "fmp4" && initChunk) {
      // fMP4 part files must carry the init header (ftyp/moov) — the player
      // needs it on EVERY part, not just the first. Parts 2..N get the init
      // chunk prepended so every .partN file plays standalone.
      blobParts = [initChunk, ...ordered];
    }
    const blob = new Blob(blobParts, { type: opts.mime });
    const ext = await sniffExtension(blob, opts.fallbackExt);
    const filename = multi
      ? partFilename(opts.baseFilename, partNo, ext)
      : withExtension(opts.baseFilename, ext);
    if (!multi && !opts.deferDone) {
      // Legacy single-file path, data-URL fallback included.
      await finalizeJobFile(opts.jobId, blob, filename);
    } else {
      stage(opts.jobId, "saving");
      await saveBlob(opts.jobId, blob, filename);
    }
    if (!firstFile) firstFile = filename;
    lastFile = filename;
    savedSegs += part.end - part.start;
    savedBytes += blob.size;
    reportSegs();
  };

  const { parts, multi } = await fetchSegmentedParts(opts.urls, fetchRange, savePart);
  return { parts, multi, bytes: savedBytes, firstFile, lastFile };
}

function playlistFetcher(
  job: DownloadJobRequest,
  scope: NetScope | undefined,
  signal: AbortSignal,
): (url: string) => Promise<string> {
  return (url) => textWithNetRelayed(job, url, scope, signal);
}

/** Re-resolve this job's segment list from the live master/MPD. */
function makeRefreshUrls(
  job: DownloadJobRequest,
  scope: NetScope | undefined,
  signal: AbortSignal,
): (() => Promise<string[] | null>) | undefined {
  const fetchText = playlistFetcher(job, scope, signal);
  if (job.kind === "hls") {
    const root = job.masterUrl ?? job.url;
    return async () => {
      const plan = await resolveHlsForDownload(root, job.variantId, fetchText);
      return job.track === "audio" ? (plan.pairSegments ?? null) : plan.segments;
    };
  }
  if (job.kind === "dash" && job.masterUrl) {
    return async () => {
      const plan = await resolveDashForDownload(job.masterUrl as string, job.variantId, fetchText);
      return job.track === "audio" ? (plan.pairSegments ?? null) : plan.segments;
    };
  }
  return undefined;
}

/**
 * Resolve one track's segment URLs (HLS variant playlist or stored DASH list).
 */
async function resolveMainUrls(
  job: DownloadJobRequest,
  scope: NetScope | undefined,
  signal: AbortSignal,
): Promise<string[]> {
  if (job.segments?.length) return [...job.segments];
  if (job.kind === "hls") {
    const text = await textWithNetRelayed(job, job.url, scope, signal);
    const mainUrls = extractHlsSegments(text, job.url);
    if (!mainUrls.length) throw new Error("No segments found in the HLS variant playlist.");
    return mainUrls;
  }
  const mainUrls = [...(job.segments ?? [])];
  if (!mainUrls.length) throw new Error("No segments listed for this variant.");
  return mainUrls;
}

/**
 * Single-track download (HLS / DASH / grouped segments) with automatic
 * multi-part fallback past the safety cap. Reports DOWNLOAD_DONE itself:
 * plain for single files, with a part-file note for split sets.
 */
async function downloadSingleTrack(
  job: DownloadJobRequest,
  urls: string[],
  mime: string,
  fallbackExt: string,
  scope: NetScope | undefined,
  signal: AbortSignal,
  onProgress: ByteProgress,
): Promise<void> {
  const isPaused = (): boolean => pausedJobs.has(job.jobId);
  const refreshUrls = makeRefreshUrls(job, scope, signal);
  const concurrency = job.concurrency ?? segmentConcurrencyFor(urls);
  // Resumability: hydrate segments persisted before a restart; write each new
  // segment to OPFS as it lands. Only re-fetchable kinds persist (direct /
  // capture streams are not).
  let onSegmentDone: ((absIndex: number, buf: ArrayBuffer) => void) | undefined;
  let resumedParts: Array<ArrayBuffer | undefined> | undefined;
  if (await persistSupported()) {
    try {
      resumedParts = await loadSegments(job.jobId, urls.length);
      await saveMeta(job.jobId, urls.length); // pins count; refreshes staleness
      onSegmentDone = (absIndex, buf) => void saveSegment(job.jobId, absIndex, buf);
    } catch {
      resumedParts = undefined;
      onSegmentDone = undefined;
    }
  }
  let r: TrackSaveResult;
  try {
    r = await saveTrackInParts({
      jobId: job.jobId,
      baseFilename: job.filename,
      mime,
      fallbackExt,
      urls,
      scope,
      signal,
      isPaused,
      refreshUrls,
      concurrency,
      onSegmentDone,
      resumedParts,
      onSegs: (done, total, bytesDone) => onProgress(done, total, bytesDone),
    });
  } catch (err) {
    // Keep persisted segments on expiry so a retry resumes; drop them when the
    // user cancels or the failure is not recoverable.
    if (signal.aborted) void persistClearJob(job.jobId);
    throw err;
  }
  // Track saved fully — its persisted segments are now dead weight.
  void persistClearJob(job.jobId);
  if (r.multi) {
    report({
      type: "DOWNLOAD_DONE",
      jobId: job.jobId,
      filename: job.filename,
      note: `Saved as ${r.parts} part files (${r.firstFile} … ${r.lastFile}) — join them in order for the full video.`,
    });
  }
  // Single files report DONE via finalizeJobFile inside saveTrackInParts.
}

/**
 * Fetch both tracks (progress combined across the two lists) and merge
 * into one multi-track fMP4. Throws a clear error for non-fMP4 pairs.
 */
async function assembleMuxedBlob(
  job: DownloadJobRequest,
  mainUrls: string[],
  pairUrls: string[],
  scope: NetScope | undefined,
  signal: AbortSignal,
  onProgress: (done: number, total: number, bytesDone?: number) => void,
): Promise<Blob> {
  const total = mainUrls.length + pairUrls.length;
  let done = 0;
  let bytesDone = 0;
  let vBytes = 0;
  let aBytes = 0;
  const isPaused = (): boolean => pausedJobs.has(job.jobId);
  const progV = (_d: number, _t: number, b?: number): void => {
    done++;
    if (typeof b === "number") vBytes = b;
    bytesDone = vBytes + aBytes;
    onProgress(done, total, bytesDone);
  };
  const progA = (_d: number, _t: number, b?: number): void => {
    done++;
    if (typeof b === "number") aBytes = b;
    bytesDone = vBytes + aBytes;
    onProgress(done, total, bytesDone);
  };
  const concurrency = job.concurrency ?? segmentConcurrencyFor(mainUrls);
  const refreshMain = makeRefreshUrls({ ...job, track: "main" }, scope, signal);
  const refreshAudio = makeRefreshUrls({ ...job, track: "audio" }, scope, signal);
  // Video first, then audio — order irrelevant, progress combined.
  const [vParts, aParts] = await Promise.all([
    fetchSegments(mainUrls, progV, signal, scope, {
      isPaused,
      relay: pageRelayFor(job.jobId),
      concurrency,
      refreshUrls: refreshMain,
    }),
    fetchSegments(pairUrls, progA, signal, scope, {
      isPaused,
      relay: pageRelayFor(job.jobId),
      concurrency,
      refreshUrls: refreshAudio,
    }),
  ]);
  stage(job.jobId, "assembling");
  let merged: Uint8Array;
  try {
    merged = muxFmp4(toU8(vParts), toU8(aParts));
  } catch (err) {
    throw new Error(
      `Could not merge video+audio (${err instanceof Error ? err.message : String(err)}). The tracks may use an unsupported container.`,
    );
  }
  return new Blob([merged.buffer as ArrayBuffer], { type: "video/mp4" });
}

function describeParts(r: TrackSaveResult): string {
  return r.multi ? `${r.parts} parts (${r.firstFile} … ${r.lastFile})` : r.firstFile;
}

/**
 * One sentence for everything the capture path had to repair or leave out, so a
 * finished download explains itself instead of quietly differing from the video.
 */
function capNote(notes: string[]): string {
  const lines = notes.map((n) =>
    n.replace(/^Repaired the captured buffer:\s*/i, "").replace(/\.\s*$/, ""),
  );
  return `Saved from the player's buffer: ${lines.join("; ")}.`;
}

/**
 * Split A/V download: merge video+audio into one file when it fits; past
 * the safety cap save each track as its own part-file set instead of
 * failing with "Video exceeds the 1.5 GB safety cap".
 */
async function downloadMuxed(
  job: DownloadJobRequest,
  pairUrls: string[],
  scope: NetScope | undefined,
  signal: AbortSignal,
  onProgress: ByteProgress,
): Promise<void> {
  const mainUrls = await resolveMainUrls(job, scope, signal);
  try {
    const blob = await assembleMuxedBlob(job, mainUrls, pairUrls, scope, signal, onProgress);
    await finalizeJobFile(job.jobId, blob, withExtension(job.filename, ".mp4"));
    return;
  } catch (err) {
    if (signal.aborted || !isCapExceeded(err)) throw err;
    // Too large to merge in-app — deliver each track's bytes as part files.
  }
  const stem = job.filename.replace(/\.[a-z0-9]+$/i, "") || job.filename;
  const total = mainUrls.length + pairUrls.length;
  const isPaused = (): boolean => pausedJobs.has(job.jobId);
  const refreshMain = makeRefreshUrls({ ...job, track: "main" }, scope, signal);
  const refreshAudio = makeRefreshUrls({ ...job, track: "audio" }, scope, signal);
  const concurrency = job.concurrency ?? segmentConcurrencyFor(mainUrls);
  let vSegs = 0;
  let vBytes = 0;
  const video = await saveTrackInParts({
    jobId: job.jobId,
    baseFilename: `${stem}-video`,
    mime: "video/mp4",
    fallbackExt: ".mp4",
    urls: mainUrls,
    scope,
    signal,
    isPaused,
    refreshUrls: refreshMain,
    concurrency,
    deferDone: true,
    onSegs: (d, _t, b) => {
      vSegs = d;
      vBytes = b;
      onProgress(d, total, b);
    },
  });
  const audio = await saveTrackInParts({
    jobId: job.jobId,
    baseFilename: `${stem}-audio`,
    mime: "video/mp4",
    fallbackExt: ".m4a",
    urls: pairUrls,
    scope,
    signal,
    isPaused,
    refreshUrls: refreshAudio,
    concurrency,
    deferDone: true,
    onSegs: (d, _t, b) => onProgress(vSegs + d, total, vBytes + b),
  });
  report({
    type: "DOWNLOAD_DONE",
    jobId: job.jobId,
    filename: job.filename,
    note: `Too large to merge into one file — saved video ${describeParts(video)} + audio ${describeParts(audio)}. Merge each pair with: ffmpeg -i <video> -i <audio> -c copy out.mp4`,
  });
}

/**
 * Spool finished capture parts to disk. Runs when an MSE capture crossed the
 * safety cap: instead of holding every buffered byte until MS_TRACK_END (and
 * failing), each track is written out as sequential `.partN` files as soon as
 * a part's share of the cap has accumulated. fMP4 parts carry the init header
 * so every part plays standalone. No-op while the job fits under the cap.
 */
async function spoolCaptureParts(jobId: string, flushAll = false): Promise<{ files: string[]; note?: string }> {
  const acc = captures.get(jobId);
  if (!acc || !acc.split) return { files: [] };
  const tracks: Array<{ parts: ArrayBuffer[]; idx: number; mime: string }> = [
    { parts: acc.parts, idx: 0, mime: acc.mime || "video/mp4" },
    { parts: acc.pairParts, idx: 1, mime: "audio/mp4" },
  ];
  const files: string[] = [];
  for (const t of tracks) {
    const count = acc.split[t.idx] ?? 1;
    if (count <= 1) continue;
    const target = Math.ceil(MAX_ASSEMBLED_BYTES / count);
    const stem = acc.filename.replace(/\.[a-z0-9]+$/i, "");
    for (;;) {
      const buffered = t.parts.reduce((n, p) => n + p.byteLength, 0) - acc.offset[t.idx];
      const isLastPart = acc.partNo[t.idx] === count;
      if (!flushAll && buffered < target) break;
      if (buffered <= 0) break;
      // Slice exactly `target` bytes (or the remainder on the final part)
      // out of the buffered chunks.
      const take = isLastPart ? buffered : Math.min(target, buffered);
      const out: ArrayBuffer[] = [];
      let remaining = take;
      let cursor = acc.offset[t.idx];
      while (remaining > 0 && t.parts.length) {
        const head = t.parts[0];
        const avail = head.byteLength - cursor;
        const n = Math.min(avail, remaining);
        out.push(head.slice(cursor, cursor + n));
        remaining -= n;
        cursor += n;
        if (cursor >= head.byteLength) {
          t.parts.shift();
          cursor = 0;
        }
      }
      acc.offset[t.idx] = cursor;
      // Every fMP4 part needs the init header to play standalone.
      const first = out[0] ? new Uint8Array(out[0]) : new Uint8Array(0);
      let payload = out;
      if (isPlayableMp4(first)) {
        const init = findInitChunk(out);
        if (init && acc.partNo[t.idx] > 1) payload = [init, ...out];
      }
      const blob = new Blob(payload, { type: t.mime });
      const ext = await sniffExtension(blob, t.idx === 1 ? ".m4a" : ".mp4");
      const label =
        t.idx === 1 ? `${stem}-audio` : acc.pairParts.length ? `${stem}-video` : stem;
      const filename = partFilename(label, acc.partNo[t.idx], ext);
      stage(jobId, "saving");
      await saveBlob(jobId, blob, filename);
      files.push(filename);
      acc.partNo[t.idx]++;
    }
  }
  const note = files.length
    ? `Saved as ${files.length} part file${files.length > 1 ? "s" : ""} — play them in order.`
    : undefined;
  return { files, note };
}

// ---- live HLS/DASH recording ----------------------------------------------

/**
 * Record a live broadcast: poll the growing playlist, append every new
 * segment, and roll bytes into `.partN` files as they accumulate. Ends when
 * the playlist closes (broadcast over) or the user presses Stop — either way
 * the captured bytes are saved, never thrown away.
 */
async function recordLiveJob(
  job: DownloadJobRequest,
  scope: NetScope | undefined,
  signal: AbortSignal,
): Promise<void> {
  // Per-job: concurrent recordings must never see each other's filenames.
  const savedFiles: string[] = [];
  const fetchText = (url: string): Promise<string> => textWithNetRelayed(job, url, scope, signal);
  const stem = job.filename.replace(/\.[a-z0-9]+$/i, "") || job.filename;
  const relay = pageRelayFor(job.jobId);

  // Recover bytes an interrupted session persisted but never spooled, so a
  // restart continues the recording instead of starting empty.
  let recovered: Pick<
    LiveRecorderOptions,
    "recoveredInit" | "recoveredPending" | "recoveredCount" | "recoveredHasInit"
  > = {};
  try {
    const meta = await liveLoadMeta(job.jobId);
    if (meta) {
      const n = await liveCount(job.jobId, 0);
      const segs =
        n > 0 ? ((await liveLoadRange(job.jobId, 0, 0, n)).filter(Boolean) as ArrayBuffer[]) : [];
      const init = meta.hasInit ? await liveLoadInit(job.jobId) : undefined;
      recovered = {
        recoveredInit: init,
        recoveredPending: segs.length ? segs : undefined,
        recoveredCount: segs.length,
        recoveredHasInit: false, // init is separate; spooling prepends it
      };
      if (segs.length) {
        report({
          type: "JOB_NOTE",
          jobId: job.jobId,
          note: `Recovered ${segs.length} recorded segments from before the interruption.`,
        });
      }
    }
  } catch {
    recovered = {};
  }

  const savePart = async (parts: ArrayBuffer[], partNo: number, last: boolean): Promise<string> => {
    const blob = new Blob(parts, { type: job.kind === "dash" ? "video/mp4" : "video/mp2t" });
    const ext = await sniffExtension(blob, job.kind === "dash" ? ".mp4" : ".ts");
    const filename = partNo === 1 ? withExtension(stem, ext) : partFilename(stem, partNo, ext);
    stage(job.jobId, "saving");
    await saveBlob(job.jobId, blob, filename);
    savedFiles.push(filename);
    if (last) stage(job.jobId, "fetching");
    return filename;
  };

  let def: LiveTrackDef;
  if (job.kind === "dash") {
    def = dashLiveDef(job, fetchText);
  } else {
    def = hlsLiveDef(job, fetchText);
  }

  report({ type: "JOB_NOTE", jobId: job.jobId, note: "Recording live stream — press Stop to finish." });
  const result = await recordLive(def, {
    jobId: job.jobId,
    signal,
    scope,
    isPaused: () => pausedJobs.has(job.jobId),
    isStopping: () => stoppingLive.has(job.jobId),
    relay,
    concurrency: job.concurrency,
    onProgress: (segs, bytes) =>
      report({ type: "DOWNLOAD_PROGRESS", jobId: job.jobId, done: segs, total: 0, bytesDone: bytes }),
    savePart,
    ...recovered,
  });

  // Recording finalized — its OPFS segments are dead weight.
  void liveClear(job.jobId);

  const files = [...savedFiles];
  if (!files.length) {
    throw new Error(
      result.segments === 0
        ? "Nothing was recorded — the live stream published no segments while recording."
        : "Recording produced no playable output.",
    );
  }
  const which =
    files.length === 1 ? files[0] : `${files.length} part files (${files[0]} … ${files[files.length - 1]})`;
  const note = stoppingLive.has(job.jobId)
    ? `Recording stopped — saved ${result.segments} segments as ${which}. Play in order.`
    : result.endedNaturally
      ? `Live broadcast ended — recorded ${result.segments} segments to ${which}.`
      : `Recorded ${result.segments} segments to ${which}.`;
  report({ type: "DOWNLOAD_DONE", jobId: job.jobId, filename: files[0], note });
}

/** DASH live: re-parse the MPD per poll; the window slides with the broadcast. */
function dashLiveDef(
  job: DownloadJobRequest,
  fetchText: (url: string) => Promise<string>,
): LiveTrackDef {
  const hasV = (c?: string): boolean => /(avc|hev|hvc|vp0?9|av0?1)/i.test(c ?? "");
  const hasA = (c?: string): boolean => /(mp4a|opus|ec-3|ac-3|ac-4)/i.test(c ?? "");
  const mpd = (job.masterUrl ?? job.url) as string;
  const pollTrack = async (wantAudio: boolean): Promise<LivePollSnapshot> => {
    const text = await fetchText(mpd);
    const parsed = parseDashManifest(text, job.url);
    if (parsed.drmProtected) {
      throw new Error(parsed.drmReason ?? "Protected content — cannot download.");
    }
    const v = wantAudio
      ? parsed.variants.find((x) => hasA(x.codecs) && !hasV(x.codecs) && (x.segments?.length ?? 0) > 0)
      : (parsed.variants.find((x) => x.id === job.variantId) ?? parsed.variants[0]);
    const segs = v?.segments ?? [];
    // The declared init segment (when any) is captured separately so it can
    // head every part file; the media segments are the recordable stream.
    const initUrl = v?.initUrl;
    return {
      entries: segs
        .filter((url) => url !== initUrl)
        .map((url, i) => ({ seq: i, url })),
      ended: parsed.isLive !== true,
      pollSec: parsed.minUpdatePeriodSec,
      initUrl,
      byUrl: true,
    };
  };
  const def: LiveTrackDef = { poll: () => pollTrack(false), pollSec: 2 };
  if (job.pairSegments?.length || job.pairUrl) {
    def.pair = { poll: () => pollTrack(true), pollSec: 2 };
  }
  return def;
}

/** HLS live: re-resolve through the master so rotated variants keep working. */
function hlsLiveDef(
  job: DownloadJobRequest,
  fetchText: (url: string) => Promise<string>,
): LiveTrackDef {
  const poll = async (): Promise<LivePollSnapshot> => {
    const plan = await resolveHlsForDownload(
      (job.masterUrl ?? job.url) as string,
      job.variantId,
      fetchText,
    );
    const info = parseHlsMediaPlaylist(await fetchText(plan.variant.url), plan.variant.url);
    return {
      entries: info.entries,
      ended: info.endList,
      pollSec: info.targetDurationSec,
      initUrl: info.initUrl,
    };
  };
  const def: LiveTrackDef = { poll, pollSec: 6 };
  if (job.pairUrl) {
    const pairUrl = job.pairUrl;
    def.pair = {
      pollSec: 6,
      poll: async (): Promise<LivePollSnapshot> => {
        const info = parseHlsMediaPlaylist(await fetchText(pairUrl), pairUrl);
        return {
          entries: info.entries,
          ended: info.endList,
          pollSec: info.targetDurationSec,
          initUrl: info.initUrl,
        };
      },
    };
  }
  return def;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = msg as any;
  // Bandwidth probe: sample the first few segments and report the measured
  // throughput so the popup can recommend a quality. Bytes are discarded.
  if (m?.type === "OFFSCREEN_PROBE" && typeof m.probeId === "string" && Array.isArray(m.urls)) {
    void (async () => {
      try {
        // Bounded by probeSpeed itself (n segments, byte budget, per-fetch
        // timeout) — no external cancel needed.
        const bps = await probeSpeed(m.urls as string[], { scope: m.netScope });
        try {
          sendResponse({ ok: true, bps });
        } catch {
          /* channel closed (popup dismissed) */
        }
      } catch (err) {
        try {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        } catch {
          /* ignore */
        }
      }
    })();
    return true; // async response
  }
  // Startup recovery handshake: the worker asks whether THIS document
  // instance is actually running the job before deciding a job is orphaned.
  if (m?.type === "OFFSCREEN_STATUS") {
    try {
      const ids = [...activeJobIds];
      sendResponse({ ok: true, activeJobIds: ids, activeJobId: ids[ids.length - 1] ?? null });
    } catch {
      /* ignore */
    }
    return false;
  }
  // The worker finished streaming a saved blob — release its URL now.
  if (m?.type === "RELEASE_BLOB_URL" && typeof m.blobUrl === "string") {
    revokeBlobUrl(m.blobUrl);
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  if (m?.type === "OFFSCREEN_CANCEL" && typeof m.jobId === "string") {
    controllers.get(m.jobId)?.abort();
    captures.delete(m.jobId);
    pausedJobs.delete(m.jobId);
    cancelledCaptures.add(m.jobId);
    stoppingLive.delete(m.jobId);
    void liveClear(m.jobId); // a discarded recording keeps no bytes
    clearRelayStats(m.jobId);
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  if (m?.type === "OFFSCREEN_PAUSE" && typeof m.jobId === "string") {
    pausedJobs.add(m.jobId);
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  if (m?.type === "OFFSCREEN_RESUME" && typeof m.jobId === "string") {
    pausedJobs.delete(m.jobId);
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  // Stop a live recording: the poll loop notices and finalizes what exists.
  if (m?.type === "OFFSCREEN_STOP" && typeof m.jobId === "string") {
    stoppingLive.add(m.jobId);
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  // Purge capture state for finished jobs (bounded memory: parts of a done
  // capture are dropped once the file is saved, so the offscreen doc doesn't
  // accumulate gigabytes across jobs). Cancelled jobs purge via the cancel path.
  if (m?.type === "PURGE_CAPTURE" && typeof m.jobId === "string") {
    captures.delete(m.jobId);
    cancelledCaptures.delete(m.jobId);
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  // Drop a job's OPFS-persisted segments (cancel, or a superseded download).
  if (m?.type === "PURGE_JOB_DATA" && typeof m.jobId === "string") {
    void persistClearJob(m.jobId);
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  // ---- MSE capture accumulation (bytes stream in from the content script,
  // paced one chunk per ack). Finalize reuses the DOWNLOAD_BLOB handoff. ----
  if (m?.type === "MS_TRACK_START" && typeof m.jobId === "string") {
    captures.set(m.jobId, {
      parts: [],
      pairParts: [],
      received: 0,
      total: typeof m.total === "number" ? m.total : 0,
      mime: typeof m.mime === "string" ? m.mime : "video/mp4",
      filename: typeof m.filename === "string" && m.filename ? m.filename : `capture-${m.jobId}.mp4`,
      partNo: [1, 1],
      offset: [0, 0],
      truncated: m.truncated === true,
    });
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  // Page-relayed bytes (sent by the tab's content script, addressed here).
  if (m?.type === "PAGE_BYTES_CHUNK" && typeof m.transferId === "string") {
    const t = pageTransfers.get(m.transferId);
    if (t && m.buf instanceof ArrayBuffer) {
      t.chunks.push(m.buf);
      t.bytes += m.buf.byteLength;
      if (m.done === true) {
        relaySettle(m.transferId, null, toU8(t.chunks).buffer as ArrayBuffer);
      }
    }
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  if (m?.type === "PAGE_BYTES_FAILED" && typeof m.transferId === "string") {
    relaySettle(
      m.transferId,
      new Error(
        typeof m.error === "string" && m.error
          ? m.error
          : "The page could not fetch this stream chunk.",
      ),
    );
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  if (m?.type === "MS_TRACK_CHUNK" && typeof m.jobId === "string") {
    const acc = captures.get(m.jobId);
    if (!acc || cancelledCaptures.has(m.jobId)) {
      try {
        sendResponse({ ok: true });
      } catch {
        /* ignore */
      }
      return false;
    }
    if (m.buf instanceof ArrayBuffer) {
      // The page keeps appending while we transfer, so the snapshot sent in
      // MS_TRACK_START goes stale — track the live total instead of showing
      // progress past 100%.
      if (typeof m.total === "number" && m.total > acc.total) acc.total = m.total;
      // which: 0 = primary track, 1 = paired audio track (muxed at END).
      if (m.which === 1) acc.pairParts.push(m.buf);
      else acc.parts.push(m.buf);
      acc.received += m.buf.byteLength;
      if (acc.split === undefined) {
        // One-time plan: once ANY track crosses the cap, lock in per-track
        // part counts. Below the cap this stays undefined (single-file path).
        const mainBytes = acc.parts.reduce((n, p) => n + p.byteLength, 0);
        const pairBytes = acc.pairParts.reduce((n, p) => n + p.byteLength, 0);
        const plan = planCaptureSplit([mainBytes, pairBytes], MAX_ASSEMBLED_BYTES);
        if (plan) acc.split = plan;
      }
      if (acc.split?.some((count) => count > 1)) {
        // Over-cap: spool finished parts out as they fill, so memory stays
        // near one part instead of the whole capture. The track that crossed
        // the cap is written as name.partN.ext files (each fMP4 part carries
        // its init header and plays standalone).
        void spoolCaptureParts(m.jobId).catch(() => {
          /* a failed spool is retried at MS_TRACK_END */
        });
      }
      report({ type: "DOWNLOAD_PROGRESS", jobId: m.jobId, done: acc.received, total: acc.total });
    }
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  if (m?.type === "MS_TRACK_END" && typeof m.jobId === "string") {
    const acc = captures.get(m.jobId);
    if (!acc?.split?.some((n) => n > 1)) captures.delete(m.jobId);
    if (!acc || cancelledCaptures.has(m.jobId)) {
      cancelledCaptures.delete(m.jobId);
      try {
        sendResponse({ ok: true });
      } catch {
        /* ignore */
      }
      return false;
    }
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
    void (async () => {
      try {
        if (!acc.parts.length && !acc.split?.some((n) => n > 1)) throw new Error("Capture arrived empty.");
        stage(m.jobId, "assembling");
        // Over-cap capture: parts were spooled as they filled — flush whatever
        // is still buffered and finish with the part-file note.
        if (acc.split?.some((n) => n > 1)) {
          const { files, note } = await spoolCaptureParts(m.jobId, true);
          captures.delete(m.jobId);
          report({ type: "DOWNLOAD_DONE", jobId: m.jobId, filename: files[0] ?? acc.filename, note });
          return;
        }
        const video = cleanCapturedStream(toU8(acc.parts));
        if (video.bytes.byteLength === 0) throw new Error("Capture arrived empty.");
        const audio = acc.pairParts.length ? cleanCapturedStream(toU8(acc.pairParts)) : undefined;
        const notes: string[] = [];
        for (const c of [video, audio]) {
          if (!c) continue;
          const line = describeCaptureCleanup(c);
          if (line) notes.push(line);
        }
        if (acc.truncated) {
          notes.push(
            "the page stopped buffering at its capture limit, so the last part of this video was never in the player's buffer",
          );
        }
        let blob: Blob;
        let filename = acc.filename;
        // A primary track whose init carries BOTH video and audio is already a
        // complete file (the player muxes them into one SourceBuffer); merging
        // the separate audio track into it is impossible and would only fail.
        const alreadyMuxed = countInitTraks(video.bytes) > 1;
        if (audio && audio.bytes.byteLength > 0 && !alreadyMuxed) {
          // Paired audio track present: merge into one file with sound.
          try {
            const merged = muxFmp4(video.bytes, audio.bytes);
            blob = new Blob([merged.buffer as ArrayBuffer], { type: "video/mp4" });
            filename = withExtension(acc.filename, ".mp4");
          } catch (err) {
            throw new Error(
              `Could not merge video+audio (${err instanceof Error ? err.message : String(err)}).`,
            );
          }
        } else {
          if (alreadyMuxed && audio && audio.bytes.byteLength > 0) {
            notes.push("the player buffers video and audio together, so the separate audio track was left out");
          }
          const vBytes =
            video.bytes.byteOffset === 0 && video.bytes.byteLength === video.bytes.buffer.byteLength
              ? (video.bytes.buffer as ArrayBuffer)
              : (video.bytes.slice().buffer as ArrayBuffer);
          blob = new Blob([vBytes], { type: acc.mime || "video/mp4" });
          const ext = await sniffExtension(blob, ".mp4");
          filename = withExtension(acc.filename, ext);
        }
        acc.parts = [];
        acc.pairParts = [];
        await finalizeJobFile(m.jobId, blob, filename, notes.length ? capNote(notes) : undefined);
      } catch (err) {
        report({
          type: "DOWNLOAD_ERROR",
          jobId: m.jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return false;
  }
  if (m?.type !== "OFFSCREEN_DOWNLOAD" || !m.job) return false;
  const job = m.job as DownloadJobRequest;
  // Acknowledge synchronously so the worker knows we got it.
  try {
    sendResponse({ received: true });
  } catch {
    /* ignore */
  }

  const controller = new AbortController();
  controllers.set(job.jobId, controller);
  const signal = controller.signal;
  activeJobIds.add(job.jobId);

  void (async () => {
    try {
      const onProgress = (done: number, total: number, bytesDone?: number) =>
        report({ type: "DOWNLOAD_PROGRESS", jobId: job.jobId, done, total, bytesDone });
      stage(job.jobId, "fetching");
      const scope = job.netScope;

      // Live HLS/DASH: record the growing playlist instead of downloading a
      // snapshot. Runs until the broadcast ends or the user stops it.
      if (job.live === true && (job.kind === "hls" || job.kind === "dash")) {
        await recordLiveJob(job, scope, signal);
        return;
      }

      // Direct files go through the page's own auth context (cookies +
      // captured same-origin headers + referrer). Script endpoints like
      // `remote_control.php` gate on exactly this — a bare browser download
      // misses it and the server answers with a stub or an HTML page.
      if (job.kind === "direct") {
        const onBytes = (received: number, total: number) =>
          report({ type: "DOWNLOAD_PROGRESS", jobId: job.jobId, done: received, total, bytesDone: received });
        const blob = await fetchDirectBlob(job.url, onBytes, signal, scope);
        const ext = await sniffExtension(blob, ".mp4");
        stage(job.jobId, "assembling");
        await finalizeJobFile(job.jobId, blob, withExtension(job.filename, ext));
        return;
      }

      // Paired split A/V (HLS pairUrl or DASH pairSegments): fetch both
      // tracks, then merge into ONE file with audio (per-track part files
      // when the merge would exceed the safety cap).
      const pairUrls = await resolvePairSegments(job, scope, signal);
      if (pairUrls) {
        await downloadMuxed(job, pairUrls, scope, signal, onProgress);
        return;
      }
      // Single track: HLS uses segments resolved at click time when present
      // (fresh tokens); otherwise reads the variant playlist here. DASH and
      // grouped jobs always carry a stored list. Over-cap lists save as
      // sequential part files instead of failing.
      if (job.kind === "hls") {
        let urls = job.segments?.length ? [...job.segments] : [];
        if (!urls.length) {
          const text = await textWithNetRelayed(job, job.url, scope, signal);
          if (/#EXT-X-KEY\s*:\s*[^\r\n]*METHOD\s*=\s*(?!NONE\b)/i.test(text)) {
            throw new Error("Protected content — cannot download (encrypted HLS).");
          }
          urls = extractHlsSegments(text, job.url);
        }
        if (!urls.length) throw new Error("No segments found in the HLS variant playlist.");
        await downloadSingleTrack(job, urls, "video/mp2t", ".ts", scope, signal, onProgress);
        return;
      }
      const urls = [...(job.segments ?? [])];
      if (!urls.length) throw new Error("No segments listed for this DASH variant.");
      await downloadSingleTrack(job, urls, "video/mp4", ".mp4", scope, signal, onProgress);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      report({
        type: "DOWNLOAD_ERROR",
        jobId: job.jobId,
        error: message,
        expired: isExpiredFailure(err),
        fallbackDirect: (err as unknown as Record<string, unknown>)?.fallbackDirect === true,
      } as unknown as Record<string, unknown> as never);
    } finally {
      controllers.delete(job.jobId);
      pausedJobs.delete(job.jobId);
      stoppingLive.delete(job.jobId);
      activeJobIds.delete(job.jobId);
      clearRelayStats(job.jobId);
    }
  })();
  return false;
});
