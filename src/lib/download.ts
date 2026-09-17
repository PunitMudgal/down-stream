import { extractHlsSegments } from "./parseHls";

export type ProgressCallback = (done: number, total: number) => void;

export function sanitizeFilename(name: string, fallback: string): string {
  const cleaned = name
    .split("?")[0]
    .split("#")[0]
    .split("/")
    .pop()
    ?.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, 180);
}

export function filenameForUrl(url: string, type: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  if (type === "hls") return `hls-video-${ts}.ts`;
  if (type === "dash") return `dash-video-${ts}.mp4`;
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").pop() || "";
    if (/\.(mp4|webm|ogv|ogg|mov|m4v)$/i.test(last)) {
      return sanitizeFilename(last, `video-${ts}.mp4`);
    }
  } catch {
    /* fall through */
  }
  const ext = type === "webm" ? "webm" : type === "mov" ? "mov" : "mp4";
  return `video-${ts}.${ext}`;
}

/** Direct file: browser handles it natively. */
export async function downloadDirect(
  url: string,
  filename: string,
): Promise<void> {
  await chrome.downloads.download({ url, filename, saveAs: false });
}

async function fetchBuffer(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Segment fetch failed (${res.status}): ${url}`);
  return res.arrayBuffer();
}

/**
 * HLS download: fetch every segment of the chosen variant in order,
 * concatenate into a single Blob (video/mp2t). No remuxing — the .ts
 * plays in VLC and most players. Must run in a document context with
 * DOM APIs (popup or offscreen document) — NOT in the service worker,
 * which can't reliably hold blob: URLs.
 */
export async function downloadHlsVariant(
  variantPlaylistUrl: string,
  filename: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  const playlistRes = await fetch(variantPlaylistUrl, {
    credentials: "include",
  });
  if (!playlistRes.ok)
    throw new Error(
      `Variant playlist fetch failed (${playlistRes.status})`,
    );
  const text = await playlistRes.text();

  // Refuse encrypted streams — never attempt to fetch/decrypt them.
  if (/#EXT-X-KEY\s*:\s*[^\r\n]*METHOD\s*=\s*(?!NONE\b)/i.test(text)) {
    throw new Error("Protected content — cannot download (encrypted HLS).");
  }

  const segmentUrls = extractHlsSegments(text, variantPlaylistUrl);
  if (segmentUrls.length === 0)
    throw new Error("No segments found in the HLS variant playlist.");

  const parts: ArrayBuffer[] = [];
  for (let i = 0; i < segmentUrls.length; i++) {
    parts.push(await fetchBuffer(segmentUrls[i]));
    onProgress?.(i + 1, segmentUrls.length);
  }
  const blob = new Blob(parts, { type: "video/mp2t" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url: blobUrl, filename, saveAs: false });
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}

/** DASH download: same concat approach over the parsed variant's segments. */
export async function downloadDashVariant(
  segmentUrls: string[],
  filename: string,
  onProgress?: ProgressCallback,
): Promise<void> {
  if (segmentUrls.length === 0)
    throw new Error("No segments listed for this DASH variant.");
  const parts: ArrayBuffer[] = [];
  for (let i = 0; i < segmentUrls.length; i++) {
    parts.push(await fetchBuffer(segmentUrls[i]));
    onProgress?.(i + 1, segmentUrls.length);
  }
  // DASH segments are typically fragmented MP4; concat preserves playability
  // for many players without a full remux (stretch goal, not v1).
  const blob = new Blob(parts, { type: "video/mp4" });
  const blobUrl = URL.createObjectURL(blob);
  try {
    await chrome.downloads.download({ url: blobUrl, filename, saveAs: false });
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }
}
