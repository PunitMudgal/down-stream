import { parseHlsManifest } from "./lib/parseHls";
import { parseDashManifest } from "./lib/parseDash";
import { cleanTitle, downloadDirect, filenameForUrl, sanitizeStem } from "./lib/download";
import type {
  DownloadJobRequest,
  DownloadJobState,
  MediaItem,
  MediaType,
  MsSessionMeta,
  NetReplay,
  VideoSignal,
} from "./lib/types";

// In-memory caches (fast path) + chrome.storage.session mirrors (survive SW suspend).
const memoryStore = new Map<number, MediaItem[]>();
const jobMemory = new Map<string, DownloadJobState>();
const lastUrlByTab = new Map<number, string>();
const SESSION_KEY = "mediaByTab";
const JOBS_KEY = "downloadJobs";
const OFFSCREEN_URL = "src/offscreen.html";
const MAX_ITEMS_PER_TAB = 60;
const MAX_BLOB_PER_TAB = 25;

function newJobId(): string {
  return `job-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function readSessionKey<T>(key: string, fallback: T, ms = 2500): Promise<T> {
  // Never let a slow/unavailable storage backend hang a popup response:
  // race the read against a timeout and fall back to memory/empty.
  try {
    const got = await Promise.race([
      chrome.storage.session.get(key),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("storage read timeout")), ms),
      ),
    ]);
    const val = (got as Record<string, unknown>)[key];
    if (val && typeof val === "object") return val as T;
  } catch {
    /* storage.session unavailable or slow — fall back to memory only */
  }
  return fallback;
}

async function persistTab(tabId: number, items: MediaItem[]): Promise<void> {
  memoryStore.set(tabId, items);
  try {
    const all = await readSessionKey<Record<string, MediaItem[]>>(SESSION_KEY, {});
    all[String(tabId)] = items;
    await chrome.storage.session.set({ [SESSION_KEY]: all });
  } catch {
    /* ignore persistence failures */
  }
}

async function getTabItems(tabId: number): Promise<MediaItem[]> {
  const mem = memoryStore.get(tabId);
  if (mem) return mem;
  const all = await readSessionKey<Record<string, MediaItem[]>>(SESSION_KEY, {});
  const items = all[String(tabId)] ?? [];
  memoryStore.set(tabId, items);
  return items;
}

async function persistJobs(): Promise<void> {
  try {
    // Prune: keep the 30 most recent jobs so session storage stays small.
    const sorted = [...jobMemory.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    jobMemory.clear();
    for (const j of sorted.slice(0, 30)) jobMemory.set(j.jobId, j);
    const all: Record<string, DownloadJobState> = {};
    for (const [id, job] of jobMemory) all[id] = job;
    await chrome.storage.session.set({ [JOBS_KEY]: all });
  } catch {
    /* ignore */
  }
}

async function ensureJobsLoaded(): Promise<void> {
  if (jobMemory.size > 0) return;
  const all = await readSessionKey<Record<string, DownloadJobState>>(JOBS_KEY, {});
  for (const [id, job] of Object.entries(all)) jobMemory.set(id, job);
}

async function getTabJobs(tabId: number): Promise<DownloadJobState[]> {
  await ensureJobsLoaded();
  return [...jobMemory.values()]
    .filter((j) => j.tabId === tabId)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

const lastJobPersist = new Map<string, number>();

async function upsertJob(job: DownloadJobState, persist = true): Promise<void> {
  job.updatedAt = Date.now();
  jobMemory.set(job.jobId, job);
  // Progress ticks arrive per segment — throttle session writes (quota),
  // but always broadcast so an open popup stays live.
  if (persist) {
    await persistJobs();
    lastJobPersist.set(job.jobId, Date.now());
  } else {
    const last = lastJobPersist.get(job.jobId) ?? 0;
    if (Date.now() - last > 2000) {
      await persistJobs();
      lastJobPersist.set(job.jobId, Date.now());
    }
  }
  // Broadcast so an open popup updates live (content scripts ignore it).
  try {
    await chrome.runtime.sendMessage({ type: "JOB_UPDATED", job });
  } catch {
    /* popup closed — state reconciles via GET_JOBS on reopen */
  }
}

function codecsOf(v?: { codecs?: string }): string {
  return (v?.codecs ?? "").toLowerCase();
}
function hasVideoCodec(c: string): boolean {
  return /(avc|hev|hvc|vp0?9|av0?1)/.test(c);
}
function hasAudioCodec(c: string): boolean {
  return /(mp4a|opus|ec-3|ac-3|ac-4)/.test(c);
}

/**
 * Mirror of the popup display filter — the badge shows the same real-video
 * count the popup does (manifests dominate; fragments/placeholders hidden).
 */
function countForBadge(items: MediaItem[]): number {
  const hasManifest = items.some(
    (x) => (x.type === "hls" || x.type === "dash") && (x.variants?.length ?? 0) > 0 && !x.drmProtected,
  );
  const visible = hasManifest ? items.filter((x) => x.type !== "blob" && x.type !== "segments") : items;
  return visible.filter((x) => x.type !== "blob").length;
}

/** Badge counts real videos, not blob placeholders or raw fragments. */
async function updateBadge(tabId: number): Promise<void> {
  try {
    const items = await getTabItems(tabId);
    const count = countForBadge(items);
    await chrome.action.setBadgeText({
      text: count > 0 ? String(count) : "",
      tabId,
    });
    await chrome.action.setBadgeBackgroundColor({ color: "#1a73e8", tabId });
  } catch {
    /* badge is best-effort */
  }
}

async function updateBadgeForActiveTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.id != null) await updateBadge(tab.id);
  } catch {
    /* ignore */
  }
}

const DIRECT_TYPES = new Set([
  "mp4", "webm", "ogg", "mov", "mkv", "avi", "flv", "wmv", "mpg",
]);

function classify(url: string, contentType: string): MediaType | null {
  const ct = contentType.toLowerCase().split(";")[0].trim();
  const lower = url.toLowerCase().split("?")[0].split("#")[0];

  if (lower.endsWith(".m3u8") || ct === "application/vnd.apple.mpegurl" || ct === "application/x-mpegurl")
    return "hls";
  if (lower.endsWith(".mpd") || ct === "application/dash+xml") return "dash";
  if (lower.endsWith(".ism/manifest") || lower.endsWith(".ism/manifest(format=mpd-time-csf)")) return "dash";
  if (url.startsWith("blob:")) return "blob";
  // Raw stream fragments are never standalone videos — the cluster engine
  // owns them (they'd otherwise flood the popup, e.g. X's video/mp4 .m4s).
  if (looksLikeChunk(url)) return null;
  if (ct === "video/mp4") return "mp4";
  if (ct === "video/webm") return "webm";
  if (ct === "video/ogg") return "ogg";
  if (ct === "video/quicktime") return "mov";
  if (ct === "video/x-matroska") return "mkv";
  if (ct === "video/x-msvideo" || ct === "video/avi") return "avi";
  if (ct === "video/x-flv") return "flv";
  if (ct === "video/x-ms-wmv") return "wmv";
  if (ct === "video/mpeg" || ct === "video/mp2v") return "mpg";
  // NOTE: video/mp2t and octet-stream are segment/chunk types — never items.
  if (lower.endsWith(".mp4")) return "mp4";
  if (lower.endsWith(".m4v")) return "mp4";
  if (lower.endsWith(".webm")) return "webm";
  if (lower.endsWith(".ogv") || lower.endsWith(".ogg")) return "ogg";
  if (lower.endsWith(".mov")) return "mov";
  if (lower.endsWith(".mkv")) return "mkv";
  if (lower.endsWith(".avi")) return "avi";
  if (lower.endsWith(".flv") || lower.endsWith(".f4v")) return "flv";
  if (lower.endsWith(".wmv")) return "wmv";
  if (lower.endsWith(".mpg") || lower.endsWith(".mpeg") || lower.endsWith(".m2v")) return "mpg";
  if (lower.endsWith(".3gp") || lower.endsWith(".3g2")) return "mp4";
  return null;
}

/**
 * Conservative chunk detector for ITEM classification (not clustering).
 * Scores path signals; threshold 3 keeps real files safe:
 * - `/2024/01/clip.mp4` scores 2 (two digit tokens) -> kept as video
 * - `…/avc1/0/0/1440x1440/x.mp4` scores 6+ (codec+digits+dimensions) -> chunk
 * - any .ts/.m4s/.cmfv/.cmfa URL -> chunk regardless of content-type
 */
export function looksLikeChunk(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return false;
  }
  if (/\.(ts|m4s|cmfv|cmfa)$/.test(path)) return true;
  const tokens = path.split("/").filter(Boolean);
  let score = 0;
  let digitTokens = 0;
  for (let raw of tokens) {
    const t = raw.replace(/\.[a-z0-9]{2,5}$/, ""); // strip extension
    if (/^\d+$/.test(t)) {
      digitTokens++;
      continue;
    }
    if (/\d+x\d+/.test(t)) score += 2; // dimensions: 1440x1440, 900x720
    if (/^(avc1|mp4a|hev1|hvc1|vp09|av01|ec-3|ec3|ac-3|ac-4|opus)$/.test(t)) score += 2;
    if (/(seg|chunk|frag|part|range|seq|stream|media|track|video|audio)[-_./]?\d/i.test(t)) score += 2;
  }
  score += Math.min(2, digitTokens);
  if (score >= 3) return true;
  // .m4v is ambiguous (fMP4 chunk vs iTunes movie): chunk only with backup signal.
  if (/\.m4v$/.test(path) && score >= 2) return true;
  return false;
}

/**
 * Attach a title to an item. Element-level titles (found next to the player)
 * always beat page-level ones; the filename regenerates once, the first
 * time a real title lands on a fallback-named item (extension preserved).
 */
export function applyTitle(item: MediaItem, rawTitle: string | undefined, isElement: boolean): boolean {
  const title = cleanTitle(rawTitle ?? "");
  if (!title) return false;
  if (item.title) {
    if (!isElement || item.titleFromPage === false) return false;
  }
  item.title = title;
  item.titleFromPage = !isElement;
  if (item.autoNamed !== false && item.filename) {
    const m = /\.([a-z0-9]{2,5})$/i.exec(item.filename);
    const ext = m ? m[1].toLowerCase() : "mp4";
    const stem = sanitizeStem(title);
    if (stem) {
      item.filename = `${stem}.${ext}`;
      item.autoNamed = false;
    }
  }
  return true;
}

/** "1280×720 • 0:34 • playing" from a content-script signal. */
export function describeSignal(v: VideoSignal): string | undefined {  const parts: string[] = [];
  if (v.width && v.height) parts.push(`${v.width}×${v.height}`);
  if (v.duration != null && Number.isFinite(v.duration) && v.duration > 0) {
    const s = Math.floor(v.duration);
    parts.push(
      s >= 3600
        ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
        : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`,
    );
  }
  if (v.paused === false) parts.push("playing");
  return parts.length ? parts.join(" • ") : undefined;
}

