// URL/URL+content-type classification shared by the background worker, the
// popup (page-scan fallback path) and tests. Moved verbatim from
// background.ts so every caller scores URLs identically.

export type MediaType =
  | "mp4"
  | "webm"
  | "ogg"
  | "mov"
  | "mkv"
  | "avi"
  | "flv"
  | "wmv"
  | "mpg"
  | "hls"
  | "dash"
  | "segments"
  | "capture"
  | "blob"
  | "blobfile"
  | "unknown";

/**
 * Conservative chunk detector for ITEM classification (not clustering).
 * Scores path signals; threshold 3 keeps real files safe:
 * - `/2024/01/clip.mp4` scores 2 (two digit tokens) -> kept as video
 * - `…/avc1/0/0/1440x1440/x.mp4` scores 6+ (codec+digits+dimensions) -> chunk
 * - any .ts/.m4s/.cmfv/.cmfa URL -> chunk regardless of content-type
 */
export function looksLikeChunk(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  if (/\.(ts|m4s|cmfv|cmfa)$/.test(path)) return true;
  const tokens = path.split("/").filter(Boolean);
  let score = 0;
  let digitTokens = 0;
  for (let raw of tokens) {
    const t = raw.replace(/\.[a-z0-9]{2,5}$/, ""); // strip extension
    if (/^\d+$/.test(t)) {
      digitTokens++;
      continue;
    }
    if (/\d+x\d+/.test(t)) score += 2; // dimensions: 1440x1440, 900x720
    if (/^(avc1|mp4a|hev1|hvc1|vp09|av01|ec-3|ec3|ac-3|ac-4|opus)$/.test(t)) score += 2;
    if (/(seg|chunk|frag|part|range|seq|stream|media|track|video|audio)[-_./]?\d/i.test(t)) score += 2;
  }
  score += Math.min(2, digitTokens);
  if (score >= 3) return true;
  // .m4v is ambiguous (fMP4 chunk vs iTunes movie): chunk only with backup signal.
  if (/\.m4v$/.test(path) && score >= 2) return true;
  return false;
}

export function classify(url: string, contentType: string): MediaType | null {
  const ct = contentType.toLowerCase().split(";")[0].trim();
  const lower = url.toLowerCase().split("?")[0].split("#")[0];

  if (lower.endsWith(".m3u8") || ct === "application/vnd.apple.mpegurl" || ct === "application/x-mpegurl")
    return "hls";
  if (lower.endsWith(".mpd") || ct === "application/dash+xml") return "dash";
  if (lower.endsWith(".ism/manifest") || lower.endsWith(".ism/manifest(format=mpd-time-csf)")) return "dash";
  if (url.startsWith("blob:")) return "blob";
  // Raw stream fragments are never standalone videos — the cluster engine
  // owns them (they'd otherwise flood the popup, e.g. X's video/mp4 .m4s).
  if (looksLikeChunk(url)) return null;
  if (ct === "video/mp4") return "mp4";
  if (ct === "video/webm") return "webm";
  if (ct === "video/ogg") return "ogg";
  if (ct === "video/quicktime") return "mov";
  if (ct === "video/x-matroska") return "mkv";
  if (ct === "video/x-msvideo" || ct === "video/avi") return "avi";
  if (ct === "video/x-flv") return "flv";
  if (ct === "video/x-ms-wmv") return "wmv";
  if (ct === "video/mpeg" || ct === "video/mp2v") return "mpg";
  // NOTE: video/mp2t and octet-stream are segment/chunk types — never items.
  if (lower.endsWith(".mp4")) return "mp4";
  if (lower.endsWith(".m4v")) return "mp4";
  if (lower.endsWith(".webm")) return "webm";
  if (lower.endsWith(".ogv") || lower.endsWith(".ogg")) return "ogg";
  if (lower.endsWith(".mov")) return "mov";
  if (lower.endsWith(".mkv")) return "mkv";
  if (lower.endsWith(".avi")) return "avi";
  if (lower.endsWith(".flv") || lower.endsWith(".f4v")) return "flv";
  if (lower.endsWith(".wmv")) return "wmv";
  if (lower.endsWith(".mpg") || lower.endsWith(".mpeg") || lower.endsWith(".m2v")) return "mpg";
  if (lower.endsWith(".3gp") || lower.endsWith(".3g2")) return "mp4";
  return null;
}
