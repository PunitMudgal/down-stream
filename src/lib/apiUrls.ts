/**
 * Direct playable-file URLs hiding in page API JSON.
 * Sites like Pinterest return one JSON blob carrying BOTH the HLS manifest
 * (`playbackUrl: ...m3u8`) and the progressive file (`videoUrl: ...mp4`).
 * The file row is the reliable download (no segment surgery needed), so the
 * page hook extracts it whenever a response already proved manifest-bearing.
 * Only called on manifest-bearing bodies — never a global scrape.
 */

const FILE_RE =
  /(https?:\/\/[^\s"'<>\\]+\.(?:mp4|m4v|webm|mov)(?:\?[^\s"'<>\\]*)?|\/\/[^\s"'<>\\]+\.(?:mp4|m4v|webm|mov)(?:\?[^\s"'<>\\]*)?)/gi;

/** Chunk/fragment extensions are stream pieces, never standalone files. */
const CHUNK_EXT_RE = /\.(ts|m4s|m4v|cmfv|cmfa)(\?|#|$)/i;

const MAX_FILE_URLS = 10;

export function extractMediaFileUrls(text: string): string[] {
  const out: string[] = [];
  if (!text) return out;
  const clean = text.replace(/\\\//g, "/");
  FILE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while (out.length < MAX_FILE_URLS && (m = FILE_RE.exec(clean)) !== null) {
    let u = m[0];
    if (u.startsWith("//")) continue; // no protocol context in a JSON blob
    try {
      const path = new URL(u).pathname;
      if (CHUNK_EXT_RE.test(path.split("?")[0])) continue;
    } catch {
      continue;
    }
    if (!out.includes(u)) out.push(u);
  }
  return out;
}