function headerValue(
  headers: chrome.webRequest.HttpHeader[] | undefined,
  name: string,
): string {
  if (!headers) return "";
  const h = headers.find((x) => x.name.toLowerCase() === name);
  return h?.value ?? "";
}

/** Bound per-tab growth (infinite feeds) — drop oldest blob placeholders first. */
function enforceCaps(items: MediaItem[]): MediaItem[] {
  let out = items;
  const blobs = out.filter((x) => x.type === "blob");
  if (blobs.length > MAX_BLOB_PER_TAB) {
    const drop = new Set(blobs.slice(0, blobs.length - MAX_BLOB_PER_TAB).map((x) => x.url));
    out = out.filter((x) => !drop.has(x.url));
  }
  if (out.length > MAX_ITEMS_PER_TAB) {
    out = out.slice(out.length - MAX_ITEMS_PER_TAB);
  }
  return out;
}

async function upsertItem(tabId: number, item: MediaItem): Promise<void> {
  const items = await getTabItems(tabId);
  // Deduplicate by full URL — keep signed query params intact.
  if (items.some((x) => x.url === item.url)) return;
  items.push(item);
  await persistTab(tabId, enforceCaps(items));
  await updateBadge(tabId);
}

async function patchItem(
  tabId: number,
  url: string,
  patch: Partial<MediaItem>,
): Promise<void> {
  const items = await getTabItems(tabId);
  const idx = items.findIndex((x) => x.url === url);
  if (idx === -1) return;
  items[idx] = { ...items[idx], ...patch };
  await persistTab(tabId, items);
  await updateBadge(tabId);
}

const MAX_MANIFEST_BYTES = 5_000_000;

