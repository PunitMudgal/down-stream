import { extractHlsSegments } from "./parseHls";
import type { NetReplay } from "./types";

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

/** Known site suffixes stripped from page/video titles for file naming. */
const SITE_SUFFIX_RE =
  /\s*[-–—|/]\s*(YouTube|X\s*\(Twitter\)|Twitter|Facebook|Instagram|TikTok|Vimeo|Dailymotion|Twitch|Rumble|Reddit|X)$/i;

/** Trim + collapse whitespace, strip " - YouTube"-style suffixes. "" if unusable. */
export function cleanTitle(raw: string | null | undefined, max = 100): string {
  if (!raw) return "";
  let s = raw.replace(/\s+/g, " ").trim();
  s = s.replace(SITE_SUFFIX_RE, "").trim();
  if (s.length < 3) return "";
  return s.slice(0, max).trim();
}

/** Filesystem-safe stem (slashes become underscores — titles contain them). */
export function sanitizeStem(raw: string, max = 100): string {
  const s = raw
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  if (!s) return "";
  return s.slice(0, max).trim().replace(/[. ]+$/, "") || "";
}

function defaultExtForType(type: string): string {
  const t = type.toLowerCase();
  if (t === "hls") return "ts";
  if (t === "webm") return "webm";
  if (t === "ogg") return "ogg";
  if (t === "mov") return "mov";
  if (t === "mkv") return "mkv";
  if (t === "avi") return "avi";
  if (t === "flv") return "flv";
  if (t === "wmv") return "wmv";
  if (t === "mpg") return "mpg";
  return "mp4";
}

function videoExtFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").pop() || "";
    const m = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi|flv|f4v|wmv|mpg|mpeg|3gp|3g2)$/i.exec(last);
    if (!m) return "";
    const ext = m[1].toLowerCase();
    if (ext === "m4v" || ext === "3gp" || ext === "3g2" || ext === "mpeg" || ext === "ogv" || ext === "f4v") return "mp4";
    return ext;
  } catch {
    return "";
  }
}

export function filenameForUrl(url: string, type: string, title?: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const stem = title ? sanitizeStem(cleanTitle(title)) : "";
  const ext = videoExtFromUrl(url) || defaultExtForType(type);
  // A real title always wins (extension preserved from URL or type default).
  if (stem) return `${stem}.${ext}`;
  if (type === "hls") return `hls-video-${ts}.ts`;
  if (type === "dash") return `dash-video-${ts}.mp4`;
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").pop() || "";
    if (/\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi|flv|f4v|wmv|mpg|mpeg|3gp|3g2)$/i.test(last)) {
      return sanitizeFilename(last, `video-${ts}.mp4`);
    }
  } catch {
    /* fall through */
  }
  if (type === "segments") return `video-segments-${ts}.mp4`;
  return `video-${ts}.${ext}`;
}

/** Direct file: browser handles it natively. */
export async function downloadDirect(
  url: string,
  filename: string,
): Promise<void> {
  await chrome.downloads.download({ url, filename, saveAs: false });
}

export const MAX_SEGMENTS = 2000;
export const MAX_BYTES = 1_500_000_000; // 1.5 GB safety cap
const FETCH_CONCURRENCY = 5;
const FETCH_RETRIES = 3;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Download cancelled.");
}

function netInit(net: NetReplay | undefined, signal?: AbortSignal): RequestInit {
  return {
    credentials: "include",
    signal,
    headers: net?.headers,
    referrer: net?.referrer,
    referrerPolicy: net?.referrer ? "unsafe-url" : undefined,
  };
}

/** Pick the replay context for a URL's origin (headers never cross origins). */
export function pickNet(
  scope: { byOrigin: Record<string, NetReplay> } | undefined,
  url: string,
): NetReplay | undefined {
  if (!scope) return undefined;
  try {
    return scope.byOrigin[new URL(url).origin];
  } catch {
    return undefined;
  }
}

