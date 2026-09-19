/**
 * Pluggable site-adapter registry.
 *
 * Most sites are handled by generic detection: network traffic, page scans,
 * manifest parsing, and MSE/blob capture. Adapters cover exceptional websites
 * whose media cannot be discovered that way.
 *
 * Invariants:
 * - Registered adapters are pure and side-effect free.
 * - YouTube and its delivery hosts are permanently excluded here, below the
 *   page-level and manifest-level exclusions.
 * - An adapter failure never prevents generic detection from running.
 */

import type { MediaItem } from "../types";
import { adapterHost, type AdapterPage, type SiteAdapter } from "./types";

export type { AdapterPage, SiteAdapter };
export { adapterHost, adapterItem } from "./types";

const BLOCKED_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|googlevideo\.com)$/i;

/**
 * Additional registry-level YouTube exclusion. Site adapters must also encode
 * their own `match` predicate narrowly, but this prevents misconfiguration or
 * a future adapter from accidentally touching an excluded host. Unparseable
 * values are treated as blocked: adapters only receive well-formed URLs from
 * the content-script snapshot.
 */
export function isAdapterBlockedUrl(url: string): boolean {
  if (typeof url !== "string" || url.length === 0) return true;
  try {
    return BLOCKED_HOST_RE.test(adapterHost(url));
  } catch {
    return true;
  }
}

/**
 * Registered adapters, checked in order. This intentionally starts empty: add
 * one module per exceptional website as production issues are reproduced.
 */
export const ADAPTERS: SiteAdapter[] = [];

/** Every registered adapter whose `match` predicate accepts this page URL. */
export function matchAdapters(url: string): SiteAdapter[] {
  if (!url || isAdapterBlockedUrl(url)) return [];
  return ADAPTERS.filter((adapter) => {
    try {
      return adapter.match(url);
    } catch {
      return false;
    }
  });
}

/**
 * Extract downloadable items from every matching adapter. Output is cleaned
 * and deduplicated, while preserving rich adapter metadata for display and
 * filenames. Manifest URLs, titles, posters, and DRM markers survive.
 */
export function extractWithAdapters(page: AdapterPage): MediaItem[] {
  const seen = new Set<string>();
  const items: MediaItem[] = [];
  if (!page || !page.url || isAdapterBlockedUrl(page.url)) return items;

  for (const adapter of matchAdapters(page.url)) {
    let extracted: MediaItem[];
    try {
      extracted = adapter.extract(page) ?? [];
    } catch {
      continue;
    }
    if (!Array.isArray(extracted)) continue;
    for (const item of extracted) {
      const url = item?.url;
      if (typeof url !== "string" || url.length === 0) continue;
      if (isAdapterBlockedUrl(url)) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      items.push(item);
    }
  }
  return items;
}
