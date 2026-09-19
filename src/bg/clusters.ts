// Segment-cluster engine (MSE/blob correlation).
// Moved verbatim from background.ts — zero behavior change.
//
// Blob: URLs are unreachable, but the chunk traffic feeding the player
// isn't. We track segment-like responses per tab, group them by masked URL
// pattern, and promote busy groups to downloadable "segments" items.
import { filenameForUrl } from "../lib/download";
import { getTabItems, persistTab } from "./store";
import { updateBadge, upsertItem } from "./media";

export const MIN_CLUSTER_URLS = 4;
export const MAX_CLUSTER_URLS = 800;
export const MAX_CLUSTERS_PER_TAB = 12;

export interface Cluster {
  key: string;
  frameId: number;
  urls: string[];
  seen: Set<string>;
  bytes: number;
  firstTs: number;
  lastTs: number;
  lastPubCount: number;
  lastPubTs: number;
}

export const clustersByTab = new Map<number, Cluster[]>();

/**
 * Global intake guard for the segment-cluster engine. webRequest wakes the
 * worker for EVERY subresource on media-heavy pages (YouTube fires hundreds
 * of requests/min: thumbnails, stats, segments). Normal volume passes
 * through; over budget we keep only extension-obvious chunks (.ts/.m4s/…)
 * and skip the sequential-URL regex path for the rest.
 */
let recWindowStart = 0;
let recWindowCount = 0;
export function recordAllowed(url: string): boolean {
  const now = Date.now();
  if (now - recWindowStart > 1000) {
    recWindowStart = now;
    recWindowCount = 0;
  }
  recWindowCount++;
  if (recWindowCount <= 150) return true;
  const path = url.toLowerCase().split("?")[0].split("#")[0];
  return /\.(ts|m4s|cmfv|cmfa)$/.test(path);
}

export function segPathExt(pathname: string): string | null {
  const m = /\.([a-z0-9]{2,5})$/.exec(pathname.toLowerCase());
  return m ? m[1] : null;
}

/** Cheap sequential-chunk heuristic for non-manifest responses. */
export function looksSequential(url: string): boolean {
  const path = url.toLowerCase().split("?")[0];
  if (/(seg|chunk|part|frag|seq|slice|cam|stream)[-_./]?\d/i.test(path)) return true;
  if (/\d{2,}\.(ts|m4s|m4v|cmfv|cmfa|mp4)/i.test(path)) return true;
  if (/[?&](seg|seq|part|chunk|index|no|n|counter)=\d+/i.test(url.toLowerCase())) return true;
  return false;
}

export function isSegmentCandidate(url: string, ct: string, status: number): boolean {
  if (status < 200 || status >= 300) return false;
  const path = url.toLowerCase().split("?")[0].split("#")[0];
  const ext = segPathExt(path);
  // Raw HLS/DASH chunks by extension — regardless of content-type.
  if (ext && ["ts", "m4s", "m4v", "cmfv", "cmfa"].includes(ext)) return true;
  // Range-chunked progressive files (one mp4/webm fetched as many 206s).
  if (status === 206 && ext && ["mp4", "webm", "m4v"].includes(ext)) return true;
  if (ct === "video/mp2t") return true;
  if ((ct.startsWith("video/") || ct === "application/octet-stream") && looksSequential(url)) {
    return true;
  }
  return false;
}

