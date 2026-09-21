// Resolve a downloadable HLS/DASH stream at click time.
//
// Detection may have stored a playlist minutes ago. Segment tokens on
// short-lived CDNs expire in tens of seconds, so Download must re-read the
// master and the media playlist now (via whatever fetchText the caller
// supplies — page-world on the live tab) and start from those URLs.

import { parseDashManifest } from "./parseDash";
import { extractHlsSegments, parseHlsManifest } from "./parseHls";
import type { Variant } from "./types";

export const DEFAULT_SEGMENT_CONCURRENCY = 8;
/** Slightly smaller pool so the first signed segments start sooner. */
export const SHORT_LIVED_CONCURRENCY = 4;

const SIGNED_QUERY =
  /(validfrom|validto|expires=|expire=|token=|signature=|hmac=|hash=|policy=|key-pair-id)/i;
const SHORT_LIVED_HOST = /(^|\.)(phncdn|ahcdn|xhcdn|phprcdn|trafficjunky|minvid|vscdns)\.com$/i;

/** True when a URL looks like a short-lived signed CDN object. */
export function isShortLivedSignedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (SHORT_LIVED_HOST.test(u.hostname)) return true;
    return SIGNED_QUERY.test(u.search);
  } catch {
    return false;
  }
}

/** Parallel fetch pool: lower on token-gated CDNs, default otherwise. */
export function segmentConcurrencyFor(urls: string[]): number {
  const sample = urls.slice(0, 4);
  if (sample.some((u) => isShortLivedSignedUrl(u))) return SHORT_LIVED_CONCURRENCY;
  return DEFAULT_SEGMENT_CONCURRENCY;
}

