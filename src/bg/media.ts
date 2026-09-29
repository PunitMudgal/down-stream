// Media-item helpers: exclusions, badges, titles, caps, upserts.
// Moved verbatim from background.ts — zero behavior change.
import { cleanTitle, sanitizeStem } from "../lib/download";
import { forDisplay } from "../lib/target";
import type { MediaItem, VideoSignal } from "../lib/types";
import { getTabItems, persistTab } from "./store";

export const MAX_ITEMS_PER_TAB = 60;
export const MAX_BLOB_PER_TAB = 25;

export const DIRECT_TYPES = new Set([
  "mp4", "webm", "ogg", "mov", "mkv", "avi", "flv", "wmv", "mpg",
]);

/**
 * Hosts the extension never touches (page + network). YouTube is out of
 * scope by design: ciphered/DRM-protected delivery can't be downloaded, and
 * its traffic volume only adds noise. googlevideo.com carries that traffic
 * even for embeds, so it is excluded too.
 */
export function isExcludedUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return (
      /(^|\.)youtube\.com$/.test(h) ||
      /(^|\.)youtu\.be$/.test(h) ||
      /(^|\.)youtube-nocookie\.com$/.test(h) ||
      /(^|\.)googlevideo\.com$/.test(h)
    );
  } catch {
    return false;
  }
}

export function codecsOf(v?: { codecs?: string }): string {
  return (v?.codecs ?? "").toLowerCase();
}
export function hasVideoCodec(c: string): boolean {
  return /(avc|hev|hvc|vp0?9|av0?1)/.test(c);
}
export function hasAudioCodec(c: string): boolean {
  return /(mp4a|opus|ec-3|ac-3|ac-4)/.test(c);
}

/**
 * Mirror of the popup display filter — the badge shows the same real-video
 * count the popup does (manifests dominate; fragments/placeholders hidden).
 * Blob player rows count too: every one carries a Download button that reads
 * the buffer (or falls back to the full stream), so hiding them makes video
 * pages look empty.
 */
export function countForBadge(items: MediaItem[]): number {
  return forDisplay(items).filter((x) => !x.drmProtected).length;
}

/** Badge counts real videos, not blob placeholders or raw fragments. */
export async function updateBadge(tabId: number): Promise<void> {
  try {
    const items = await getTabItems(tabId);
    const count = countForBadge(items);
    await chrome.action.setBadgeText({
      text: count > 0 ? String(count) : "",
      tabId,
    });
    await chrome.action.setBadgeBackgroundColor({ color: "#8f3a16", tabId });
  } catch {
    /* badge is best-effort */
  }
}

export async function updateBadgeForActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null) await updateBadge(tab.id);
  } catch {
    /* ignore */
  }
}

/**
 * Attach a title to an item. Element-level titles (found next to the player)
 * always beat page-level ones; the filename regenerates once, the first
 * time a real title lands on a fallback-named item (extension preserved).
 */
export function applyTitle(item: MediaItem, rawTitle: string | undefined, isElement: boolean): boolean {
  const title = cleanTitle(rawTitle ?? "");
  if (!title) return false;
  if (item.title) {
    if (!isElement || item.titleFromPage === false) return false;
  }
  item.title = title;
  item.titleFromPage = !isElement;
  if (item.autoNamed !== false && item.filename) {
    const m = /\.([a-z0-9]{2,5})$/i.exec(item.filename);
    const ext = m ? m[1].toLowerCase() : "mp4";
    const stem = sanitizeStem(title);
    if (stem) {
      item.filename = `${stem}.${ext}`;
      item.autoNamed = false;
    }
  }
  return true;
}

/** "1280×720 • 0:34 • playing" from a content-script signal. */
export function describeSignal(v: VideoSignal): string | undefined {
  const parts: string[] = [];
  if (v.width && v.height) parts.push(`${v.width}×${v.height}`);
  if (v.duration != null && Number.isFinite(v.duration) && v.duration > 0) {
    const s = Math.floor(v.duration);
    parts.push(
      s >= 3600
        ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
        : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`,
    );
  }
  if (v.paused === false) parts.push("playing");
  return parts.length ? parts.join(" • ") : undefined;
}

export function headerValue(
  headers: chrome.webRequest.HttpHeader[] | undefined,
  name: string,
): string {
  if (!headers) return "";
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h?.value ?? "";
}

/** Bound per-tab growth (infinite feeds) — drop oldest blob placeholders first. */
export function enforceCaps(items: MediaItem[]): MediaItem[] {
  let out = items;
  const blobs = out.filter((x) => x.type === "blob");
  if (blobs.length > MAX_BLOB_PER_TAB) {
    const drop = new Set(blobs.slice(0, blobs.length - MAX_BLOB_PER_TAB).map((x) => x.url));
    out = out.filter((x) => !drop.has(x.url));
  }
  if (out.length > MAX_ITEMS_PER_TAB) {
    out = out.slice(out.length - MAX_ITEMS_PER_TAB);
  }
  return out;
}

export async function upsertItem(tabId: number, item: MediaItem): Promise<void> {
  const items = await getTabItems(tabId);
  // Deduplicate by full URL — keep signed query params intact.
  if (items.some((x) => x.url === item.url)) return;
  items.push(item);
  await persistTab(tabId, enforceCaps(items));
  await updateBadge(tabId);
}

export async function patchItem(
  tabId: number,
  url: string,
  patch: Partial<MediaItem>,
): Promise<void> {
  const items = await getTabItems(tabId);
  const idx = items.findIndex((x) => x.url === url);
  if (idx === -1) return;
  items[idx] = { ...items[idx], ...patch };
  await persistTab(tabId, items);
  await updateBadge(tabId);
}

export function mbLabel(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}
