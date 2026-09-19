/**
 * Resolve "which detected item should this right-click / keyboard shortcut
 * download?" — pure decision logic, kept out of the content script and worker
 * so it is identical in both and trivially testable.
 *
 * The popup has a card to click, so the user picks the exact item. The context
 * menu and shortcut have only a <video> element, whose `currentSrc` is often a
 * page-scoped `blob:` URL that is meaningless to the downloader (MSE players)
 * or a URL the worker never saw. So we match the element's candidate URLs
 * against the tab's detected items, and only fall back to "the best item on
 * this page" when the element is demonstrably a MediaSource player.
 */

export interface TargetItem {
  url: string;
  type: string;
  detectedAt: number;
  drmProtected?: boolean;
}

/**
 * Query and hash are irrelevant for identity; host case is too. Only http(s)
 * URLs are rebuilt — other schemes (`blob:`, `capture:`, `data:`) have no
 * meaningful authority component and rebuilding them would corrupt the string
 * (e.g. `blob:https://x/y` -> `blob://https://x/y`), so they pass through
 * untouched and are compared literally.
 */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return raw;
    u.hash = "";
    u.search = "";
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname}`;
  } catch {
    return raw;
  }
}

/**
 * The item matching the video element's candidates. Candidates are ordered
 * best-first by the page (currentSrc, then src, then <source>/data-* forms),
 * so the first one that resolves wins — exact string match first, then
 * query-stripped equality (signed URLs differ per detection).
 * A DRM match is returned deliberately: the downloader then reports the real
 * "protected content" reason instead of the button doing nothing.
 */
export function pickCandidateItem<T extends TargetItem>(
  items: T[],
  candidates: string[],
): T | undefined {
  const clean = candidates.filter((c) => typeof c === "string" && c.length > 0);
  for (const cand of clean) {
    const exact = items.find((i) => i.url === cand);
    if (exact) return exact;
  }
  const normalized = new Map<string, T>();
  for (const item of items) {
    const key = normalizeUrl(item.url);
    if (!normalized.has(key)) normalized.set(key, item);
  }
  for (const cand of clean) {
    const hit = normalized.get(normalizeUrl(cand));
    if (hit) return hit;
  }
  return undefined;
}

/**
 * True when the element plays through MediaSource (only a `blob:` URL is
 * exposed) — the one case where we can't name the video's file and the tab's
 * item list is the only source of truth.
 */
export function looksLikeBlobPlayer(candidates: string[]): boolean {
  return candidates.some((c) => typeof c === "string" && c.startsWith("blob:"));
}

/** Downloadability rank — lower is a better target. */
const TYPE_RANK: Record<string, number> = {
  mp4: 0,
  webm: 0,
  ogg: 0,
  mov: 0,
  mkv: 0,
  avi: 0,
  flv: 0,
  wmv: 0,
  mpg: 0,
  hls: 1,
  dash: 1,
  segments: 2,
  capture: 3,
  blobfile: 4,
};

/**
 * Best downloadable item on the page when the element can't be named: prefer
 * unprotected over protected, real files/manifests over captured buffers, then
 * the most recently detected. Returns undefined when nothing is downloadable
 * (so the caller reports "nothing found" rather than starting a doomed job).
 */
type DisplayItem = {
  type: string;
  variants?: unknown[];
  drmProtected?: boolean;
};

/**
 * Popup / badge display filter. Blob placeholders are an explanation, not a
 * file: hide them as soon as anything downloadable exists. Parsed HLS/DASH
 * rows also replace raw chunk groups.
 */
export function forDisplay<T extends DisplayItem>(items: T[]): T[] {
  const hasParsedManifest = items.some(
    (x) =>
      (x.type === "hls" || x.type === "dash") &&
      (x.variants?.length ?? 0) > 0 &&
      !x.drmProtected,
  );
  const hasDownloadable = items.some((x) => x.type !== "blob" && !x.drmProtected);
  return items.filter((x) => {
    if (x.type === "blob" && hasDownloadable) return false;
    if (hasParsedManifest && x.type === "segments") return false;
    return true;
  });
}

export function pickBestTabItem<T extends TargetItem>(items: T[]): T | undefined {
  const rank = (t: T): number => TYPE_RANK[t.type] ?? Number.MAX_SAFE_INTEGER;
  const usable = items.filter((i) => TYPE_RANK[i.type] !== undefined);
  if (usable.length === 0) return undefined;
  return [...usable].sort((a, b) => {
    const d = Number(!!a.drmProtected) - Number(!!b.drmProtected);
    if (d !== 0) return d;
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return b.detectedAt - a.detectedAt;
  })[0];
}