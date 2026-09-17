import {
  downloadDirect,
  downloadHlsVariant,
  downloadDashVariant,
} from "./lib/download";
import type { DownloadJobRequest } from "./lib/types";

function report(msg: object): void {
  try {
    void chrome.runtime.sendMessage(msg);
  } catch {
    /* background may be momentarily unreachable — job state reconciles on GET_JOBS */
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = msg as any;
  if (m?.type !== "OFFSCREEN_DOWNLOAD" || !m.job) return false;
  const job = m.job as DownloadJobRequest;
  // Acknowledge synchronously so the worker knows we got it.
  try {
    sendResponse({ received: true });
  } catch {
    /* ignore */
  }

  void (async () => {
    const onProgress = (done: number, total: number) =>
      report({ type: "DOWNLOAD_PROGRESS", jobId: job.jobId, done, total });
    try {
      if (job.kind === "direct") {
        onProgress(0, 1);
        await downloadDirect(job.url, job.filename);
        onProgress(1, 1);
      } else if (job.kind === "hls") {
        await downloadHlsVariant(job.url, job.filename, onProgress);
      } else {
        await downloadDashVariant(job.segments ?? [], job.filename, onProgress);
      }
      report({ type: "DOWNLOAD_DONE", jobId: job.jobId });
    } catch (err) {
      report({
        type: "DOWNLOAD_ERROR",
        jobId: job.jobId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();
  return false;
});
