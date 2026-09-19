// Manifest text cache + failure reporting.
//
// Playlists are fetched several times per item (detection parse, quality
// probe, download, history re-download). Re-fetching is not just slow: signed
// CDN URLs expire in minutes, so a second fetch can 403/404 where the first
// one succeeded. Caching the bytes we already have removes that whole class of
// failure — and the cache is also the last-resort answer when every fetch path
// is refused.
//
// Keys: the exact URL, plus a query-stripped "path key" alias so a re-detected
// URL with a rotated token still finds the text. Pure module — no chrome APIs.

export const MANIFEST_CACHE_MAX = 24;
export const MANIFEST_CACHE_TTL_MS = 5 * 60_000;

/**
 * Query-stripped identity of a manifest (origin + path). Playlist tokens live
 * in the query string and rotate per request; the path is the stable part.
 */
export function manifestCacheKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.toLowerCase();
  } catch {
    return url;
  }
}

interface Entry {
  text: string;
  at: number;
}

/**
 * Bounded TTL cache keyed by exact URL with a path-key alias. Writes refresh
 * insertion order, so eviction is least-recently-written.
 */
export class ManifestCache {
  private readonly entries = new Map<string, Entry>();
  /** path alias -> the distinct URLs captured for it (ambiguity guard). */
  private readonly paths = new Map<string, Set<string>>();

  constructor(
    private readonly max: number = MANIFEST_CACHE_MAX,
    private readonly ttlMs: number = MANIFEST_CACHE_TTL_MS,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  /**
   * Exact URL first, then the path alias. The alias answers only when exactly
   * one URL was ever stored for that path: two videos served from the same
   * playlist path with different tokens must never swap bytes.
   */
  get(url: string, now: number = Date.now()): string | undefined {
    const exact = this.read(url, now);
    if (exact !== undefined) return exact;
    const alias = manifestCacheKey(url);
    if (alias === url) return undefined;
    const urls = this.paths.get(alias);
    if (!urls || urls.size !== 1) return undefined;
    return this.read(alias, now);
  }

  set(url: string, text: string, now: number = Date.now()): void {
    if (!text) return;
    this.write(url, text, now);
    const alias = manifestCacheKey(url);
    if (alias === url) return;
    this.write(alias, text, now);
    let urls = this.paths.get(alias);
    if (!urls) {
      urls = new Set<string>();
      this.paths.set(alias, urls);
    }
    urls.add(url);
  }

  drop(url: string): void {
    this.forget(url);
    this.forget(manifestCacheKey(url));
  }

  clear(): void {
    this.entries.clear();
    this.paths.clear();
  }

  private read(key: string, now: number): string | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (now - hit.at > this.ttlMs) {
      this.forget(key);
      return undefined;
    }
    return hit.text;
  }

  /** Delete an entry and unregister it from its path alias set. */
  private forget(key: string): void {
    this.entries.delete(key);
    const path = manifestCacheKey(key);
    const urls = this.paths.get(path);
    if (!urls) return;
    urls.delete(key);
    if (!urls.size) this.paths.delete(path);
  }

  private write(key: string, text: string, now: number): void {
    this.entries.delete(key); // re-insert so the Map order reflects recency
    this.entries.set(key, { text, at: now });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    // Path sets may reference an evicted URL; they are cleaned lazily by
    // `get` (a set keeping a dead URL never resolves to one).
  }
}

/** How a fetch path failed: an HTTP status, or a transport-level problem. */
export interface FetchAttempt {
  status?: number;
  network?: boolean;
  reason?: string;
}

/** Compact label for one failed attempt ("404", "network", "timed out"). */
export function shortFailure(attempt: FetchAttempt | undefined): string | undefined {
  if (!attempt) return undefined;
  if (attempt.status) return String(attempt.status);
  const reason = attempt.reason ?? "";
  // Reasons carry the status in prose ("Page fetch failed (404)").
  const code = reason.match(/\b([45]\d\d)\b/);
  if (code) return code[1];
  if (/too large|truncated/i.test(reason)) return "too large";
  if (/timeout|timed out|abort/i.test(reason)) return "timed out";
  if (/failed to fetch|networkerror|load failed|network/i.test(reason)) return "unreachable";
  if (/no receiving end|receiving end does not exist|could not establish/i.test(reason)) {
    return "page unavailable";
  }
  return attempt.network ? "unreachable" : "failed";
}

function describe(attempts: Array<[string, FetchAttempt | undefined]>): string {
  return attempts
    .map(([label, attempt]) => {
      const short = shortFailure(attempt);
      return short ? `${label}: ${short}` : undefined;
    })
    .filter((x): x is string => Boolean(x))
    .join(" · ");
}

/**
 * One actionable sentence for a manifest that no fetch path could read.
 * Names what was tried so a bug report (or a user) can tell "expired link"
 * from "site blocks the extension".
 */
export function manifestFailureMessage(
  extension: FetchAttempt | undefined,
  page: FetchAttempt | undefined,
): string {
  const detail = describe([
    ["extension", extension],
    ["page", page],
  ]);
  const head = detail ? `Couldn't read the stream list (${detail})` : "Couldn't read the stream list";
  return `${head}. Play the video for a few seconds, then hit Retry — or Rescan.`;
}