async function fetchBuffer(
  url: string,
  signal?: AbortSignal,
  scope?: { byOrigin: Record<string, NetReplay> },
): Promise<ArrayBuffer> {
  throwIfAborted(signal);
  const net = pickNet(scope, url);
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      // NOTE: headers in `net` were already scoped to this origin by the
      // background lookup — never attach foreign auth here.
      const res = await fetch(url, netInit(net, signal));
      if (!res.ok) throw new Error(`Segment fetch failed (${res.status}): ${url}`);
      return await res.arrayBuffer();
    } catch (err) {
      if (signal?.aborted) throw new Error("Download cancelled.");
      lastErr = err;
      if (attempt < FETCH_RETRIES) {
        await new Promise((r) => setTimeout(r, 400 * attempt));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Segment fetch failed: ${url}`);
}

/** Bounded parallel fetch that preserves segment order for concat. */
async function fetchAllOrdered(
  urls: string[],
  mime: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  scope?: { byOrigin: Record<string, NetReplay> },
): Promise<Blob> {
  const parts = await fetchSegments(urls, onProgress, signal, scope);
  throwIfAborted(signal);
  return new Blob(parts, { type: mime });
}

/**
 * Fetch segment URLs with bounded parallelism, retries, and safety caps.
 * Returns ordered ArrayBuffers (caller decides concat vs mux).
 */
export async function fetchSegments(
  urls: string[],
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  scope?: { byOrigin: Record<string, NetReplay> },
): Promise<ArrayBuffer[]> {
  if (urls.length === 0) throw new Error("No segments to download.");
  if (urls.length > MAX_SEGMENTS) {
    throw new Error(
      `Playlist lists ${urls.length} segments (likely a live stream) — only bounded videos up to ${MAX_SEGMENTS} segments are supported.`,
    );
  }
  const total = urls.length;
  const parts: ArrayBuffer[] = new Array(total);
  let done = 0;
  let bytes = 0;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      throwIfAborted(signal);
      const i = next++;
      if (i >= total) return;
      const buf = await fetchBuffer(urls[i], signal, scope);
      parts[i] = buf;
      bytes += buf.byteLength;
      if (bytes > MAX_BYTES) {
        throw new Error("Video exceeds the 1.5 GB safety cap — download stopped.");
      }
      done++;
      onProgress?.(done, total);
    }
  };
  const pool = Math.min(FETCH_CONCURRENCY, total);
  await Promise.all(Array.from({ length: pool }, () => worker()));
  throwIfAborted(signal);
  return parts;
}

/**
 * HLS assembly: fetch every segment of the chosen variant in order,
 * concatenate into a single Blob (video/mp2t). No remuxing — the .ts
 * plays in VLC and most players. Pure bytes-in/Blob-out: must run in a
 * document context with DOM APIs (offscreen document) — NOT in the
 * service worker. The caller (service worker) performs the actual
 * chrome.downloads.download(), because offscreen documents only have
 * the chrome.runtime API.
 */
export async function assembleHlsBlob(
  variantPlaylistUrl: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  scope?: { byOrigin: Record<string, NetReplay> },
): Promise<Blob> {
  throwIfAborted(signal);
  const playlistRes = await fetch(variantPlaylistUrl, netInit(pickNet(scope, variantPlaylistUrl), signal));
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

  // 5-way parallel fetch, order preserved for concat; retries + caps inside.
  return fetchAllOrdered(segmentUrls, "video/mp2t", onProgress, signal, scope);
}

/** DASH assembly: same concat approach over the parsed variant's segments. */
export async function assembleDashBlob(
  segmentUrls: string[],
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  scope?: { byOrigin: Record<string, NetReplay> },
): Promise<Blob> {
  if (segmentUrls.length === 0)
    throw new Error("No segments listed for this DASH variant.");
  // DASH segments are typically fragmented MP4; concat preserves playability
  // for many players without a full remux (stretch goal, not v1).
  return fetchAllOrdered(segmentUrls, "video/mp4", onProgress, signal, scope);
}

/** Blob -> base64 data URL for transfer to the service worker. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to encode download file."));
      reader.onload = () => {
        if (typeof reader.result === "string") resolve(reader.result);
        else reject(new Error("Failed to encode download file."));
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
