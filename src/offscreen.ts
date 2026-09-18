import {
  assembleHlsBlob,
  assembleDashBlob,
  blobToDataUrl,
  fetchSegments,
} from "./lib/download";
import { extractHlsSegments } from "./lib/parseHls";
import { muxFmp4 } from "./lib/mp4mux";
import type { DownloadJobRequest, DownloadJobStage } from "./lib/types";

const controllers = new Map<string, AbortController>();

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

/**
 * Fetch both tracks (progress combined across the two lists) and merge
 * into one multi-track fMP4. Throws a clear error for non-fMP4 pairs.
 */
async function assembleMuxedBlob(
  job: DownloadJobRequest,
  pairUrls: string[],
  scope: NetScope | undefined,
  signal: AbortSignal,
  onProgress: (done: number, total: number) => void,
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
  const prog = (d: number, t: number) => {
    void t;
    done++;
    onProgress(done, total);
  };
  // Video first, then audio — order irrelevant, progress combined.
  const [vParts, aParts] = await Promise.all([
    fetchSegments(mainUrls, prog, signal, scope),
    fetchSegments(pairUrls, prog, signal, scope),
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
    cancelledCaptures.add(m.jobId);
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
        let dataUrl: string;
        try {
          dataUrl = await blobToDataUrl(blob);
        } catch (err) {
          throw new Error(
            `Could not encode ${(blob.size / 1_000_000).toFixed(1)} MB capture for transfer: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        stage(m.jobId, "saving");
        try {
          await chrome.runtime.sendMessage({ type: "DOWNLOAD_BLOB", jobId: m.jobId, dataUrl, filename });
        } catch (err) {
          throw new Error(
            `Assembled ${(blob.size / 1_000_000).toFixed(1)} MB but the transfer to the background worker failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
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
      if (job.kind === "direct") {
        throw new Error("Direct downloads are handled by the service worker.");
      }
      const onProgress = (done: number, total: number) =>
        report({ type: "DOWNLOAD_PROGRESS", jobId: job.jobId, done, total });
      stage(job.jobId, "fetching");
      const scope = job.netScope;

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
            ? await assembleHlsBlob(job.url, onProgress, signal, scope)
            : await assembleDashBlob(job.segments ?? [], onProgress, signal, scope);
        const ext = await sniffExtension(blob, job.kind === "hls" ? ".ts" : ".mp4");
        filename = withExtension(job.filename, ext);
      }

      stage(job.jobId, "assembling");
      let dataUrl: string;
      try {
        dataUrl = await blobToDataUrl(blob);
      } catch (err) {
        throw new Error(
          `Could not encode ${(blob.size / 1_000_000).toFixed(1)} MB file for transfer: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      stage(job.jobId, "saving");
      // Awaited delivery: if the payload is too large for messaging this
      // throws here and becomes a clear DOWNLOAD_ERROR below — never silent.
      try {
        await chrome.runtime.sendMessage({
          type: "DOWNLOAD_BLOB",
          jobId: job.jobId,
          dataUrl,
          filename,
        });
      } catch (err) {
        throw new Error(
          `Assembled ${(blob.size / 1_000_000).toFixed(1)} MB but the transfer to the background worker failed (message too large?): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    } catch (err) {
      report({
        type: "DOWNLOAD_ERROR",
        jobId: job.jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      controllers.delete(job.jobId);
    }
  })();
  return false;
});
