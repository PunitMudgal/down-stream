/**
 * Output naming: user filename templates ({title} [{quality}] …) and the
 * download subfolder. Pure string logic so the worker (which renders the
 * final destination before dispatching a job) and the options-page preview
 * compute exactly the same name.
 *
 * Everything here is deliberately conservative: the result must be a valid
 * relative path for `chrome.downloads.download({ filename })` — no absolute
 * paths, no "..", no characters a filesystem rejects.
 */
import { cleanTitle, sanitizeStem } from "./text";

/** Default pattern: "My video [1080p]". Brackets collapse when a value is empty. */
export const DEFAULT_FILENAME_TEMPLATE = "{title} [{quality}]";

/** Placeholders users can put in a template (case-insensitive). */
export const TEMPLATE_PLACEHOLDERS = ["title", "quality", "ext", "host", "type", "date"] as const;

/** Extensions we treat as "already named" — anything else gets `.ext` appended. */
const KNOWN_MEDIA_EXT =
  /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi|flv|f4v|wmv|mpg|mpeg|3gp|3g2|ts|m4a|mp3|aac|opus)$/i;

export interface FilenameContext {
  /** Video/post title. Falls back to `fallbackStem` when unusable. */
  title?: string;
  /** "1080p", "4K", "Audio only" … empty when unknown. */
  quality?: string;
  /** Container extension without the dot. */
  ext?: string;
  /** Source host, for `{host}`. */
  host?: string;
  /** Media type badge lowercased ("hls", "dash", "mp4", …). */
  type?: string;
  /** Timestamp for `{date}` (defaults to now). */
  date?: Date;
}

/** "1080p" / "720p" / "" from a variant's resolution or height. */
export function qualityLabel(v?: { resolution?: string; height?: number }): string {
  if (!v) return "";
  if (typeof v.height === "number" && v.height > 0) return `${v.height}p`;
  const m = /(\d+)\s*x\s*(\d+)/i.exec(v.resolution ?? "");
  if (m) return `${m[2]}p`;
  return v.resolution ? v.resolution.replace(/\s+/g, "") : "";
}

/** Host of a URL, or "" when it isn't parseable. */
export function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/** Date as `YYYY-MM-DD` (stable, filesystem-safe, sorts naturally). */
export function dateStamp(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Strip empty bracket groups left behind when a placeholder resolved to "". */
function pruneEmptyGroups(s: string): string {
  return s
    .replace(/[[({]\s*[\])}]/g, " ")
    .replace(/\s*[[({]\s*[\])}]\s*/g, " ")
    .replace(/\s+/g, " ");
}

/** Drop leading/trailing separator noise so " - Title - " becomes "Title". */
function trimSeparators(s: string): string {
  return s.replace(/^[\s\-–—_.|,]+/, "").replace(/[\s\-–—_.|,]+$/, "").trim();
}

/**
 * Render a filename template to a safe basename. Placeholders that resolve to
 * nothing collapse (so "{title} [{quality}]" stays clean for direct files),
 * unknown placeholders are dropped, whitespace/separators are normalized, and
 * the container extension is guaranteed.
 *
 * Returns "" only when the template has no usable content at all — callers then
 * keep the detected name.
 */
export function renderFilename(
  template: string,
  ctx: FilenameContext,
  fallbackStem: string,
): string {
  const ext = (ctx.ext ?? "mp4").replace(/^\./, "").toLowerCase();
  const title = sanitizeStem(cleanTitle(ctx.title)) || sanitizeStem(fallbackStem) || "video";
  const values: Record<string, string> = {
    title,
    quality: sanitizeStem(ctx.quality ?? ""),
    ext,
    host: sanitizeStem(hostOf(ctx.host ?? "")),
    type: sanitizeStem(ctx.type ?? ""),
    date: dateStamp(ctx.date),
  };
  const replaced = template.replace(/\{\s*([a-z]+)\s*\}/gi, (_m, name: string) => {
    const key = name.toLowerCase();
    return key in values ? values[key] : "";
  });
  const cleaned = trimSeparators(pruneEmptyGroups(replaced));
  const stem = sanitizeStem(cleaned) || title;
  const named = KNOWN_MEDIA_EXT.test(stem) ? stem : `${stem}.${ext}`;
  return sanitizePathSegment(named).slice(0, 180) || `video.${ext}`;
}

/** Make one path segment filesystem-safe (no separators, no "." / ".."). */
export function sanitizePathSegment(segment: string): string {
  const cleaned = segment
    .replace(/[<>:"|?*\u0000-\u001F]/g, "_")
    .replace(/[\\/]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+$/, "_")
    .replace(/[. ]+$/, "");
  return cleaned;
}

/**
 * Normalize a user-supplied subfolder ("Videos/down-stream/") into a safe
 * relative path: separators unified, empty/"."/".." segments dropped, each
 * segment sanitized. Returns "" for the downloads root.
 */
export function sanitizeSubfolder(subfolder: string): string {
  if (!subfolder) return "";
  return subfolder
    .split(/[\\/]+/)
    .map((s) => sanitizePathSegment(s))
    .filter((s) => s && s !== "." && s !== ".." && s !== "_")
    .join("/");
}

/** Last path segment of a relative download path. */
export function basenameOf(relPath: string): string {
  const i = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
  return i >= 0 ? relPath.slice(i + 1) : relPath;
}

/** Directory part of a relative download path ("" when there is none). */
export function dirOf(relPath: string): string {
  const i = Math.max(relPath.lastIndexOf("/"), relPath.lastIndexOf("\\"));
  return i >= 0 ? relPath.slice(0, i) : "";
}

/** Join a sanitized subfolder with a filename (filename is a basename). */
export function joinDownloadPath(subfolder: string, filename: string): string {
  const dir = sanitizeSubfolder(subfolder);
  const file = basenameOf(filename).slice(0, 180);
  return dir ? `${dir}/${file}` : file;
}

/**
 * Swap a relative path's extension while keeping its directory — the offscreen
 * document sniffs the real container (`.ts` vs `.mp4`) after assembly, and the
 * result must stay inside the configured subfolder.
 */
export function withExtPreservingDir(relPath: string, ext: string): string {
  const dir = dirOf(relPath);
  const suffix = ext.startsWith(".") ? ext : `.${ext}`;
  const base = basenameOf(relPath).replace(/\.[a-z0-9]+$/i, "") || "video";
  const out = `${base}${suffix}`;
  return dir ? `${dir}/${out}` : out;
}