async function fetchManifestText(tabId: number, url: string): Promise<string> {
  const net = lookupNet(tabId, url);
  // First try from the worker (fast path, no tab involvement), replaying
  // the page's own auth/referrer context where captured.
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: net?.headers,
      referrer: net?.referrer,
      referrerPolicy: net?.referrer ? "unsafe-url" : undefined,
    });
    if (res.ok) return await res.text();
    if (res.status !== 401 && res.status !== 403) {
      throw new Error(`Manifest fetch failed (${res.status})`);
    }
    // 401/403: fall through to the page-context fetch below.
  } catch (err) {
    // Network-level failure from the worker context — page fetch may still work.
    if (err instanceof Error && err.message.startsWith("Manifest fetch failed")) throw err;
  }
  // Auth-walled manifests (logged-in sessions, HttpOnly cookies): refetch
  // from the tab's content script, which runs with the page's cookie jar.
  try {
    const res = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "FETCH_TEXT", url }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("page fetch timeout")), 15000),
      ),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = res as any;
    if (r?.ok && typeof r.text === "string") {
      if (r.truncated) {
        throw new Error("Manifest too large to parse (>5 MB).");
      }
      return r.text as string;
    }
    throw new Error(r?.error ?? "Page-context fetch failed.");
  } catch (err) {
    throw new Error(
      `Manifest unreachable (worker + page fetch failed): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function parseStreamingItem(tabId: number, item: MediaItem): Promise<void> {
  try {
    const text = await fetchManifestText(tabId, item.url);
    if (text.length > MAX_MANIFEST_BYTES) {
      throw new Error("Manifest too large to parse (>5 MB).");
    }
    if (item.type === "hls") {
      const parsed = parseHlsManifest(text, item.url);
      await patchItem(tabId, item.url, {
        variants: parsed.variants,
        drmProtected: parsed.drmProtected,
        drmReason: parsed.drmReason,
      });
    } else if (item.type === "dash") {
      const parsed = parseDashManifest(text, item.url);
      await patchItem(tabId, item.url, {
        variants: parsed.variants,
        drmProtected: parsed.drmProtected,
        drmReason: parsed.drmReason,
      });
    }
  } catch (err) {
    await patchItem(tabId, item.url, {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---- Segment-cluster engine (MSE/blob correlation) ----
// Blob: URLs are unreachable, but the chunk traffic feeding the player
// isn't. We track segment-like responses per tab, group them by masked URL
// pattern, and promote busy groups to downloadable "segments" items.
const MIN_CLUSTER_URLS = 4;
const MAX_CLUSTER_URLS = 800;
const MAX_CLUSTERS_PER_TAB = 12;

interface Cluster {
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

const clustersByTab = new Map<number, Cluster[]>();

function segPathExt(pathname: string): string | null {
  const m = /\.([a-z0-9]{2,5})$/.exec(pathname.toLowerCase());
  return m ? m[1] : null;
}

/** Cheap sequential-chunk heuristic for non-manifest responses. */
function looksSequential(url: string): boolean {
  const path = url.toLowerCase().split("?")[0];
  if (/(seg|chunk|part|frag|seq|slice|cam|stream)[-_./]?\d/i.test(path)) return true;
  if (/\d{2,}\.(ts|m4s|m4v|cmfv|cmfa|mp4)/i.test(path)) return true;
  if (/[?&](seg|seq|part|chunk|index|no|n|counter)=\d+/i.test(url.toLowerCase())) return true;
  return false;
}

function isSegmentCandidate(url: string, ct: string, status: number): boolean {
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
function clusterKey(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.origin} ${u.pathname.replace(/\d+/g, "#")}`;
  } catch {
    return null;
  }
}

function recordCandidate(
  tabId: number,
  frameId: number,
  url: string,
  contentType: string,
  statusCode: number,
  contentLength = 0,
): void {
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

function clusterBytesLabel(bytes: number): string {
  if (bytes <= 0) return "";
  if (bytes < 1_000_000) return `≈${Math.round(bytes / 1000)} KB`;
  return `≈${(bytes / 1_000_000).toFixed(1)} MB`;
}

async function maybePromoteCluster(tabId: number, cluster: Cluster): Promise<void> {
  if (cluster.urls.length < MIN_CLUSTER_URLS) return;
  // Throttle republishing: every +8 urls or 10s, whichever first.
  if (
    cluster.urls.length - cluster.lastPubCount < 8 &&
    Date.now() - cluster.lastPubTs < 10_000
  ) {
    return;
  }
  const items = await getTabItems(tabId);
  // A known item for the canonical URL already covers this stream.
  if (items.some((x) => x.url === cluster.urls[0])) return;
  const existing = items.find((x) => x.type === "segments" && x.url === cluster.urls[0]);
  const meta = `${cluster.urls.length} segments • auto-grouped from player traffic${cluster.bytes ? ` • ${clusterBytesLabel(cluster.bytes)}` : ""}`;
  if (existing) {
    existing.segments = [...cluster.urls];
    existing.meta = meta;
    await persistTab(tabId, items);
  } else {
    await upsertItem(tabId, {
      url: cluster.urls[0],
      tabId,
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
async function dropSupersededClusters(tabId: number, manifestUrl: string): Promise<void> {
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
function matchCluster(tabId: number, frameId: number | undefined): Cluster | undefined {
  const list = clustersByTab.get(tabId);
  if (!list?.length) return undefined;
  const now = Date.now();
  const recent = list.filter((c) => now - c.lastTs < 90_000);
  const sameFrame = frameId != null ? recent.filter((c) => c.frameId === frameId) : [];
  const pool = sameFrame.length ? sameFrame : recent;
  return pool.sort((a, b) => b.urls.length - a.urls.length)[0];
}

// ---- Request-header capture (auth replay for 403-prone fetches) ----
// Only replayable values are stored (Authorization + custom X-* headers and
// the page referrer). Cookies are NEVER stored — and couldn't be replayed
// via fetch() anyway. Memory-only (never persisted), per tab, FIFO-capped.
const HDR_MAX_PER_TAB = 300;

interface CapturedNet {
  origin: string;
  pattern: string;
  headers: Record<string, string>;
  referrer?: string;
}

const hdrStore = new Map<number, Map<string, CapturedNet>>();

function videoishForHeaders(url: string): boolean {
  if (classify(url, "") !== null) return true;
  const path = url.toLowerCase().split("?")[0];
  if (segPathExt(path) && ["ts", "m4s", "m4v", "cmfv", "cmfa"].includes(segPathExt(path)!)) return true;
  return looksSequential(url);
}

function onSendHeaders(details: chrome.webRequest.OnSendHeadersDetails): void {
  const { tabId, url } = details;
  if (tabId == null || tabId < 0) return;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return;
  if (!videoishForHeaders(url)) return;
  const headers: Record<string, string> = {};
  let referrer: string | undefined;
  for (const h of details.requestHeaders ?? []) {
    const name = h.name.toLowerCase();
    const value = (h.value ?? "").slice(0, 2048);
    if (!value) continue;
    if (name === "authorization") {
      headers["Authorization"] = value;
    } else if (name.startsWith("x-") && Object.keys(headers).length < 10) {
      headers[h.name] = value;
    } else if (name === "referer") {
      referrer = value;
    }
    // NOTE: cookie/set-cookie and everything else are deliberately skipped.
  }
  if (!Object.keys(headers).length && !referrer) return;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return;
  }
  let perTab = hdrStore.get(tabId);
  if (!perTab) {
    perTab = new Map();
    hdrStore.set(tabId, perTab);
  }
  perTab.set(url, { origin, pattern: clusterKey(url) ?? url, headers, referrer });
  while (perTab.size > HDR_MAX_PER_TAB) {
    const oldest = perTab.keys().next().value as string | undefined;
    if (!oldest) break;
    perTab.delete(oldest);
  }
}

/**
 * Replayable net context for a target URL. Auth/custom headers only cross
 * to the SAME origin they were captured from (no token leakage across
 * hosts); the page referrer may go anywhere (matches page behavior).
 */
function lookupNet(tabId: number, targetUrl: string): NetReplay | undefined {
  const perTab = hdrStore.get(tabId);
  if (!perTab?.size) return undefined;
  let targetOrigin: string;
  try {
    targetOrigin = new URL(targetUrl).origin;
  } catch {
    return undefined;
  }
  const exact = perTab.get(targetUrl);
  const candidates = exact ? [exact] : [...perTab.values()].reverse();
  for (const c of candidates) {
    const patternMatch = exact ? true : c.pattern === clusterKey(targetUrl);
    if (!patternMatch) continue;
    const out: NetReplay = {};
    if (c.origin === targetOrigin && Object.keys(c.headers).length) {
      out.headers = { ...c.headers };
    }
    if (c.referrer) out.referrer = c.referrer;
    if (out.headers || out.referrer) return out;
    if (exact) return undefined;
  }
  return undefined;
}

function onHeadersReceived(
  details: chrome.webRequest.OnHeadersReceivedDetails,
): chrome.webRequest.BlockingResponse | undefined {
  const { tabId, url } = details;
  if (tabId == null || tabId < 0) return undefined;
  if (!url.startsWith("http://") && !url.startsWith("https://")) return undefined;

  const ct = headerValue(details.responseHeaders, "content-type");
  // Always feed the segment-cluster engine (cheap prefilter inside) —
  // this is what catches MSE/blob players via their chunk traffic.
  const len = Number(headerValue(details.responseHeaders, "content-length") || "0");
  recordCandidate(tabId, details.frameId ?? 0, url, ct, details.statusCode, Number.isFinite(len) ? len : 0);

  const type = classify(url, ct);
  if (!type) return undefined;

  const item: MediaItem = {
    url, // keep full URL incl. auth/signed params
    tabId,
    type,
    filename: filenameForUrl(url, type),
    autoNamed: true,
    detectedAt: Date.now(),
    drmProtected: false,
    variants: type === "hls" || type === "dash" ? [] : undefined,
    error: type === "blob" ? "Blob/MSE stream — not directly downloadable." : undefined,
  };

  void (async () => {
    const existing = await getTabItems(tabId);
    if (existing.some((x) => x.url === url)) return;
    await upsertItem(tabId, item);
    if (type === "hls" || type === "dash") {
      // A parsed manifest replaces raw auto-groups from the same directory.
      await dropSupersededClusters(tabId, url);
      await parseStreamingItem(tabId, item);
    }
  })();
  return undefined;
}

// ---- startup ----
// PING listener registers FIRST, before anything else that could throw
// during startup on some Chromium variants. It answers synchronously with
// zero dependencies, so the popup can always tell "worker alive" apart
// from "worker stuck". (The main listener below handles every other type;
// it deliberately skips PING to avoid a double response.)
try {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((msg as any)?.type === "PING") {
      try {
        sendResponse({ pong: true });
      } catch {
        /* ignore */
      }
    }
    return false;
  });
} catch {
  /* prehistoric browser — the main listener below still tries */
}

// ---- wiring (each guarded: one blocked API must never kill the worker) ----
function safeWire(label: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.warn(`[vdg] listener '${label}' unavailable:`, err);
  }
}

safeWire("webRequest.send", () => {
  chrome.webRequest.onSendHeaders.addListener(onSendHeaders, { urls: ["http://*/*", "https://*/*"] }, [
    "requestHeaders",
  ]);
});

safeWire("webRequest", () => {
  chrome.webRequest.onHeadersReceived.addListener(
    onHeadersReceived,
    { urls: ["http://*/*", "https://*/*"] },
    ["responseHeaders"],
  );
});

// New page load = stale detections (traffic, headers, items).
safeWire("webNavigation.committed", () => {
  chrome.webNavigation.onCommitted.addListener(async (details) => {
    if (details.frameId !== 0) return;
    lastUrlByTab.set(details.tabId, details.url);
    clustersByTab.delete(details.tabId);
    hdrStore.delete(details.tabId);
    await persistTab(details.tabId, []);
    await updateBadge(details.tabId);
  });
});

// SPA navigation (X/Twitter feed -> tweet detail etc.): new URL = stale detections.
safeWire("webNavigation.history", () => {
  chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
    try {
      if (details.frameId !== 0) return;
      const prev = lastUrlByTab.get(details.tabId);
      if (prev && new URL(prev).pathname !== new URL(details.url).pathname) {
        await persistTab(details.tabId, []);
        await updateBadge(details.tabId);
      }
      lastUrlByTab.set(details.tabId, details.url);
    } catch {
      /* malformed URLs etc. must never break the worker */
    }
  });
});

