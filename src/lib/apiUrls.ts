/**
 * Direct playable-file URLs hiding in page API JSON.
 * Sites like Pinterest return one JSON blob carrying BOTH the HLS manifest
 * (`playbackUrl: ...m3u8`) and the progressive file (`videoUrl: ...mp4`).
 * Instagram GraphQL instead embeds `video_versions` / an inline DASH MPD
 * with no `.m3u8`/`.mpd` URL — the same extractor covers those bodies once
 * the cheap hint below says they are media-bearing.
 * Only called on media-bearing bodies — never a global scrape.
 */

const FILE_RE =
  /(https?:\/\/[^\s"'<>\\]+\.(?:mp4|m4v|webm|mov)(?:\?[^\s"'<>\\]*)?|\/\/[^\s"'<>\\]+\.(?:mp4|m4v|webm|mov)(?:\?[^\s"'<>\\]*)?)/gi;

/**
 * Instagram (and some Facebook) progressive videos are served from
 * `/o1/v/…` without a file extension. The player still downloads a complete
 * MP4; the extensionless URL is the downloadable file.
 */
const IG_VIDEO_RE =
  /https?:\/\/[^\s"'<>\\]+(?:cdninstagram\.com|fbcdn\.net)\/o1\/v\/[^\s"'<>\\]+/gi;

/** Chunk/fragment extensions are stream pieces, never standalone files. */
const CHUNK_EXT_RE = /\.(ts|m4s|m4v|cmfv|cmfa)(\?|#|$)/i;
const IMAGE_EXT_RE = /\.(?:jpe?g|png|webp|gif|heic|avif)(\?|#|$)/i;

const MAX_FILE_URLS = 10;

/**
 * Cheap substring gate before any regex. True when a response body is worth
 * scanning for downloadable media (playlists, inline MPD, or Instagram-style
 * progressive-file lists). False for ordinary JSON.
 */
export function hasMediaBodyHint(text: string): boolean {
  if (!text) return false;
  return (
    text.indexOf(".m3u8") !== -1 ||
    text.indexOf(".M3U8") !== -1 ||
    text.indexOf(".mpd") !== -1 ||
    text.indexOf(".MPD") !== -1 ||
    text.indexOf("<MPD") !== -1 ||
    text.indexOf("<mpd") !== -1 ||
    text.indexOf("video_dash_manifest") !== -1 ||
    text.indexOf("video_versions") !== -1 ||
    text.indexOf("dash_manifest") !== -1
  );
}

function takeUrl(out: string[], raw: string): void {
  let u = raw;
  if (u.startsWith("//")) return;
  try {
    const path = new URL(u).pathname;
    if (CHUNK_EXT_RE.test(path.split("?")[0])) return;
    if (IMAGE_EXT_RE.test(path.split("?")[0])) return;
  } catch {
    return;
  }
  if (!out.includes(u)) out.push(u);
}

export function extractMediaFileUrls(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;
  const clean = text.replace(/\\\//g, "/");
  FILE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (out.length < MAX_FILE_URLS && (m = FILE_RE.exec(clean)) !== null) {
    takeUrl(out, m[0]);
  }
  IG_VIDEO_RE.lastIndex = 0;
  while (out.length < MAX_FILE_URLS && (m = IG_VIDEO_RE.exec(clean)) !== null) {
    takeUrl(out, m[0]);
  }
  return out;
}
