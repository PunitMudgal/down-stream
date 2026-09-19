/**
 * Pending blob saves.
 *
 * The offscreen document assembles the bytes and publishes a `blob:` URL; the
 * worker (the only context with `chrome.downloads`) starts the actual download.
 * Chrome streams that blob lazily, so the URL — and therefore the offscreen
 * document — must stay alive until the download finishes. This registry is how
 * the worker knows a save is still in flight, and where it revokes the URL once
 * `chrome.downloads.onChanged` reports a terminal state.
 */
interface PendingSave {
  blobUrl: string;
  at: number;
}

const pending = new Map<number, PendingSave>();

/** A save abandoned without a completion event (rare) can't pin the doc forever. */
const SAFETY_TTL_MS = 6 * 3_600_000;

export function rememberSave(downloadId: number, blobUrl: string): void {
  pending.set(downloadId, { blobUrl, at: Date.now() });
}

/** True while any blob download is still transferring. */
export function hasPendingSave(): boolean {
  pruneStaleSaves();
  return pending.size > 0;
}

/** Forget (and release) one save. */
export function releaseSave(downloadId: number): void {
  const entry = pending.get(downloadId);
  if (!entry) return;
  pending.delete(downloadId);
  void releaseBlobUrl(entry.blobUrl);
}

/** React to a chrome.downloads state change; release the blob when finished. */
export function onDownloadChanged(delta: chrome.downloads.DownloadDelta): void {
  const state = delta.state?.current;
  if (state !== "complete" && state !== "interrupted") return;
  releaseSave(delta.id);
}

/** Ask the offscreen document to revoke a blob URL it created. */
async function releaseBlobUrl(blobUrl: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "RELEASE_BLOB_URL", blobUrl });
  } catch {
    /* offscreen already gone — its blob URLs died with it */
  }
}

function pruneStaleSaves(): void {
  const cutoff = Date.now() - SAFETY_TTL_MS;
  for (const [id, entry] of pending) {
    if (entry.at < cutoff) releaseSave(id);
  }
}