safeWire("tabs", () => {
  chrome.tabs.onActivated.addListener((info) => {
    void updateBadge(info.tabId);
  });

  chrome.tabs.onUpdated.addListener((_tabId, info, tab) => {
    if (info.status === "complete" && tab.url && tab.id != null) {
      lastUrlByTab.set(tab.id, tab.url);
    }
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    memoryStore.delete(tabId);
    lastUrlByTab.delete(tabId);
    clustersByTab.delete(tabId);
    hdrStore.delete(tabId);
    try {
      const all = await readSessionKey<Record<string, MediaItem[]>>(SESSION_KEY, {});
      delete all[String(tabId)];
      await chrome.storage.session.set({ [SESSION_KEY]: all });
    } catch {
      /* ignore */
    }
  });
});

// Enrichment from content script: attach posters, surface blob: videos,
// and create items for direct URLs webRequest missed (e.g. cached media).
async function handleVideoSignals(
  tabId: number,
  videos: VideoSignal[],
  pageTitle?: string,
  frameId?: number,
): Promise<void> {
  const items = await getTabItems(tabId);
  let changed = false;
  const touch = (url: string, v: VideoSignal) => {
    const match = items.find(
      (x) => x.url === url || x.url.split("?")[0] === url.split("?")[0],
    );
    if (!match) return;
    if (v.poster && !match.poster) {
      match.poster = v.poster;
      changed = true;
    }
    const meta = describeSignal(v);
    if (meta && !match.meta) {
      match.meta = meta;
      changed = true;
    }
    if (applyTitle(match, v.title, true)) changed = true;
    else if (applyTitle(match, pageTitle, false)) changed = true;
  };

  for (const v of videos) {
    const meta = describeSignal(v);
    const candidates = [v.currentSrc, ...(v.candidates ?? [])].filter(Boolean);
    for (const src of candidates) {
      if (!src || src.startsWith("data:")) continue;
      if (src.startsWith("blob:")) {
        // If the player feeding this blob: URL has visible chunk traffic in
        // the same frame, link the poster/meta to the grouped item instead
        // of adding a dead placeholder row.
        const cluster = matchCluster(tabId, frameId);
        if (cluster) {
          const linked = items.find((x) => x.type === "segments" && x.url === cluster.urls[0]);
          if (linked) {
            if (v.poster && !linked.poster) {
              linked.poster = v.poster;
              changed = true;
            }
            const m = describeSignal(v);
            if (m && !linked.meta?.includes("×")) {
              linked.meta = `${linked.meta ?? ""} • ${m}`;
              changed = true;
            }
            if (applyTitle(linked, v.title, true)) changed = true;
            else if (applyTitle(linked, pageTitle, false)) changed = true;
            continue;
          }
        }
        const existing = items.find((x) => x.url === src);
        if (!existing) {
          const title = cleanTitle(v.title) || cleanTitle(pageTitle);
          items.push({
            url: src,
            tabId,
            type: "blob",
            filename: "",
            title: title || undefined,
            titleFromPage: title ? !cleanTitle(v.title) : undefined,
            detectedAt: Date.now(),
            drmProtected: false,
            poster: v.poster,
            pageTitle,
            meta,
            error: "Blob/MSE stream (in-player buffer) — the downloadable file is captured from the network when it loads. Try playing, then Rescan.",
          });
          changed = true;
        } else {
          if (v.poster && !existing.poster) {
            existing.poster = v.poster;
            changed = true;
          }
          if (meta && !existing.meta) {
            existing.meta = meta;
            changed = true;
          }
        }
        continue;
      }
      if (!src.startsWith("http://") && !src.startsWith("https://")) continue;
      const type = classify(src, "");
      if (type === "hls" || type === "dash") {
        if (!items.some((x) => x.url === src)) {
          const title = cleanTitle(v.title) || cleanTitle(pageTitle);
          const item: MediaItem = {
            url: src,
            tabId,
            type,
            filename: filenameForUrl(src, type, title || undefined),
            title: title || undefined,
            titleFromPage: title ? !cleanTitle(v.title) : undefined,
            autoNamed: !title,
            detectedAt: Date.now(),
            drmProtected: false,
            variants: [],
            poster: v.poster,
            pageTitle,
            meta,
          };
          items.push(item);
          changed = true;
          void parseStreamingItem(tabId, item);
        } else {
          touch(src, v);
        }
      } else if (type && DIRECT_TYPES.has(type)) {
        // Direct file the network listener missed (cached before install etc.)
        if (!items.some((x) => x.url === src || x.url.split("?")[0] === src.split("?")[0])) {
          const title = cleanTitle(v.title) || cleanTitle(pageTitle);
          items.push({
            url: src,
            tabId,
            type,
            filename: filenameForUrl(src, type, title || undefined),
            title: title || undefined,
            titleFromPage: title ? !cleanTitle(v.title) : undefined,
            autoNamed: !title,
            detectedAt: Date.now(),
            drmProtected: false,
            poster: v.poster,
            pageTitle,
            meta,
          });
          changed = true;
        } else {
          touch(src, v);
        }
      } else {
        touch(src, v);
      }
    }
  }
  if (changed) {
    await persistTab(tabId, enforceCaps(items));
    await updateBadge(tabId);
  }
}