/** Segment lists starting with init-style fMP4 chunks. */
export function looksFmp4Segments(segments: string[]): boolean {
  const first = segments.find((s) => /\.(m4s|mp4|m4v|cmfv|cmfa)(\?|#|$)/i.test(s.split("?")[0]));
  if (first) return true;
  return !segments.some((s) => /\.ts(\?|#|$)/i.test(s.split("?")[0]));
}

/** fMP4 from playlist text (EXT-X-MAP / .m4s) or the resolved segment list. */
export function playlistLooksFmp4(text: string, segments: string[]): boolean {
  if (/#EXT-X-MAP\s*:/i.test(text)) return true;
  if (/^[^#\r\n]*\.(m4s|mp4|m4v|cmfv|cmfa)(\?[^#\r\n]*)?$/im.test(text)) return true;
  if (/^[^#\r\n]*\.ts(\?[^#\r\n]*)?$/im.test(text)) return false;
  return looksFmp4Segments(segments);
}

function hasVideoCodec(codecs?: string): boolean {
  return /(avc|hev|hvc|vp0?9|av0?1)/i.test(codecs ?? "");
}
function hasAudioCodec(codecs?: string): boolean {
  return /(mp4a|opus|ec-3|ac-3|ac-4)/i.test(codecs ?? "");
}

function assertNotEncryptedHls(text: string, drmProtected?: boolean, drmReason?: string): void {
  if (drmProtected) {
    throw new Error(drmReason ?? "Protected content — cannot download (encrypted HLS).");
  }
  if (/#EXT-X-KEY\s*:\s*[^\r\n]*METHOD\s*=\s*(?!NONE\b)/i.test(text)) {
    throw new Error("Protected content — cannot download (encrypted HLS).");
  }
}

export interface HlsDownloadPlan {
  variants: Variant[];
  variant: Variant;
  segments: string[];
  pairUrl?: string;
  pairSegments?: string[];
  muxable: boolean;
  /** Chosen media playlist is open-ended (live/event) — record, don't fetch. */
  isLive?: boolean;
  /** Playlist's #EXT-X-TARGETDURATION (poll interval when live). */
  targetDurationSec?: number;
}

export interface DashDownloadPlan {
  variants: Variant[];
  variant: Variant;
  segments: string[];
  pairSegments?: string[];
  muxable: boolean;
  /** MPD type="dynamic" — record, don't fetch. */
  isLive?: boolean;
  /** MPD minimumUpdatePeriod (poll interval when live). */
  minUpdatePeriodSec?: number;
}

/**
 * Fetch master + media playlists *now* and return the segment URLs to
 * download. `fetchText` is the caller's transport (page-world on the tab).
 */
export async function resolveHlsForDownload(
  masterUrl: string,
  variantId: string | undefined,
  fetchText: (url: string) => Promise<string>,
): Promise<HlsDownloadPlan> {
  const masterText = await fetchText(masterUrl);
  const parsed = parseHlsManifest(masterText, masterUrl);
  assertNotEncryptedHls(masterText, parsed.drmProtected, parsed.drmReason);

  if (!parsed.isMaster) {
    const segments = extractHlsSegments(masterText, masterUrl);
    if (segments.length === 0 && !parsed.isLive)
      throw new Error("No segments found in the HLS variant playlist.");
    return {
      variants: parsed.variants,
      variant: parsed.variants[0],
      segments,
      muxable: false,
      isLive: parsed.isLive,
      targetDurationSec: parsed.targetDurationSec,
    };
  }

  const variant = parsed.variants.find((v) => v.id === variantId) ?? parsed.variants[0];
  if (!variant) throw new Error("This manifest no longer lists a downloadable quality.");

  const mediaText = await fetchText(variant.url);
  assertNotEncryptedHls(mediaText);
  // The chosen variant may itself be a live media playlist.
  const mediaParsed = parseHlsManifest(mediaText, variant.url);
  const segments = extractHlsSegments(mediaText, variant.url);
  if (segments.length === 0 && !mediaParsed.isLive)
    throw new Error("No segments found in the HLS variant playlist.");

  let pairUrl: string | undefined;
  let pairSegments: string[] | undefined;
  let pairText: string | undefined;
  const cc = variant.codecs ?? "";
  if (hasVideoCodec(cc) && !hasAudioCodec(cc)) {
    const audioVariant = parsed.variants.find(
      (v) => hasAudioCodec(v.codecs) && !hasVideoCodec(v.codecs),
    );
    pairUrl = audioVariant?.url ?? variant.audioUrl;
    if (pairUrl) {
      pairText = await fetchText(pairUrl);
      assertNotEncryptedHls(pairText);
      pairSegments = extractHlsSegments(pairText, pairUrl);
      if (pairSegments.length === 0) throw new Error("Paired audio playlist has no segments.");
    }
  }

  const muxable = Boolean(
    pairUrl &&
      pairSegments?.length &&
      playlistLooksFmp4(mediaText, segments) &&
      playlistLooksFmp4(pairText ?? "", pairSegments),
  );
  return {
    variants: parsed.variants,
    variant,
    segments,
    pairUrl,
    pairSegments,
    muxable,
    isLive: mediaParsed.isLive,
    targetDurationSec: mediaParsed.targetDurationSec,
  };
}

/**
 * Fetch the MPD *now* and return the chosen variant's segment URLs.
 */
export async function resolveDashForDownload(
  manifestUrl: string,
  variantId: string | undefined,
  fetchText: (url: string) => Promise<string>,
): Promise<DashDownloadPlan> {
  const text = await fetchText(manifestUrl);
  const parsed = parseDashManifest(text, manifestUrl);
  if (parsed.drmProtected) {
    throw new Error(parsed.drmReason ?? "Protected content — cannot download.");
  }
  const variant = parsed.variants.find((v) => v.id === variantId) ?? parsed.variants[0];
  if (!variant?.segments?.length) throw new Error("No segments listed for this DASH variant.");

  let pairSegments: string[] | undefined;
  const cc = variant.codecs ?? "";
  if (hasVideoCodec(cc) && !hasAudioCodec(cc)) {
    const audio = parsed.variants.find(
      (v) =>
        hasAudioCodec(v.codecs) && !hasVideoCodec(v.codecs) && (v.segments?.length ?? 0) > 0,
    );
    if (audio?.segments?.length) pairSegments = [...audio.segments];
  }
  const muxable = Boolean(
    pairSegments?.length &&
      looksFmp4Segments(variant.segments) &&
      looksFmp4Segments(pairSegments),
  );
  return {
    variants: parsed.variants,
    variant,
    segments: [...variant.segments],
    pairSegments,
    muxable,
    isLive: parsed.isLive,
    minUpdatePeriodSec: parsed.minUpdatePeriodSec,
  };
}
