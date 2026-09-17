import {
  assembleHlsBlob,
  assembleDashBlob,
  blobToDataUrl,
} from "./lib/download";
import type { DownloadJobRequest, DownloadJobStage } from "./lib/types";

const controllers = new Map<string, AbortController>();

interface CaptureAcc {
  parts: ArrayBuffer[];
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
      acc.parts.push(m.buf);
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
        const blob = new Blob(acc.parts, { type: acc.mime || "video/mp4" });
        acc.parts = [];
        const ext = await sniffExtension(blob, ".mp4");
        const filename = withExtension(acc.filename, ext);
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
      const blob =
        job.kind === "hls"
          ? await assembleHlsBlob(job.url, onProgress, signal, scope)
          : await assembleDashBlob(job.segments ?? [], onProgress, signal, scope);

      stage(job.jobId, "assembling");
      const ext = await sniffExtension(blob, job.kind === "hls" ? ".ts" : ".mp4");
      const filename = withExtension(job.filename, ext);
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
