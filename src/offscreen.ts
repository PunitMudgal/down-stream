import {
  blobToDataUrl,
  capPartials,
  fetchDirectBlob,
  fetchSegmentedParts,
  fetchSegments,
  findInitChunk,
  isCapExceeded,
  isExpiredFailure,
  isPlayableMp4,
  orderAndValidateSegmentParts,
  partFilename,
  planCaptureSplit,
  sniffKind,
  type SegmentedPart,
} from "./lib/download";
import { extractHlsSegments } from "./lib/parseHls";
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
/** The job this offscreen document instance is actively running (startup recovery). */
let activeJobId: string | undefined;

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

/**
 * Stream a Blob to the user's downloads via an anchor click straight from
 * this document — zero bytes cross extension messaging, so files of any
 * size work and oversized-payload failures ("corrupt file payload")
 * disappear. Callers report DOWNLOAD_DONE themselves (single files and
 * multi-part sets report differently).
 */
async function anchorSaveBlob(blob: Blob, filename: string): Promise<void> {
  if (!blob || blob.size === 0) {
    throw new Error("Assembled file is empty — nothing was captured.");
  }
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    (document.body ?? document.documentElement).appendChild(a);
    a.click();
    a.remove();
  } catch (err) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
    throw err;
  }
  // The browser streams the download FROM the blob URL for the whole
  // transfer — revoking early aborts slow/large downloads. A 1.5 GB file
  // at 0.5 Mbps needs ~7h; keep the URL alive 12h (the offscreen document
  // closing reclaims it sooner anyway).
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      /* ignore */
    }
  }, 12 * 3_600_000);
  // Grace period for the browser to claim the blob URL before reporting.
  await new Promise((r) => setTimeout(r, 1500));
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
    await anchorSaveBlob(blob, filename);
    report({ type: "DOWNLOAD_DONE", jobId, filename, note });
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

function withExtension(filename: string, ext: string): string {
  if (filename.toLowerCase().endsWith(ext)) return filename;
  return filename.replace(/\.[a-z0-9]+$/i, "") + ext;
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
    signal,
    headers: net?.headers,
    referrer: net?.referrer,
    referrerPolicy: net?.referrer ? "unsafe-url" : undefined,
  });
  if (!res.ok) throw new Error(`Playlist fetch failed (${res.status})`);
  return res.text();
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
    const text = await textWithNet(job.pairUrl, scope, signal);
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
        existingParts: existing,
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
      await anchorSaveBlob(blob, filename);
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

/**
 * Resolve one track's segment URLs (HLS variant playlist or stored DASH list).
 */
async function resolveMainUrls(
  job: DownloadJobRequest,
  scope: NetScope | undefined,
  signal: AbortSignal,
): Promise<string[]> {
  if (job.kind === "hls") {
    const text = await textWithNet(job.url, scope, signal);
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
  // HLS expiry refresher: re-resolve the variant playlist for fresh URLs.
  const refreshUrls =
    job.kind === "hls"
      ? async (): Promise<string[] | null> => {
          const retryText = await textWithNet(job.url, scope, signal);
          const fresh = extractHlsSegments(retryText, job.url);
          return fresh.length ? fresh : null;
        }
      : undefined;
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
  // Video first, then audio — order irrelevant, progress combined.
  const [vParts, aParts] = await Promise.all([
    fetchSegments(mainUrls, progV, signal, scope, { isPaused }),
    fetchSegments(pairUrls, progA, signal, scope, { isPaused }),
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
  // Signed HLS URLs expire mid-download; re-resolving the playlists keeps
  // long (large) fallback downloads alive, same as the single-track path.
  const refreshPlaylist =
    job.kind === "hls"
      ? (playlistUrl: string) =>
        async (): Promise<string[] | null> => {
          const retryText = await textWithNet(playlistUrl, scope, signal);
          const fresh = extractHlsSegments(retryText, playlistUrl);
          return fresh.length ? fresh : null;
        }
      : undefined;
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
    refreshUrls: refreshPlaylist?.(job.url),
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
    refreshUrls: job.pairUrl && refreshPlaylist ? refreshPlaylist(job.pairUrl) : undefined,
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
      await anchorSaveBlob(blob, filename);
      files.push(filename);
      acc.partNo[t.idx]++;
    }
  }
  const note = files.length
    ? `Saved as ${files.length} part file${files.length > 1 ? "s" : ""} — play them in order.`
    : undefined;
  return { files, note };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = msg as any;
  // Startup recovery handshake: the worker asks whether THIS document
  // instance is actually running the job before deciding a job is orphaned.
  if (m?.type === "OFFSCREEN_STATUS") {
    try {
      sendResponse({ ok: true, activeJobId: activeJobId ?? null });
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
    });
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
        let blob: Blob;
        let filename = acc.filename;
        if (acc.pairParts.length) {
          // Paired audio track present: merge into one file with sound.
          try {
            const merged = muxFmp4(toU8(acc.parts), toU8(acc.pairParts));
            blob = new Blob([merged.buffer as ArrayBuffer], { type: "video/mp4" });
            filename = withExtension(acc.filename, ".mp4");
          } catch (err) {
            throw new Error(
              `Could not merge video+audio (${err instanceof Error ? err.message : String(err)}).`,
            );
          }
        } else {
          blob = new Blob(acc.parts, { type: acc.mime || "video/mp4" });
          const ext = await sniffExtension(blob, ".mp4");
          filename = withExtension(acc.filename, ext);
        }
        acc.parts = [];
        acc.pairParts = [];
        await finalizeJobFile(m.jobId, blob, filename);
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
  activeJobId = job.jobId;

  void (async () => {
    try {
      const onProgress = (done: number, total: number, bytesDone?: number) =>
        report({ type: "DOWNLOAD_PROGRESS", jobId: job.jobId, done, total, bytesDone });
      stage(job.jobId, "fetching");
      const scope = job.netScope;

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
      // Single track: HLS resolves its variant playlist here (with the
      // encrypted-stream refusal); DASH/grouped use stored segment lists.
      // Over-cap lists save as sequential part files instead of failing.
      if (job.kind === "hls") {
        const text = await textWithNet(job.url, scope, signal);
        if (/#EXT-X-KEY\s*:\s*[^\r\n]*METHOD\s*=\s*(?!NONE\b)/i.test(text)) {
          throw new Error("Protected content — cannot download (encrypted HLS).");
        }
        const urls = extractHlsSegments(text, job.url);
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
      if (activeJobId === job.jobId) activeJobId = undefined;
    }
  })();
  return false;
});
