import {
  blobToDataUrl,
  fetchDirectBlob,
  fetchSegments,
  isExpiredFailure,
  orderAndValidateSegmentParts,
} from "./lib/download";
import { extractHlsSegments } from "./lib/parseHls";
import { muxFmp4 } from "./lib/mp4mux";
import type { DownloadJobRequest, DownloadJobStage } from "./lib/types";

const controllers = new Map<string, AbortController>();
/** Jobs currently paused — fetch workers wait instead of taking new segments. */
const pausedJobs = new Set<string>();

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
 * Save an assembled file. PRIMARY PATH: anchor download straight from this
 * document — zero bytes cross extension messaging, so files of any size
 * work and oversized-payload failures ("corrupt file payload") disappear.
 * FALLBACK: small files only, via the legacy data-URL worker handoff.
 */
async function finalizeJobFile(jobId: string, blob: Blob, filename: string): Promise<void> {
  if (!blob || blob.size === 0) {
    throw new Error("Assembled file is empty — nothing was captured.");
  }
  stage(jobId, "saving");
  try {
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
    report({ type: "DOWNLOAD_DONE", jobId, filename });
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

function partialsOf(err: unknown): Array<ArrayBuffer | undefined> | undefined {
  const p = (err as unknown as Record<string, unknown> | null)?.partials;
  return Array.isArray(p) ? (p as Array<ArrayBuffer | undefined>) : undefined;
}

/**
 * HLS fetch with one automatic playlist refresh. Signed segment URLs expire
 * mid-download (403/410); re-resolving the variant playlist usually yields
 * fresh URLs for the same indices. Completed parts are kept — only holes
 * are retried with the refreshed list.
 */
async function fetchHlsSegmentsWithRefresh(
  jobId: string,
  variantUrl: string,
  scope: NetScope | undefined,
  signal: AbortSignal,
  onProgress: ByteProgress,
): Promise<ArrayBuffer[]> {
  const isPaused = (): boolean => pausedJobs.has(jobId);
  const text = await textWithNet(variantUrl, scope, signal);
  if (/#EXT-X-KEY\s*:\s*[^\r\n]*METHOD\s*=\s*(?!NONE\b)/i.test(text)) {
    throw new Error("Protected content — cannot download (encrypted HLS).");
  }
  const urls = extractHlsSegments(text, variantUrl);
  if (!urls.length) throw new Error("No segments found in the HLS variant playlist.");
  try {
    return await fetchSegments(urls, onProgress, signal, scope, { isPaused });
  } catch (err) {
    if (signal.aborted || pausedJobs.has(jobId) || !isExpiredFailure(err)) throw err;
    // One refresh attempt: re-resolve the playlist for fresh signed URLs.
    let fresh: string[];
    try {
      const retryText = await textWithNet(variantUrl, scope, signal);
      fresh = extractHlsSegments(retryText, variantUrl);
    } catch {
      throw err; // refresh itself failed — surface the original expiry error
    }
    const partials = partialsOf(err);
    if (!fresh.length || !partials || partials.length !== urls.length) throw err;
    // Remap by index when the refreshed playlist matches (VOD case).
    // If the playlist slid (live) or resized, restart cleanly with fresh URLs.
    const sameLength = fresh.length === urls.length;
    return await fetchSegments(fresh, onProgress, signal, scope, {
      isPaused,
      existingParts: sameLength ? partials : undefined,
    });
  }
}

async function assembleHlsBlob(
  jobId: string,
  variantPlaylistUrl: string,
  onProgress?: ByteProgress,
  signal?: AbortSignal,
  scope?: NetScope | undefined,
): Promise<Blob> {
  if (signal?.aborted) throw new Error("Download cancelled.");
  const parts = await fetchHlsSegmentsWithRefresh(
    jobId,
    variantPlaylistUrl,
    scope,
    signal as AbortSignal,
    onProgress ?? (() => undefined),
  );
  if (signal?.aborted) throw new Error("Download cancelled.");
  return new Blob(orderAndValidateSegmentParts(parts), { type: "video/mp2t" });
}

async function assembleDashBlob(
  jobId: string,
  segmentUrls: string[],
  onProgress?: ByteProgress,
  signal?: AbortSignal,
  scope?: NetScope | undefined,
): Promise<Blob> {
  if (!segmentUrls.length) throw new Error("No segments listed for this DASH variant.");
  const isPaused = (): boolean => pausedJobs.has(jobId);
  const parts = await fetchSegments(segmentUrls, onProgress, signal, scope, { isPaused });
  if (signal?.aborted) throw new Error("Download cancelled.");
  return new Blob(orderAndValidateSegmentParts(parts), { type: "video/mp4" });
}

/**
 * Fetch both tracks (progress combined across the two lists) and merge
 * into one multi-track fMP4. Throws a clear error for non-fMP4 pairs.
 */
async function assembleMuxedBlob(
  job: DownloadJobRequest,
  pairUrls: string[],
  scope: NetScope | undefined,
  signal: AbortSignal,
  onProgress: (done: number, total: number, bytesDone?: number) => void,
): Promise<Blob> {
  let mainUrls: string[];
  if (job.kind === "hls") {
    const text = await textWithNet(job.url, scope, signal);
    mainUrls = extractHlsSegments(text, job.url);
    if (!mainUrls.length) throw new Error("No segments found in the HLS variant playlist.");
  } else {
    mainUrls = [...(job.segments ?? [])];
    if (!mainUrls.length) throw new Error("No segments listed for this variant.");
  }
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = msg as any;
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
      if (acc.received + m.buf.byteLength > MAX_ASSEMBLED_BYTES) {
        captures.delete(m.jobId);
        report({
          type: "DOWNLOAD_ERROR",
          jobId: m.jobId,
          error: "File exceeds the 1.5 GB safety cap — download stopped.",
        });
        try {
          sendResponse({ ok: true });
        } catch {
          /* ignore */
        }
        return false;
      }
      // which: 0 = primary track, 1 = paired audio track (muxed at END).
      if (m.which === 1) acc.pairParts.push(m.buf);
      else acc.parts.push(m.buf);
      acc.received += m.buf.byteLength;
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
    captures.delete(m.jobId);
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
        if (!acc.parts.length) throw new Error("Capture arrived empty.");
        stage(m.jobId, "assembling");
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
      // tracks, then merge into ONE file with audio.
      const pairUrls = await resolvePairSegments(job, scope, signal);
      let blob: Blob;
      let filename = job.filename;
      if (pairUrls) {
        blob = await assembleMuxedBlob(job, pairUrls, scope, signal, onProgress);
        filename = withExtension(job.filename, ".mp4");
      } else {
        blob =
          job.kind === "hls"
            ? await assembleHlsBlob(job.jobId, job.url, onProgress, signal, scope)
            : await assembleDashBlob(job.jobId, job.segments ?? [], onProgress, signal, scope);
        const ext = await sniffExtension(blob, job.kind === "hls" ? ".ts" : ".mp4");
        filename = withExtension(job.filename, ext);
      }

      stage(job.jobId, "assembling");
      await finalizeJobFile(job.jobId, blob, filename);
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
    }
  })();
  return false;
});