function mbLabel(bytes: number): string {
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

// Last-seen timestamps for capture keys (prune player teardowns).
const captureSeen = new Map<string, number>();

/**
 * MSE capture sessions -> downloadable `capture` items (one per track).
 * Refusal rules (never bypassed):
 * - session.eme (setMediaKeys/encrypted on its element) -> DRM row, refused.
 * - session clean BUT page requested EME keys -> refused as unverified: on a
 *   mixed page we cannot prove this buffer isn't DRM-adjacent.
 * - clean session, clean page, bytes>0 -> downloadable capture item.
 */
async function handleCaptureSessions(
  tabId: number,
  sessions: MsSessionMeta[] | undefined,
  posterByBlob: Map<string, string>,
  titleByBlob: Map<string, string>,
  pageTitle?: string,
): Promise<void> {
  if (!sessions) return;
  const now = Date.now();
  const items = await getTabItems(tabId);
  let changed = false;

  for (const s of sessions) {
    if (!s || typeof s.id !== "string") continue;
    const keyBase = `capture:${s.id}:`;
    captureSeen.set(keyBase, now);
    const elTitle = s.blobUrl ? cleanTitle(titleByBlob.get(s.blobUrl)) : "";
    const pageFallback = cleanTitle(pageTitle);
    const title = elTitle || pageFallback;
    for (const t of s.tracks ?? []) {
      const url = `${keyBase}${t.idx}`;
      captureSeen.set(url, now);
      const kindLabel = t.kind === "video" ? "video" : t.kind === "audio" ? "audio" : "track";
      const sizeLabel = t.bytes > 0 ? ` • ${mbLabel(t.bytes)}` : "";
      const existing = items.find((x) => x.url === url);

      if (s.eme) {
        if (!existing) {
          items.push({
            url,
            tabId,
            type: "capture",
            captureRef: `${s.id}:${t.idx}`,
            captureKind: t.kind,
            filename: "",
            title: title || undefined,
            titleFromPage: title ? !elTitle : undefined,
            detectedAt: now,
            drmProtected: true,
            drmReason: "Protected content — this player uses an encrypted media path (DRM). Cannot download.",
            meta: `${kindLabel}${sizeLabel} • captured buffer`,
            pageTitle,
          });
          changed = true;
        }
        continue;
      }
      if (s.pageEme) {
        if (!existing) {
          items.push({
            url,
            tabId,
            type: "capture",
            captureRef: `${s.id}:${t.idx}`,
            captureKind: t.kind,
            filename: "",
            title: title || undefined,
            titleFromPage: title ? !elTitle : undefined,
            detectedAt: now,
            drmProtected: true,
            drmReason: "This page uses DRM playback, so buffered captures are disabled here to stay safe.",
            meta: `${kindLabel}${sizeLabel} • captured buffer`,
            pageTitle,
          });
          changed = true;
        }
        continue;
      }
      if (t.bytes <= 0) continue; // nothing captured yet — wait for buffer
      const meta = `${kindLabel}${sizeLabel} • captured buffer${s.complete === false ? " • partial" : ""}`;
      const poster = s.blobUrl ? posterByBlob.get(s.blobUrl) : undefined;
      if (!existing) {
        const ts = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
        items.push({
          url,
          tabId,
          type: "capture",
          captureRef: `${s.id}:${t.idx}`,
            captureKind: t.kind,
          filename: title ? `${sanitizeStem(title)}-${kindLabel}-${ts}.mp4` : `capture-${kindLabel}-${ts}.mp4`,
          title: title || undefined,
          titleFromPage: title ? !elTitle : undefined,
          autoNamed: !title,
          detectedAt: now,
          drmProtected: false,
          poster,
          pageTitle,
          meta,
        });
        changed = true;
      } else if (!existing.drmProtected) {
        if (existing.meta !== meta) {
          existing.meta = meta;
          changed = true;
        }
        if (poster && !existing.poster) {
          existing.poster = poster;
          changed = true;
        }
        if (applyTitle(existing, elTitle || undefined, true)) changed = true;
        else if (applyTitle(existing, pageFallback || undefined, false)) changed = true;
      }
    }
  }

  // Prune captures whose sessions vanished >120s ago (player teardown).
  const staleCutoff = now - 120_000;
  let pruned = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const x = items[i];
    if (x.type !== "capture") continue;
    const seen = captureSeen.get(x.url) ?? captureSeen.get(x.url.split(":").slice(0, 2).join(":") + ":") ?? 0;
    if (seen < staleCutoff) {
      items.splice(i, 1);
      captureSeen.delete(x.url);
      pruned = true;
    }
  }
  if (pruned) changed = true;

  if (changed) {
    await persistTab(tabId, enforceCaps(items));
    await updateBadge(tabId);
  }
}

