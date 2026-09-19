/**
 * Pure text helpers for turning page titles into usable names.
 *
 * Kept out of `download.ts` on purpose: the options page and the worker's
 * filename templating only need these, and importing them from `download.ts`
 * would drag the HLS/segment machinery (and `m3u8-parser`) into that bundle.
 */

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
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  if (!s) return "";
  return s.slice(0, max).trim().replace(/[. ]+$/, "") || "";
}
