/**
 * Site-adapter contract.
 *
 * Each adapter recognizes one website (or a family of websites whose APIs or
 * players behave the same way) and extracts downloadable videos from a page
 * snapshot. Adapters must remain pure snapshots: they may inspect strings and
 * build `MediaItem` objects, but must not touch the DOM, issue network calls,
 * use timers, or call `chrome.*` APIs.
 */

import type { MediaItem, MediaType } from "../types";

export interface AdapterPage {
  /** Canonical page URL as seen by the content script. */
  url: string;
  /** Page title, already read from `document.title`. */
  title: string;
  /** Media URLs already found by generic scans and `<video>` elements. */
  mediaUrls: string[];
}

export interface SiteAdapter {
  /** Stable identifier, for example `dailymotion`. */
  id: string;
  /** Returns true when this adapter is responsible for the supplied URL. */
  match: (url: string) => boolean;
  /**
   * Returns downloadable videos for this page. The generic pipeline still
   * validates, deduplicates, classifies, parses manifests, persists, and
   * badges these items.
   */
  extract: (page: AdapterPage) => MediaItem[];
}

export interface AdapterItemOptions {
  /** Media type when already known; the worker classifies `unknown` values. */
  type?: MediaType;
  /** Human-readable title. */
  title?: string;
  /** Optional poster URL discovered near the player. */
  poster?: string;
  /** Whether protection-screening has already determined that this is DRM. */
  drmProtected?: boolean;
}

function adapterTypeForUrl(url: string): MediaType {
  const path = url.toLowerCase().split("?")[0].split("#")[0];
  if (path.endsWith(".m3u8")) return "hls";
  if (path.endsWith(".mpd")) return "dash";
  return "unknown";
}

/**
 * Construct the `MediaItem` shape expected from an adapter. Generic worker
 * fields are normalized here so individual adapters remain small and safe.
 */
export function adapterItem(url: string, options: AdapterItemOptions = {}): MediaItem {
  const title = options.title?.trim();
  return {
    url,
    tabId: -1,
    type: options.type ?? adapterTypeForUrl(url),
    filename: url,
    title: title || undefined,
    titleFromPage: undefined,
    autoNamed: !title,
    detectedAt: 0,
    drmProtected: options.drmProtected ?? false,
    poster: options.poster,
  };
}

/** Lower-case host name, or an empty string when `url` cannot be parsed. */
export function adapterHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}