/** Group key: origin + digit-masked path (keeps extension + structure). */
export function clusterKey(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin} ${u.pathname.replace(/\d+/g, "#")}`;
  } catch {
    return null;
  }
}

export function recordCandidate(
  tabId: number,
  frameId: number,
  url: string,
  contentType: string,
  statusCode: number,
  contentLength = 0,
): void {
  if (!recordAllowed(url)) return;
  const ct = contentType.toLowerCase().split(";")[0].trim();
  if (!isSegmentCandidate(url, ct, statusCode)) return;
  const key = clusterKey(url);
  if (!key) return;
  let list = clustersByTab.get(tabId);
  if (!list) {
    list = [];
    clustersByTab.set(tabId, list);
  }
  let cluster = list.find((c) => c.key === key && c.frameId === frameId);
  if (!cluster) {
    // New group; evict the stalest cluster if over budget.
    if (list.length >= MAX_CLUSTERS_PER_TAB) {
      list.sort((a, b) => a.lastTs - b.lastTs);
      list.shift();
    }
    cluster = {
      key,
      frameId,
      urls: [],
      seen: new Set(),
      bytes: 0,
      firstTs: Date.now(),
      lastTs: Date.now(),
      lastPubCount: 0,
      lastPubTs: 0,
    };
    list.push(cluster);
  }
  if (cluster.seen.has(url) || cluster.urls.length >= MAX_CLUSTER_URLS) {
    cluster.lastTs = Date.now();
    return;
  }
  cluster.seen.add(url);
  cluster.urls.push(url); // keep signed query params — needed to fetch
  if (contentLength > 0) cluster.bytes += contentLength;
  cluster.lastTs = Date.now();
  void maybePromoteCluster(tabId, cluster);
}

export function clusterBytesLabel(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1_000_000) return `≈${Math.round(bytes / 1000)} KB`;
  return `≈${(bytes / 1_000_000).toFixed(1)} MB`;
}

export async function maybePromoteCluster(tabId: number, cluster: Cluster): Promise<void> {
  if (cluster.urls.length < MIN_CLUSTER_URLS) return;
  // Throttle republishing: every +20 urls or 30s, whichever first. Each
  // publish is a storage read-modify-write + badge update — on segment-heavy
  // pages (YouTube) the old 8-url/10s cadence kept the worker and storage
  // churning constantly for rows the user may never open.
  if (
    cluster.urls.length - cluster.lastPubCount < 20 &&
    Date.now() - cluster.lastPubTs < 30_000
  ) {
    return;
  }
  const items = await getTabItems(tabId);
  // A parsed manifest supersedes raw chunk groups — skip promoting noise on
  // pages where real qualities already exist.
  if (
    items.some(
      (x) => (x.type === "hls" || x.type === "dash") && (x.variants?.length ?? 0) > 0,
    )
  ) {
    return;
  }
  // A known item for the canonical URL already covers this stream.
  if (items.some((x) => x.url === cluster.urls[0])) return;
  const existing = items.find((x) => x.type === "segments" && x.url === cluster.urls[0]);
  const meta = `${cluster.urls.length} segments • auto-grouped, experimental${cluster.bytes ? ` • ${clusterBytesLabel(cluster.bytes)}` : ""}`;
  if (existing) {
    existing.segments = [...cluster.urls];
    existing.meta = meta;
    await persistTab(tabId, items);
  } else {
    await upsertItem(tabId, {
      url: cluster.urls[0],
      tabId,
      frameId: cluster.frameId,
      type: "segments",
      filename: filenameForUrl(cluster.urls[0], "segments"),
      autoNamed: true,
      detectedAt: Date.now(),
      drmProtected: false,
      segments: [...cluster.urls],
      meta,
    });
  }
  cluster.lastPubCount = cluster.urls.length;
  cluster.lastPubTs = Date.now();
}

/** A parsed manifest supersedes raw clusters from the same directory. */
export async function dropSupersededClusters(tabId: number, manifestUrl: string): Promise<void> {
  let dir: string;
  try {
    const u = new URL(manifestUrl);
    dir = u.origin + u.pathname.slice(0, u.pathname.lastIndexOf("/") + 1);
  } catch {
    return;
  }
  const items = await getTabItems(tabId);
  const doomed = new Set(
    items
      .filter((x) => x.type === "segments" && x.url.startsWith(dir))
      .map((x) => x.url),
  );
  if (!doomed.size) return;
  await persistTab(
    tabId,
    items.filter((x) => !doomed.has(x.url)),
  );
  await updateBadge(tabId);
}

/** Recent cluster in the same frame — the likely source of a blob: URL. */
export function matchCluster(tabId: number, frameId: number | undefined): Cluster | undefined {
  const list = clustersByTab.get(tabId);
  if (!list?.length) return undefined;
  const now = Date.now();
  const recent = list.filter((c) => now - c.lastTs < 90_000);
  const sameFrame = frameId != null ? recent.filter((c) => c.frameId === frameId) : [];
  const pool = sameFrame.length ? sameFrame : recent;
  return pool.sort((a, b) => b.urls.length - a.urls.length)[0];
}

export function clearClustersForTab(tabId: number): void {
  clustersByTab.delete(tabId);
}

/** Test-only: reset the global intake-guard window. */
export function __resetRecordWindowForTests(): void {
  recWindowStart = 0;
  recWindowCount = 0;
}