// ---- Offscreen download orchestration (survives popup close) ----
// The offscreen document (runtime API only) assembles segment bytes;
// the worker performs the actual chrome.downloads.download(), which
// offscreen documents cannot call.
async function offscreenExists(): Promise<boolean> {
  try {
    // Preferred API (Chrome 116+).
    const rt = chrome.runtime as typeof chrome.runtime & {
      getContexts?: (filter: object) => Promise<Array<unknown>>;
    };
    if (typeof rt.getContexts === "function") {
      const contexts = await rt.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
      });
      return contexts.length > 0;
    }
    if (typeof chrome.offscreen?.hasDocument === "function") {
      return await chrome.offscreen.hasDocument();
    }
  } catch {
    /* fall through to create */
  }
  return false;
}

async function ensureOffscreen(): Promise<void> {
  if (await offscreenExists()) return;
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_URL),
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: "Fetch video segments and assemble the download file after the popup closes.",
    });
  } catch (err) {
    // Already-exists race between concurrent callers.
    if (!(err instanceof Error && /already exists|only one/i.test(err.message))) throw err;
  }
}

async function maybeCloseOffscreen(): Promise<void> {
  await ensureJobsLoaded();
  const running = [...jobMemory.values()].some((j) => j.status === "running");
  if (running) return;
  try {
    if (await offscreenExists()) {
      await chrome.offscreen.closeDocument();
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Peek at an HLS variant playlist to decide mux-vs-split: fMP4 (EXT-X-MAP
 * or .m4s/.mp4 segments) muxes into one file; TS stays two files.
 * Fail-closed to false (two files) on any fetch/parse problem.
 */
async function probeHlsFmp4(tabId: number, variantUrl: string): Promise<boolean> {
  try {
    const net = lookupNet(tabId, variantUrl);
    const res = await fetch(variantUrl, {
      credentials: "include",
      headers: net?.headers,
      referrer: net?.referrer,
      referrerPolicy: net?.referrer ? "unsafe-url" : undefined,
    });
    if (!res.ok) return false;
    const text = await res.text();
    if (/#EXT-X-MAP\s*:/i.test(text)) return true;
    const m = /^[^#\r\n]*\.(m4s|mp4|m4v|cmfv|cmfa)(\?[^#\r\n]*)?$/im.exec(text);
    if (m) return true;
    if (/^[^#\r\n]*\.ts(\?[^#\r\n]*)?$/im.test(text)) return false;
    return false;
  } catch {
    return false;
  }
}

/** Segment lists starting with init-style fMP4 chunks. */
function looksFmp4Segments(segments: string[]): boolean {
  const first = segments.find((s) => /\.(m4s|mp4|m4v|cmfv|cmfa)(\?|#|$)/i.test(s.split("?")[0]));
  if (first) return true;
  return !segments.some((s) => /\.ts(\?|#|$)/i.test(s.split("?")[0]));
}

async function startDownload(
  tabId: number,
  itemUrl: string,
  variantId?: string,
): Promise<{ job: DownloadJobState; paired: boolean; merged: boolean }> {
  const items = await getTabItems(tabId);
  const item = items.find((x) => x.url === itemUrl);
  if (!item) throw new Error("Video no longer listed for this tab. Rescan and try again.");
  if (item.drmProtected) throw new Error(item.drmReason ?? "Protected content — cannot download.");
  if (item.type === "blob") throw new Error("Blob/MSE stream — not directly downloadable.");

  // MSE capture downloads route through the tab's content script, which
  // pulls bytes from the page hook and streams them to the offscreen
  // document (existing DOWNLOAD_BLOB finalization). A video track pairs
  // with its session's audio track into ONE merged file.
  if (item.type === "capture") {
    if (!item.captureRef) throw new Error("Capture reference lost — Rescan while the video plays.");
    const [captureId, trackIdxRaw] = item.captureRef.split(":");
    const trackIdx = Number(trackIdxRaw) || 0;
    let pairTrackIdx: number | undefined;
    let filename = item.filename || `capture-${newJobId()}.mp4`;
    if (item.captureKind === "video") {
      const sessionPrefix = `capture:${captureId}:`;
      const sibling = items.find(
        (x) =>
          x.type === "capture" &&
          !x.drmProtected &&
          x.url !== itemUrl &&
          x.url.startsWith(sessionPrefix) &&
          x.captureKind === "audio",
      );
      if (sibling?.captureRef) {
        const parts = sibling.captureRef.split(":");
        pairTrackIdx = Number(parts[1]) || 0;
        // Single merged output (no -video/-audio split).
        filename = filename.replace(/-(video|audio)(?=\.[a-z0-9]+$)/i, "");
        if (!/\.[a-z0-9]+$/i.test(filename)) filename += ".mp4";
      }
    }
    const jobId = newJobId();
    const job: DownloadJobState = {
      jobId,
      tabId,
      itemUrl,
      filename,
      status: "running",
      done: 0,
      total: 0,
      stage: "fetching",
      updatedAt: Date.now(),
    };
    await upsertJob(job);
    await ensureOffscreen();
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "MS_DOWNLOAD",
        jobId,
        captureId,
        trackIdx,
        pairTrackIdx,
        filename: job.filename,
      });
    } catch (err) {
      job.status = "error";
      job.error = `Could not reach the page capture: ${err instanceof Error ? err.message : String(err)} Reload the tab and retry.`;
      await upsertJob(job);
    }
    return { job, paired: pairTrackIdx !== undefined, merged: pairTrackIdx !== undefined };
  }

  const jobId = newJobId();
  // Per-origin replay scopes for every host this job will touch (cap 10).
  const scopeUrls: string[] = [];
  const seenOrigins = new Set<string>();
  const consider = (u: string | undefined) => {
    if (!u || seenOrigins.size >= 10) return;
    try {
      const o = new URL(u).origin;
      if (!seenOrigins.has(o)) {
        seenOrigins.add(o);
        scopeUrls.push(u);
      }
    } catch {
      /* ignore */
    }
  };
  let req: DownloadJobRequest;
  // Paired audio sibling for split A/V masters (e.g. X: video-only avc1
  // playlist + audio-only mp4a playlist). fMP4 pairs mux into ONE file;
  // anything else falls back to two files (today's pairReq path).
  let pairReq: DownloadJobRequest | null = null;
  if (item.type === "hls" || item.type === "dash") {
    const variant = item.variants?.find((v) => v.id === (variantId ?? item.variants?.[0]?.id)) ?? item.variants?.[0];
    if (!variant) throw new Error(item.error ?? "Manifest not parsed yet — reopen the popup in a moment and retry.");
    if (item.type === "hls") {
      consider(variant.url);
      req = { jobId, tabId, kind: "hls", url: variant.url, filename: item.filename, mime: "video/mp2t" };
      const cc = codecsOf(variant);
      if (hasVideoCodec(cc) && !hasAudioCodec(cc) && item.variants) {
        const audio = item.variants.find((v) => {
          const c = codecsOf(v);
          return hasAudioCodec(c) && !hasVideoCodec(c);
        });
        if (audio) {
          consider(audio.url);
          const stem = req.filename.replace(/\.[a-z0-9]+$/i, "");
          if (await probeHlsFmp4(tabId, variant.url)) {
            // Mux path: single merged .mp4 (offscreen fetches both playlists).
            req.pairUrl = audio.url;
            req.filename = `${stem}.mp4`;
          } else {
            // Non-fMP4 pair (e.g. TS): two files, as before.
            req.filename = `${stem}-video.ts`;
            pairReq = {
              jobId: newJobId(),
              tabId,
              kind: "hls",
              url: audio.url,
              filename: `${stem}-audio.m4a`,
              mime: "video/mp4",
            };
          }
        }
      }
    } else {
      if (!variant.segments?.length) throw new Error("No segments listed for this DASH variant.");
      consider(item.url);
      for (const s of variant.segments) consider(s);
      req = { jobId, tabId, kind: "dash", url: item.url, segments: variant.segments, filename: item.filename, mime: "video/mp4" };
      const cc = codecsOf(variant);
      if (hasVideoCodec(cc) && !hasAudioCodec(cc) && item.variants) {
        const audio = item.variants.find((v) => {
          const c = codecsOf(v);
          return hasAudioCodec(c) && !hasVideoCodec(c) && (v.segments?.length ?? 0) > 0;
        });
        if (audio?.segments?.length) {
          for (const s of audio.segments) consider(s);
          const stem = req.filename.replace(/\.[a-z0-9]+$/i, "");
          if (looksFmp4Segments(variant.segments) && looksFmp4Segments(audio.segments)) {
            req.pairSegments = [...audio.segments];
            req.filename = `${stem}.mp4`;
          } else {
            req.filename = `${stem}-video.mp4`;
            pairReq = {
              jobId: newJobId(),
              tabId,
              kind: "dash",
              url: item.url,
              segments: [...audio.segments],
              filename: `${stem}-audio.m4a`,
              mime: "video/mp4",
            };
          }
        }
      }
    }
  } else if (item.type === "segments") {
    // Auto-grouped chunk traffic: same byte-concat path as DASH, container
    // sniffed at assembly time. No manifest, no DRM signals by construction
    // (encrypted chunks would fail closed at fetch/parse with a clear error).
    if (!item.segments?.length) throw new Error("No grouped segments for this video (group expired — Rescan while it plays).");
    consider(item.url);
    for (const s of item.segments) consider(s);
    req = { jobId, tabId, kind: "dash", url: item.url, segments: [...item.segments], filename: item.filename, mime: "video/mp4" };
  } else {
    req = { jobId, tabId, kind: "direct", url: item.url, filename: item.filename };
  }
  // Attach per-origin replay contexts (auth scoped to capture origin).
  if (req.kind !== "direct") {
    const byOrigin: Record<string, NetReplay> = {};
    for (const u of scopeUrls) {
      const net = lookupNet(tabId, u);
      if (net) {
        try {
          byOrigin[new URL(u).origin] = net;
        } catch {
          /* ignore */
        }
      }
    }
    if (Object.keys(byOrigin).length) {
      req.netScope = { byOrigin };
      if (pairReq) pairReq.netScope = { byOrigin };
    }
  }

  const job: DownloadJobState = {
    jobId,
    tabId,
    itemUrl,
    variantId: variantId ?? (req.kind === "direct" ? undefined : item.variants?.[0]?.id),
    filename: req.filename,
    status: "running",
    done: 0,
    total: req.kind === "direct" ? 1 : (req.segments?.length ?? 0),
    updatedAt: Date.now(),
  };
  await upsertJob(job);

  if (req.kind === "direct") {
    // Browser handles natively — no offscreen needed, popup may close safely.
    try {
      await downloadDirect(req.url, req.filename);
      job.status = "done";
      job.done = 1;
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : String(err);
    }
    await upsertJob(job);
    return { job, paired: false, merged: false };
  }

  await ensureOffscreen();
  await dispatchOffscreen(req, job);
  let paired = false;
  const merged = !pairReq && (!!req.pairUrl || !!req.pairSegments);
  if (pairReq) {
    const pairJob: DownloadJobState = {
      jobId: pairReq.jobId,
      tabId,
      itemUrl,
      variantId: undefined,
      filename: pairReq.filename,
      status: "running",
      done: 0,
      total: 0,
      stage: "fetching",
      updatedAt: Date.now(),
    };
    await upsertJob(pairJob);
    await dispatchOffscreen(pairReq, pairJob);
    paired = true;
  }
  return { job, paired: paired || merged, merged };
}

/** Deliver one assembled download to the offscreen document (with retries). */
async function dispatchOffscreen(req: DownloadJobRequest, job: DownloadJobState): Promise<void> {
  // Deliver to the offscreen document (content scripts ignore this type).
  // Retry briefly — the document may still be initializing its listener.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      await chrome.runtime.sendMessage({ type: "OFFSCREEN_DOWNLOAD", job: req });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (lastErr) {
    job.status = "error";
    job.error = "Background downloader unreachable. Reload the extension and retry.";
    await upsertJob(job);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // NOTE: PING is handled by the early listener at the top of this file
  // (kept out of here to avoid a double sendResponse).
  void (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const m = msg as any;
      if (m?.type === "GET_MEDIA" && typeof m.tabId === "number") {
        // Fast path first: memory answers instantly; session read is
        // internally timeout-guarded and can never hang this response.
        const mem = memoryStore.get(m.tabId);
        sendResponse({ items: mem ?? (await getTabItems(m.tabId)) });
      } else if (m?.type === "GET_JOBS" && typeof m.tabId === "number") {
        sendResponse({ jobs: await getTabJobs(m.tabId) });
      } else if (m?.type === "CANCEL_JOB" && typeof m.jobId === "string") {
        await ensureJobsLoaded();
        const job = jobMemory.get(m.jobId);
        if (job && job.status === "running") {
          // Ask the offscreen document to abort; it reports back via
          // DOWNLOAD_ERROR("Download cancelled.") which finalizes the job.
          try {
            await chrome.runtime.sendMessage({ type: "OFFSCREEN_CANCEL", jobId: m.jobId });
          } catch {
            job.status = "error";
            job.error = "Download cancelled.";
            await upsertJob(job);
          }
          // Capture jobs also stream from the tab — stop the driver too.
          if (job.itemUrl.startsWith("capture:")) {
            try {
              await chrome.tabs.sendMessage(job.tabId, { type: "MS_CANCEL", jobId: m.jobId });
            } catch {
              /* driver ends on its own via abort flag or completion */
            }
          }
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "Job is not running." });
        }
      } else if (m?.type === "START_DOWNLOAD" && typeof m.tabId === "number" && typeof m.itemUrl === "string") {
        try {
          const { job, paired, merged } = await startDownload(m.tabId, m.itemUrl, m.variantId);
          sendResponse({ ok: true, job, paired, merged });
        } catch (err) {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        }
      } else if (m?.type === "VIDEO_ELEMENTS" && typeof m.tabId === "number") {
        const fromSender = sender.tab?.id ?? m.tabId;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const vids = (m.videos ?? []) as any[];
        await handleVideoSignals(fromSender, vids, m.pageTitle, sender.frameId);
        // Posters/titles keyed by blob: URL for capture-session rows.
        const posterByBlob = new Map<string, string>();
        const titleByBlob = new Map<string, string>();
        for (const v of vids) {
          if (typeof v?.currentSrc === "string" && v.currentSrc.startsWith("blob:")) {
            if (typeof v?.poster === "string") posterByBlob.set(v.currentSrc, v.poster);
            const vt = cleanTitle(typeof v?.title === "string" ? v.title : "");
            if (vt) titleByBlob.set(v.currentSrc, vt);
          }
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await handleCaptureSessions(fromSender, m.msSessions as any, posterByBlob, titleByBlob, m.pageTitle);
        sendResponse({ ok: true });
      } else if (m?.type === "MANIFEST_META" && Array.isArray(m.pairs)) {
        // Poster URLs seen next to a manifest URL in the same API response.
        const fromTab = sender.tab?.id ?? (typeof m.tabId === "number" ? m.tabId : -1);
        if (fromTab >= 0) {
          const items = await getTabItems(fromTab);
          let changed = false;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          for (const p of m.pairs as any[]) {
            if (typeof p?.manifest !== "string" || !Array.isArray(p?.thumbs) || !p.thumbs.length) continue;
            const item = items.find((x) => x.url === p.manifest && !x.poster);
            const thumb = (p.thumbs as unknown[]).find((t): t is string => typeof t === "string");
            if (item && thumb) {
              item.poster = thumb;
              changed = true;
            }
          }
          if (changed) await persistTab(fromTab, items);
        }
        sendResponse({ ok: true });
      } else if (m?.type === "DOWNLOAD_PROGRESS" && typeof m.jobId === "string") {
        await ensureJobsLoaded();
        const job = jobMemory.get(m.jobId);
        if (job) {
          job.done = m.done ?? job.done;
          job.total = m.total ?? job.total;
          await upsertJob(job, false);
        }
        sendResponse({ ok: true });
      } else if (m?.type === "JOB_STAGE" && typeof m.jobId === "string") {
        await ensureJobsLoaded();
        const job = jobMemory.get(m.jobId);
        if (job && (m.stage === "fetching" || m.stage === "assembling" || m.stage === "saving")) {
          job.stage = m.stage;
          await upsertJob(job, false);
        }
        sendResponse({ ok: true });
      } else if (
        (m?.type === "MS_TRACK_START" || m?.type === "MS_TRACK_CHUNK" || m?.type === "MS_TRACK_END") &&
        typeof m.jobId === "string"
      ) {
        // Capture-transfer traffic is addressed to the offscreen document
        // (which acks it); the worker only notes the total for progress.
        if (m.type === "MS_TRACK_START" && typeof m.total === "number") {
          await ensureJobsLoaded();
          const job = jobMemory.get(m.jobId);
          if (job && job.status === "running") {
            job.total = m.total;
            job.stage = "fetching";
            await upsertJob(job, false);
          }
        }
        sendResponse({ ok: true });
      } else if (m?.type === "DOWNLOAD_BLOB" && typeof m.jobId === "string") {
        // Final handoff: the worker (full API access) saves the file the
        // offscreen document assembled. data: URLs work with downloads.
        await ensureJobsLoaded();
        const job = jobMemory.get(m.jobId);
        if (job) {
          if (typeof m.dataUrl !== "string" || !m.dataUrl.startsWith("data:")) {
            job.status = "error";
            job.error = "Background worker received a corrupt file payload.";
          } else {
            try {
              const downloadId = await chrome.downloads.download({
                url: m.dataUrl,
                filename: typeof m.filename === "string" && m.filename ? m.filename : job.filename,
                saveAs: false,
              });
              job.status = "done";
              job.downloadId = downloadId;
              job.done = job.total || job.done;
            } catch (err) {
              job.status = "error";
              job.error = err instanceof Error ? err.message : String(err);
            }
          }
          await upsertJob(job);
        }
        void maybeCloseOffscreen();
        sendResponse({ ok: true });
      } else if (m?.type === "DOWNLOAD_ERROR" && typeof m.jobId === "string") {
        await ensureJobsLoaded();
        const job = jobMemory.get(m.jobId);
        if (job) {
          job.status = "error";
          job.error = m.error ?? "Download failed.";
          await upsertJob(job);
        }
        void maybeCloseOffscreen();
        sendResponse({ ok: true });
      } else if (m?.type === "RESCAN" && typeof m.tabId === "number") {
        // Ask the content script to re-collect <video> elements (covers
        // cached pages where webRequest saw nothing new).
        try {
          await chrome.tabs.sendMessage(m.tabId, { type: "COLLECT_NOW" });
        } catch {
          // Content script not injected: inject a one-shot collector.
          try {
            await chrome.scripting.executeScript({
              target: { tabId: m.tabId },
              func: () => {
                const pick = (el: HTMLVideoElement): string[] => {
                  const out: string[] = [];
                  if (el.currentSrc) out.push(el.currentSrc);
                  const s = el.getAttribute("src");
                  if (s) {
                    try {
                      out.push(new URL(s, location.href).toString());
                    } catch {
                      /* ignore */
                    }
                  }
                  el.querySelectorAll("source[src]").forEach((n) => {
                    const v = n.getAttribute("src");
                    if (v) {
                      try {
                        out.push(new URL(v, location.href).toString());
                      } catch {
                        /* ignore */
                      }
                    }
                  });
                  return out;
                };
                const vids = Array.from(document.querySelectorAll("video")).flatMap((v) => {
                  const c = pick(v as HTMLVideoElement);
                  return c.length
                    ? [{ currentSrc: c[0], candidates: c, poster: (v as HTMLVideoElement).poster || undefined }]
                    : [];
                });
                chrome.runtime.sendMessage({
                  type: "VIDEO_ELEMENTS",
                  tabId: -1, // background resolves via sender.tab
                  videos: vids,
                  pageTitle: document.title,
                });
              },
            });
          } catch (err) {
            sendResponse({
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
            return;
          }
        }
        sendResponse({ ok: true });
      } else if (m?.type === "JOB_UPDATED" || m?.type === "OFFSCREEN_DOWNLOAD" || m?.type === "OFFSCREEN_CANCEL") {
        // Broadcast/offscreen traffic not addressed to the worker — ignore.
        sendResponse({ ok: true });
      } else {
        sendResponse({ ok: false, error: "Unknown message" });
      }
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  })();
  return true; // async response
});

// Initialize badge on SW startup (never allowed to break startup).
try {
  void updateBadgeForActiveTab();
} catch {
  /* ignore */
}
