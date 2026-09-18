// Background storage layer: in-memory caches (fast path) +
// chrome.storage.session mirrors (survive SW suspend).
// Moved verbatim from background.ts — zero behavior change.
import type { DownloadJobState, MediaItem } from "../lib/types";

export const SESSION_KEY = "mediaByTab";
export const JOBS_KEY = "downloadJobs";

/** Fast-path media cache: tabId -> items. Exported for GET_MEDIA fast path. */
export const memoryStore = new Map<number, MediaItem[]>();
/** All known download jobs, keyed by jobId. */
export const jobMemory = new Map<string, DownloadJobState>();
/** Last committed URL per tab (SPA + navigation staleness checks). */
export const lastUrlByTab = new Map<number, string>();

export async function readSessionKey<T>(key: string, fallback: T, ms = 2500): Promise<T> {
  // Never let a slow/unavailable storage backend hang a popup response:
  // race the read against a timeout and fall back to memory/empty.
  try {
    const got = await Promise.race([
      chrome.storage.session.get(key),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("storage read timeout")), ms),
      ),
    ]);
    const val = (got as Record<string, unknown>)[key];
    if (val && typeof val === "object") return val as T;
  } catch {
    /* storage.session unavailable or slow — fall back to memory only */
  }
  return fallback;
}

export async function persistTab(tabId: number, items: MediaItem[]): Promise<void> {
  memoryStore.set(tabId, items);
  try {
    const all = await readSessionKey<Record<string, MediaItem[]>>(SESSION_KEY, {});
    all[String(tabId)] = items;
    await chrome.storage.session.set({ [SESSION_KEY]: all });
  } catch {
    /* ignore persistence failures */
  }
}

export async function getTabItems(tabId: number): Promise<MediaItem[]> {
  const mem = memoryStore.get(tabId);
  if (mem) return mem;
  const all = await readSessionKey<Record<string, MediaItem[]>>(SESSION_KEY, {});
  const items = all[String(tabId)] ?? [];
  memoryStore.set(tabId, items);
  return items;
}

/** Synchronous fast-path read (no session fallback). Returns undefined on miss. */
export function getMemoryItems(tabId: number): MediaItem[] | undefined {
  return memoryStore.get(tabId);
}

export async function persistJobs(): Promise<void> {
  try {
    // Prune: keep the 30 most recent jobs so session storage stays small.
    const sorted = [...jobMemory.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    jobMemory.clear();
    for (const j of sorted.slice(0, 30)) jobMemory.set(j.jobId, j);
    const all: Record<string, DownloadJobState> = {};
    for (const [id, job] of jobMemory) all[id] = job;
    await chrome.storage.session.set({ [JOBS_KEY]: all });
  } catch {
    /* ignore */
  }
}

export async function ensureJobsLoaded(): Promise<void> {
  if (jobMemory.size > 0) return;
  const all = await readSessionKey<Record<string, DownloadJobState>>(JOBS_KEY, {});
  for (const [id, job] of Object.entries(all)) jobMemory.set(id, job);
}

export async function getTabJobs(tabId: number): Promise<DownloadJobState[]> {
  await ensureJobsLoaded();
  return [...jobMemory.values()]
    .filter((j) => j.tabId === tabId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getJob(jobId: string): DownloadJobState | undefined {
  return jobMemory.get(jobId);
}

const lastJobPersist = new Map<string, number>();

export async function upsertJob(job: DownloadJobState, persist = true): Promise<void> {
  job.updatedAt = Date.now();
  jobMemory.set(job.jobId, job);
  // Progress ticks arrive per segment — throttle session writes (quota),
  // but always broadcast so an open popup stays live.
  if (persist) {
    await persistJobs();
    lastJobPersist.set(job.jobId, Date.now());
  } else {
    const last = lastJobPersist.get(job.jobId) ?? 0;
    if (Date.now() - last > 2000) {
      await persistJobs();
      lastJobPersist.set(job.jobId, Date.now());
    }
  }
  // Broadcast so an open popup updates live (content scripts ignore it).
  try {
    await chrome.runtime.sendMessage({ type: "JOB_UPDATED", job });
  } catch {
    /* popup closed — state reconciles via GET_JOBS on reopen */
  }
}

/** Forget one tab's media + last-URL (session mirror pruned too). */
export async function forgetTabMedia(tabId: number): Promise<void> {
  memoryStore.delete(tabId);
  lastUrlByTab.delete(tabId);
  try {
    const all = await readSessionKey<Record<string, MediaItem[]>>(SESSION_KEY, {});
    delete all[String(tabId)];
    await chrome.storage.session.set({ [SESSION_KEY]: all });
  } catch {
    /* ignore */
  }
}
