/**
 * Download history. One flat, capped list in `chrome.storage.local` so the
 * options page can render it without the worker, and re-downloads can
 * re-resolve fresh signed URLs from the recorded source.
 *
 * Entries are small (no bytes, no headers), so the whole list fits
 * comfortably in local storage.
 */
import type { DownloadJobState, MediaType } from "./types";

export const HISTORY_KEY = "downStreamHistory";
export const HISTORY_LIMIT = 300;

export interface HistoryEntry {
  id: string;
  /** Original item URL (manifest, grouped-segment head, or direct file). */
  itemUrl: string;
  /** Page the video was found on — used to re-resolve the item on re-download. */
  pageUrl?: string;
  tabId?: number;
  title?: string;
  /** Relative destination path as saved (subfolder + filename). */
  filename: string;
  /** Variant/quality id and label, for re-download and display. */
  variantId?: string;
  quality?: string;
  type?: MediaType;
  bytes?: number;
  status: "done" | "error" | "cancelled";
  error?: string;
  /** chrome.downloads id, when the browser tracked the file (Show in folder). */
  downloadId?: number;
  at: number;
}

/** Read the whole history (newest first). Never throws. */
export async function loadHistory(): Promise<HistoryEntry[]> {
  try {
    const got = await chrome.storage.local.get(HISTORY_KEY);
    const raw = (got as Record<string, unknown>)[HISTORY_KEY];
    if (!Array.isArray(raw)) return [];
    return raw.filter(isEntry).sort((a, b) => b.at - a.at);
  } catch {
    return [];
  }
}

export async function saveHistory(entries: HistoryEntry[]): Promise<void> {
  try {
    await chrome.storage.local.set({ [HISTORY_KEY]: entries.slice(0, HISTORY_LIMIT) });
  } catch {
    /* best-effort */
  }
}

/** Prepend an entry, de-duplicating on id and enforcing the cap. */
export async function appendHistory(entry: HistoryEntry): Promise<void> {
  const list = await loadHistory();
  const next = [entry, ...list.filter((e) => e.id !== entry.id)].slice(0, HISTORY_LIMIT);
  await saveHistory(next);
}

export async function clearHistory(): Promise<void> {
  try {
    await chrome.storage.local.remove(HISTORY_KEY);
  } catch {
    /* ignore */
  }
}

export async function getHistoryEntry(id: string): Promise<HistoryEntry | undefined> {
  return (await loadHistory()).find((e) => e.id === id);
}

/** Build a history row from a settled job. */
export function entryFromJob(
  job: DownloadJobState,
  status: "done" | "error" | "cancelled",
  at = Date.now(),
): HistoryEntry {
  return {
    id: job.jobId,
    itemUrl: job.itemUrl,
    pageUrl: job.pageUrl,
    tabId: job.tabId,
    title: job.title,
    filename: job.filename,
    variantId: job.variantId,
    quality: job.quality,
    type: job.mediaType,
    bytes: job.bytesDone,
    status,
    error: status === "done" ? undefined : job.error,
    downloadId: job.downloadId,
    at,
  };
}

function isEntry(v: unknown): v is HistoryEntry {
  const e = v as HistoryEntry;
  return (
    !!e &&
    typeof e.id === "string" &&
    typeof e.itemUrl === "string" &&
    typeof e.filename === "string" &&
    typeof e.at === "number" &&
    (e.status === "done" || e.status === "error" || e.status === "cancelled")
  );
}
