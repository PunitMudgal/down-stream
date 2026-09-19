/**
 * Batch download queue (worker-owned).
 *
 * The popup can hand over several videos at once ("Download selected"); this
 * runs them a bounded number at a time so a page with ten videos doesn't open
 * ten parallel 8-way segment fetchers. The queue is event-driven: it starts
 * work while capacity is free and advances when the worker learns a job
 * settled (DOWNLOAD_DONE / DOWNLOAD_ERROR / cancel).
 *
 * The queue lives in worker memory. A restart drops the wait list, but any
 * job already dispatched keeps running and is recovered as usual.
 */
import { getSettings } from "../lib/settings";
import type { BatchSnapshot, BatchTaskState } from "../lib/types";
import { startDownload } from "./jobs";
import { ensureJobsLoaded, jobMemory } from "./store";

interface Task {
  tabId: number;
  itemUrl: string;
  variantId?: string;
  title?: string;
  filename?: string;
  status: "queued" | "running" | "done" | "failed";
  error?: string;
  jobIds: Set<string>;
  pending: number;
}

class BatchQueue {
  private tasks: Task[] = [];
  private byJob = new Map<string, Task>();

  /** Replace the queue with a new batch (settled tasks from before are cleared). */
  async add(tabId: number, items: Array<{ itemUrl: string; variantId?: string; title?: string }>): Promise<void> {
    await ensureJobsLoaded();
    await this.refreshConcurrency();
    this.tasks = this.tasks.filter((t) => t.status === "queued" || t.status === "running");
    for (const it of items) {
      if (this.tasks.some((t) => t.itemUrl === it.itemUrl && t.status !== "failed")) continue;
      this.tasks.push({
        tabId,
        itemUrl: it.itemUrl,
        variantId: it.variantId,
        title: it.title,
        status: "queued",
        jobIds: new Set(),
        pending: 0,
      });
    }
    this.pump();
  }

  /** Called by the router whenever a download job reaches a terminal state. */
  onJobSettled(jobId: string): void {
    const task = this.byJob.get(jobId);
    if (!task) return;
    this.byJob.delete(jobId);
    task.pending = Math.max(0, task.pending - 1);
    if (task.pending === 0) this.settle(task);
    this.pump();
  }

  snapshot(): BatchSnapshot {
    const concurrency = this.concurrency;
    const counts = { queued: 0, running: 0, done: 0, failed: 0 };
    const tasks: BatchTaskState[] = this.tasks.map((t) => {
      counts[t.status]++;
      return { itemUrl: t.itemUrl, title: t.title, filename: t.filename, status: t.status, error: t.error };
    });
    return {
      total: this.tasks.length,
      ...counts,
      concurrency,
      active: counts.queued > 0 || counts.running > 0,
      tasks,
    };
  }

  /** Drop settled tasks (popup dismisses the batch bar). */
  reset(): void {
    this.tasks = [];
    this.byJob.clear();
  }

  /** Cached concurrency (refreshed from settings on every batch start). */
  private concurrency = 2;

  private async refreshConcurrency(): Promise<void> {
    try {
      this.concurrency = (await getSettings()).batchConcurrency;
    } catch {
      this.concurrency = 2;
    }
  }

  /** Start queued tasks while the global running-job count is under the cap. */
  private pump(): void {
    let free = this.concurrency - this.busySlots();
    if (free <= 0) return;
    for (const t of this.tasks) {
      if (free <= 0) break;
      if (t.status !== "queued") continue;
      t.status = "running";
      free--;
      void this.start(t);
    }
  }

  /**
   * Occupied slots. Counts running/paused jobs AND tasks already claimed but
   * still awaiting dispatch — otherwise a re-entrant pump between claiming a
   * task and its job row existing would over-subscribe the cap.
   */
  private busySlots(): number {
    let running = 0;
    for (const j of jobMemory.values()) {
      if (j.status === "running" || j.status === "paused") running++;
    }
    let claimed = 0;
    for (const t of this.tasks) {
      if (t.status === "running") claimed++;
    }
    return Math.max(running, claimed);
  }

  private async start(t: Task): Promise<void> {
    try {
      const res = await startDownload(t.tabId, t.itemUrl, t.variantId);
      t.filename = res.job.filename;
      t.jobIds = new Set(res.jobIds);
      t.pending = t.jobIds.size;
      for (const id of t.jobIds) this.byJob.set(id, t);
      if (t.pending === 0 || this.allSettled(t)) this.settle(t);
    } catch (err) {
      t.status = "failed";
      t.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.pump();
    }
  }

  private allSettled(t: Task): boolean {
    for (const id of t.jobIds) {
      const j = jobMemory.get(id);
      if (!j || j.status === "running" || j.status === "paused") return false;
    }
    return true;
  }

  private settle(t: Task): void {
    const jobs = [...t.jobIds].map((id) => jobMemory.get(id));
    const failed = jobs.find((j) => j && j.status !== "done");
    t.status = failed ? "failed" : "done";
    if (failed) t.error = failed.error ?? "Download failed.";
  }
}

export const batchQueue = new BatchQueue();
