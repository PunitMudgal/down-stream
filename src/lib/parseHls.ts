import { Parser } from "m3u8-parser";
import type { Variant } from "./types";

export interface HlsParseResult {
  variants: Variant[];
  drmProtected: boolean;
  drmReason?: string;
  isMaster: boolean;
}

function formatResolution(
  res?: { width?: number; height?: number },
): string | undefined {
  if (!res?.width || !res?.height) return undefined;
  return `${res.width}x${res.height}`;
}

/**
 * Parse an HLS manifest fetched as text.
 * Never throws for DRM — DRM is reported via drmProtected so the popup
 * can explain *why* an item is unavailable. Only throws on malformed input.
 */
export function parseHlsManifest(
  text: string,
  manifestUrl: string,
): HlsParseResult {
  const parser = new Parser();
  parser.push(text);
  parser.end();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const manifest = parser.manifest as any;

  // --- DRM detection: any #EXT-X-KEY with METHOD != NONE ---
  // m3u8-parser exposes key info on media-playlist segments; master
  // playlists can also carry SESSION-DATA/KEY tags, so also scan raw text.
  const hasKeyTag =
    /#EXT-X-KEY\s*:\s*[^\r\n]*METHOD\s*=\s*(?!NONE\b)([A-Z0-9_-]+)/i.test(text);
  let segmentKeyed = false;
  if (Array.isArray(manifest?.segments)) {
    segmentKeyed = manifest.segments.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (s: any) => s?.key?.method && s.key.method !== "NONE",
    );
  }
  const drmProtected = hasKeyTag || segmentKeyed;
  const drmReason = drmProtected
    ? "HLS stream uses encrypted segments (#EXT-X-KEY). Protected content — cannot download."
    : undefined;

  // --- Master playlist: multiple quality variants ---
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playlists: any[] = manifest?.playlists ?? [];
  if (playlists.length > 0) {
    const variants: Variant[] = playlists.map((p, i) => {
      const attrs = p?.attributes ?? {};
      const res = formatResolution(attrs?.RESOLUTION);
      const absolute = safeResolve(p?.uri, manifestUrl);
      return {
        id: `hls-${i}`,
        url: absolute,
        resolution: res,
        height: attrs?.RESOLUTION?.height,
        width: attrs?.RESOLUTION?.width,
        bandwidth: attrs?.BANDWIDTH,
        codecs: attrs?.CODECS,
      };
    });
    pairHlsAudioRenditions(variants, manifest, manifestUrl);
    return { variants, drmProtected, drmReason, isMaster: true };
  }

  // --- Media playlist: single variant (the manifest itself) ---
  const single: Variant = { id: "hls-0", url: manifestUrl };
  return { variants: [single], drmProtected, drmReason, isMaster: false };
}

/**
 * Extract ordered segment URLs from a *media* playlist for download.
 * Call with the text of the chosen variant's playlist.
 * Prepends fMP4 init segments (#EXT-X-MAP) so fragmented-MP4 HLS plays.
 */
export function extractHlsSegments(
  variantPlaylistText: string,
  variantPlaylistUrl: string,
): string[] {
  const parser = new Parser();
  parser.push(variantPlaylistText);
  parser.end();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const manifest = parser.manifest as any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const segments: any[] = manifest?.segments ?? [];
  const out: string[] = [];
  const seenMaps = new Set<string>();
  for (const s of segments) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapUri: unknown = (s as any)?.map?.resolvedUri ?? (s as any)?.map?.uri;
    if (typeof mapUri === "string" && mapUri.length > 0) {
      const abs = safeResolve(mapUri, variantPlaylistUrl);
      if (!seenMaps.has(abs)) {
        seenMaps.add(abs);
        out.push(abs);
      }
    }
  }
  for (const s of segments) {
    const abs = safeResolve(s?.uri, variantPlaylistUrl);
    if (abs) out.push(abs);
  }
  return out;
}

function safeResolve(maybeRelative: unknown, base: string): string {
  if (typeof maybeRelative !== "string" || maybeRelative.length === 0)
    return base;
  try {
    return new URL(maybeRelative, base).toString();
  } catch {
    return base;
  }
}

/**
 * Pair master-playlist AUDIO renditions (#EXT-X-MEDIA:TYPE=AUDIO) onto
 * video-only variants. Many sites (most HLS muxed-A/V setups) put audio in a
 * separate rendition playlist referenced by the variant's `AUDIO` group id —
 * distinct from a variant that itself carries an audio codec. A variant whose
 * CODECS already includes audio is left alone; a video-only variant gets its
 * group's audio playlist attached as `audioUrl` so the downloader muxes them
 * (same path as split A/V pairs). Pure — mutates `variants` in place.
 */
export function pairHlsAudioRenditions(
  variants: Variant[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  manifest: any,
  manifestUrl: string,
): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const playlists: any[] = manifest?.playlists ?? [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const audioGroups: Record<string, Record<string, any>> =
    manifest?.mediaGroups?.AUDIO ?? {};
  if (!Object.keys(audioGroups).length) return;

  const hasAudioCodec = (codecs?: string): boolean =>
    /mp4a|ac-3|ac-4|ec-3|opus|vorbis|flac/i.test(codecs ?? "");

  for (let i = 0; i < variants.length; i++) {
    const v = variants[i];
    if (hasAudioCodec(v.codecs)) continue; // already has sound
    const groupId: unknown = playlists[i]?.attributes?.AUDIO;
    if (typeof groupId !== "string" || !groupId) continue;
    const group = audioGroups[groupId];
    if (!group) continue;
    // Prefer the rendition marked default/autoselect, else the first.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const renditions: any[] = Object.values(group);
    const pick =
      renditions.find((r) => r?.default || r?.autoselect) ?? renditions[0];
    const uri: unknown = pick?.uri;
    if (typeof uri !== "string" || !uri) continue;
    const abs = safeResolve(uri, manifestUrl);
    if (abs && abs !== manifestUrl) v.audioUrl = abs;
  }
}
