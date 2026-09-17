import { parse as parseMpd } from "mpd-parser";
import type { Variant } from "./types";

export interface DashParseResult {
  variants: Variant[];
  drmProtected: boolean;
  drmReason?: string;
}

/**
 * Parse a DASH MPD fetched as XML text.
 * `manifestUrl` is required so mpd-parser can resolve SegmentTemplate URLs.
 * DRM (any <ContentProtection>) is reported, never bypassed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function containsContentProtection(node: any): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some(containsContentProtection);
  for (const key of Object.keys(node)) {
    if (key.toLowerCase() === "contentprotection") return true;
    if (containsContentProtection(node[key])) return true;
  }
  return false;
}

export function parseDashManifest(
  xmlText: string,
  manifestUrl: string,
): DashParseResult {
  // Fast DRM pre-check on raw XML (namespace-agnostic).
  const drmProtected =
    /<ContentProtection[\s>]/i.test(xmlText);
  const drmReason = drmProtected
    ? "DASH manifest contains <ContentProtection> (Widevine/PlayReady). Protected content — cannot download."
    : undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = parseMpd(xmlText, { manifestUri: manifestUrl });
  } catch (err) {
    throw new Error(
      `Failed to parse DASH manifest: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Deep-check parsed tree too (catches namespaced variants).
  const drmInTree = containsContentProtection(parsed);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playlists: any[] = parsed?.playlists ?? [];
  const variants: Variant[] = playlists.map((p, i) => {
    const attrs = p?.attributes ?? {};
    const width: number | undefined = attrs?.width ?? attrs?.RESOLUTION?.width;
    const height: number | undefined =
      attrs?.height ?? attrs?.RESOLUTION?.height;
    const resolution =
      width && height ? `${width}x${height}` : undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawSegments: any[] = Array.isArray(p?.segments) ? p.segments : [];
    const urls: string[] = [];
    // Fragmented MP4 needs the init segment first (mpd-parser exposes it
    // as segments[0].map). Without it the concat won't play.
    const initUri: unknown =
      rawSegments[0]?.map?.resolvedUri ?? rawSegments[0]?.map?.uri;
    if (typeof initUri === "string") urls.push(initUri);
    for (const s of rawSegments) {
      const u: unknown = s?.resolvedUri ?? s?.uri;
      if (typeof u === "string") urls.push(u);
    }
    const segments: string[] = [...new Set(urls)].map((u) => {
      try {
        return new URL(u, manifestUrl).toString();
      } catch {
        return u;
      }
    });
    return {
      id: `dash-${i}`,
      url: manifestUrl,
      resolution,
      width,
      height,
      bandwidth: attrs?.bandwidth ?? attrs?.BANDWIDTH,
      codecs: attrs?.codecs ?? attrs?.CODECS,
      segments,
    };
  });

  return {
    variants,
    drmProtected: drmProtected || drmInTree,
    drmReason:
      drmReason ??
      (drmInTree
        ? "DASH manifest contains <ContentProtection>. Protected content — cannot download."
        : undefined),
  };
}
