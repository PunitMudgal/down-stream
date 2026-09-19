import { extractHlsSegments } from "./parseHls";
import { cleanTitle, sanitizeStem } from "./text";
import type { MediaItem, NetReplay } from "./types";

// Re-exported for existing callers (the helpers live in ./text so UI code can
// use them without pulling the segment downloader into its bundle).
export { cleanTitle, sanitizeStem } from "./text";

export type ProgressCallback = (done: number, total: number, bytesDone?: number) => void;

export interface FetchSegmentsOptions {
  /** When true, workers wait instead of picking new segments (pause without abort). */
  isPaused?: () => boolean;
  /** Pre-filled parts to resume from (holes are undefined). Length must match urls. */
  existingParts?: Array<ArrayBuffer | undefined>;
  /** Called with each segment as it completes (persistence hook; best-effort). */
  onSegmentDone?: (index: number, buf: ArrayBuffer) => void;
  /**
   * Last-resort transport for a segment this document is not allowed to
   * fetch: the same URL, issued by the page's own JS world (its cookies,
   * Referer, Origin, `Sec-Fetch-*` and network fingerprint) and handed back
   * as bytes. Only used after the direct fetch is refused — see
   * `isGateFailure`. Supplied by the offscreen document.
   */
  relay?: SegmentRelayFn;
}

/** Fetch one URL with the page's own request context (see FetchSegmentsOptions). */
export type SegmentRelayFn = (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;

/** Marks a failure as "the CDN refused this request outright". */
interface GateMark {
  gated?: boolean;
}

function markGated(err: Error): Error {
  (err as Error & GateMark).gated = true;
  return err;
}

/**
 * True when a failure looks like the request itself was rejected (4xx, an
 * error page served as video, or a CORS/transport refusal) rather than the
 * connection being flaky — i.e. a request the page might be allowed to make.
 * Transient 5xx/timeouts are deliberately excluded: those are not about who is
 * asking, and relaying them would just burn the page's bandwidth.
 */
export function isGateFailure(err: unknown): boolean {
  if (err instanceof TypeError) return true; // fetch() network/CORS refusal
  if (!(err instanceof Error)) return false;
  if ((err as Error & GateMark).gated === true) return true;
  // "(404)"; 5xx and timeouts are deliberately not relayable.
  return /unavailable \(40|error page instead of video|failed \(4\d\d\)/i.test(err.message);
}

/** True when a fetch failure looks like expired signed URLs / blocked chunk. */
export function isExpiredFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /unavailable \(40|error page instead of video|isn't video data/i.test(err.message);
}

export function sanitizeFilename(name: string, fallback: string): string {
  const cleaned = name
    .split("?")[0]
    .split("#")[0]
    .split("/")
    .pop()
    ?.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
    .trim();
  if (!cleaned) return fallback;
  return cleaned.slice(0, 180);
}

/**
 * Pick the variant id a connection measured at `measuredBps` (bytes/sec)
 * handles comfortably, or undefined when a recommendation can't be made.
 *
 * Rule: recommend the highest-bandwidth variant whose declared bitrate fits
 * inside the share of measured throughput we're willing to use. `utilization`
 * defaults to 0.7 — the rest absorbs page traffic and protocol overhead, so a
 * download doesn't saturate the user's link. Pure: the caller measures, this
 * decides.
 */
export function recommendVariant<T extends { id: string; bandwidth?: number; codecs?: string }>(
  variants: T[],
  measuredBps: number,
  utilization = 0.7,
): string | undefined {
  if (!Number.isFinite(measuredBps) || measuredBps <= 0) return undefined;
  const budget = measuredBps * 8 * Math.min(1, Math.max(0, utilization)); // bytes/s -> bits/s
  const rated = variants.filter((v) => typeof v.bandwidth === "number" && (v.bandwidth as number) > 0);
  if (rated.length < 2) return undefined; // nothing to choose between
  // Highest bitrate that fits; if none fit, the lowest (best we can do).
  const sorted = [...rated].sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0));
  const fit = sorted.find((v) => (v.bandwidth as number) <= budget);
  return (fit ?? sorted[sorted.length - 1]).id;
}

export function defaultExtForType(type: string): string {
  const t = type.toLowerCase();
  if (t === "hls") return "ts";
  if (t === "webm") return "webm";
  if (t === "ogg") return "ogg";
  if (t === "mov") return "mov";
  if (t === "mkv") return "mkv";
  if (t === "avi") return "avi";
  if (t === "flv") return "flv";
  if (t === "wmv") return "wmv";
  if (t === "mpg") return "mpg";
  return "mp4";
}

function videoExtFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split("/").pop() || "";
    const m = /\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi|flv|f4v|wmv|mpg|mpeg|3gp|3g2)$/i.exec(last);
    if (!m) return "";
    const ext = m[1].toLowerCase();
    if (ext === "m4v" || ext === "3gp" || ext === "3g2" || ext === "mpeg" || ext === "ogv" || ext === "f4v") return "mp4";
    return ext;
  } catch {
    return "";
  }
}

export function filenameForUrl(url: string, type: string, title?: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const stem = title ? sanitizeStem(cleanTitle(title)) : "";
  const ext = videoExtFromUrl(url) || defaultExtForType(type);
  // A real title always wins (extension preserved from URL or type default).
  if (stem) return `${stem}.${ext}`;
  if (type === "hls") return `hls-video-${ts}.ts`;
  if (type === "dash") return `dash-video-${ts}.mp4`;
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").pop() || "";
    if (/\.(mp4|m4v|webm|ogv|ogg|mov|mkv|avi|flv|f4v|wmv|mpg|mpeg|3gp|3g2)$/i.test(last)) {
      return sanitizeFilename(last, `video-${ts}.mp4`);
    }
  } catch {
    /* fall through */
  }
  if (type === "segments") return `video-segments-${ts}.mp4`;
  return `video-${ts}.${ext}`;
}

/**
 * Link target for a blob-playing <video>'s poster/title: the newest
 * non-DRM HLS/DASH row (MSE players expose only a blob: URL, so page
 * metadata would otherwise never reach the downloadable row).
 */
export function pickManifestForBlob(items: MediaItem[]): MediaItem | undefined {
  let best: MediaItem | undefined;
  for (const x of items) {
    if (x.type !== "hls" && x.type !== "dash") continue;
    if (x.drmProtected) continue;
    if (!best || x.detectedAt > best.detectedAt) best = x;
  }
  return best;
}

/** Direct file: browser handles it natively (fallback when in-app fetch can't).
 *  Returns the chrome.downloads id so callers can reveal it in the folder. */
export async function downloadDirect(url: string, filename: string): Promise<number> {
  return chrome.downloads.download({ url, filename, saveAs: false });
}

/** Byte progress for single-stream direct downloads (received, total|0). */
export type ByteProgressCallback = (received: number, total: number) => void;

/**
 * Fetch a direct file URL with the page's own auth context (cookies +
 * captured same-origin Authorization/X-* headers + referrer). Script
 * endpoints like `remote_control.php` gate on exactly this: a bare browser
 * download misses it and the server answers with a 100–300 KB stub or an
 * HTML "no hotlinking" page instead of the video.
 *
 * Validates the payload (error pages refused, never saved) and reports byte
 * progress. Throws expired-session errors for 403/404/410 so the UI can
 * offer Refresh & Retry. Files over MAX_BYTES get `fallbackDirect` set so
 * the caller can hand oversized files to the browser instead of failing.
 */
export async function fetchDirectBlob(
  url: string,
  onProgress?: ByteProgressCallback,
  signal?: AbortSignal,
  scope?: { byOrigin: Record<string, NetReplay> },
): Promise<Blob> {
  throwIfAborted(signal);
  // Idle timeout, not a total cap: each received chunk resets the clock, so
  // slow-but-moving downloads survive while stalled ones fail fast.
  const ctrl = new AbortController();
  const onOuterAbort = (): void => ctrl.abort();
  if (signal) {
    if (signal.aborted) throw new Error("Download cancelled.");
    signal.addEventListener("abort", onOuterAbort, { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => ctrl.abort(), SEGMENT_TIMEOUT_MS);
  };
  const disarm = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  try {
    arm();
    const res = await fetch(url, netInit(pickNet(scope, url), ctrl.signal));
    if (res.status === 403 || res.status === 404 || res.status === 410) {
      throw new Error(
        `Stream file unavailable (${res.status}) — the link likely expired. Replay the video, hit Rescan, and retry right away.`,
      );
    }
    if (!res.ok) throw new Error(`File fetch failed (${res.status}): ${url}`);
    const contentType = res.headers.get("content-type");
    const len = Number(res.headers.get("content-length") || "0");
    const total = Number.isFinite(len) && len > 0 ? len : 0;
    // Stream the body: byte progress, in-app cap enforced while reading,
    // idle timer reset per chunk.
    const chunks: Uint8Array[] = [];
    let received = 0;
    const body = res.body;
    if (!body) throw new Error(`File fetch failed (empty response): ${url}`);
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm(); // progress resets the idle clock
        if (value && value.byteLength > 0) {
          chunks.push(value);
          received += value.byteLength;
          if (received > MAX_BYTES) {
            const err = new Error("Video exceeds the 1.5 GB in-app cap — retrying via the browser.");
            (err as unknown as Record<string, unknown>).fallbackDirect = true;
            throw err;
          }
          onProgress?.(received, total);
        }
        if (signal?.aborted) throw new Error("Download cancelled.");
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
    const buf = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) {
      buf.set(c, off);
      off += c.byteLength;
    }
    const ab = buf.buffer as ArrayBuffer;
    // Refuse stubs baked in as "video": hotlink gates answer 200 with an
    // HTML/JSON error body. (No valid video container starts with `<`.)
    rejectErrorPage(contentType, ab);
    const ct = (contentType ?? "").toLowerCase().split(";")[0].trim();
    const videoish =
      ct.startsWith("video/") ||
      ct.startsWith("audio/") ||
      ct === "application/octet-stream" ||
      ct === "binary/octet-stream" ||
      ct === "";
    if (!videoish) {
      throw new Error(
        "A stream file came back as an error page instead of video (link expired or request blocked). Replay the video, hit Rescan, and retry right away.",
      );
    }
    if (ab.byteLength === 0) throw new Error("Server returned an empty file — replay the video, Rescan, and retry.");
    onProgress?.(ab.byteLength, total);
    return new Blob([ab], { type: ct || "video/mp4" });
  } catch (err) {
    if (signal?.aborted) throw new Error("Download cancelled.");
    if (err instanceof DOMException && err.name === "AbortError" && !signal?.aborted) {
      throw new Error(`File fetch stalled for ${SEGMENT_TIMEOUT_MS / 1000}s with no data: ${url}`);
    }
    throw err;
  } finally {
    disarm();
    signal?.removeEventListener("abort", onOuterAbort);
  }
}

export const MAX_SEGMENTS = 2000;
export const MAX_BYTES = 1_500_000_000; // 1.5 GB safety cap

/**
 * Thrown when fetched bytes exceed MAX_BYTES. Carries the buffers fetched
 * so far as `partials` (holes are undefined) so callers can keep them and
 * resume the remainder instead of starting over.
 */
export class CapExceededError extends Error {
  partials?: Array<ArrayBuffer | undefined>;
  constructor(message = "Video exceeds the 1.5 GB safety cap — download stopped.") {
    super(message);
    this.name = "CapExceededError";
  }
}

/** True when a failure is the in-app safety-cap halt (not a network error). */
export function isCapExceeded(err: unknown): boolean {
  if (err instanceof CapExceededError) return true;
  return err instanceof Error && /safety cap — download stopped/i.test(err.message);
}

/** Partial buffers attached to a fetch failure (holes are undefined). */
export function capPartials(err: unknown): Array<ArrayBuffer | undefined> | undefined {
  const p = (err as unknown as Record<string, unknown> | null)?.partials;
  return Array.isArray(p) ? (p as Array<ArrayBuffer | undefined>) : undefined;
}

/** `movie.mp4` + part 2 → `movie.part2.mp4` (extension always supplied). */
export function partFilename(filename: string, partNo: number, ext: string): string {
  const stem = filename.replace(/\.[a-z0-9]+$/i, "") || filename;
  const suffix = ext.startsWith(".") ? ext : `.${ext}`;
  return `${stem}.part${partNo}${suffix}`;
}
// 8 parallel segment fetches: saturates HTTP/2 CDNs without tripping the
// ~6-connection HTTP/1.1 per-host limit too badly (extras queue in browser).
// Higher values trigger CDN rate-limiting faster; lower values cap throughput.
const FETCH_CONCURRENCY = 8;
const FETCH_RETRIES = 3;
/** Per-segment attempt timeout — a stalled fetch must not pin a pool slot forever. */
const SEGMENT_TIMEOUT_MS = 30_000;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Download cancelled.");
}

function netInit(net: NetReplay | undefined, signal?: AbortSignal): RequestInit {
  return {
    credentials: "include",
    signal,
    headers: net?.headers,
    referrer: net?.referrer,
    referrerPolicy: net?.referrer ? "unsafe-url" : undefined,
  };
}

/**
 * Measure this connection's throughput using the first few segments of a
 * stream. Used to recommend a quality the connection can actually sustain.
 *
 * Bytes are downloaded and discarded — never saved — and the fetch is
 * cancelled as soon as the sample budget is reached, so the cost is a few
 * hundred KB and a second or two. Returns bytes/second, or undefined when
 * nothing could be measured (caller simply shows no recommendation).
 */
export async function probeSpeed(
  urls: string[],
  opts?: {
    signal?: AbortSignal;
    scope?: { byOrigin: Record<string, NetReplay> };
    /** How many segments to sample (default 3). */
    sampleCount?: number;
    /** Stop once this many bytes have been seen (default 3 MB). */
    maxBytes?: number;
  },
): Promise<number | undefined> {
  const sample = urls.slice(0, Math.max(1, opts?.sampleCount ?? 3));
  if (sample.length === 0) return undefined;
  const maxBytes = opts?.maxBytes ?? 3_000_000;
  const started = Date.now();
  let bytes = 0;
  for (const url of sample) {
    if (opts?.signal?.aborted) break;
    if (bytes >= maxBytes) break;
    const ctrl = new AbortController();
    const onAbort = (): void => ctrl.abort();
    opts?.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, netInit(pickNet(opts?.scope, url), ctrl.signal));
      if (!res.ok || !res.body) continue;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || !value) break;
        bytes += value.byteLength;
        if (bytes >= maxBytes) {
          void reader.cancel().catch(() => undefined);
          break;
        }
      }
    } catch {
      /* one bad segment shouldn't lose the whole measurement */
    } finally {
      clearTimeout(timer);
      opts?.signal?.removeEventListener("abort", onAbort);
    }
  }
  const seconds = (Date.now() - started) / 1000;
  if (bytes <= 0 || seconds <= 0) return undefined;
  return bytes / seconds;
}

/** Pick the replay context for a URL's origin (headers never cross origins). */
export function pickNet(
  scope: { byOrigin: Record<string, NetReplay> } | undefined,
  url: string,
): NetReplay | undefined {
  if (!scope) return undefined;
  try {
    return scope.byOrigin[new URL(url).origin];
  } catch {
    return undefined;
  }
}

/**
 * Fetch one segment from this document, with retries. Throws a marked error
 * (see `isGateFailure`) when the CDN refuses the request.
 */
async function fetchBufferDirect(
  url: string,
  signal?: AbortSignal,
  scope?: { byOrigin: Record<string, NetReplay> },
): Promise<ArrayBuffer> {
  throwIfAborted(signal);
  const net = pickNet(scope, url);
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    // Per-attempt controller: links outer cancel + a timeout so one stalled
    // segment can't permanently occupy a pool slot (effective concurrency
    // would decay 8 -> 7 -> … which reads as "speed decreases over time").
    const ctrl = new AbortController();
    const onOuterAbort = (): void => ctrl.abort();
    if (signal) {
      if (signal.aborted) throw new Error("Download cancelled.");
      signal.addEventListener("abort", onOuterAbort, { once: true });
    }
    const timer = setTimeout(() => ctrl.abort(), SEGMENT_TIMEOUT_MS);
    try {
      // NOTE: headers in `net` were already scoped to this origin by the
      // background lookup — never attach foreign auth here.
      const res = await fetch(url, netInit(net, ctrl.signal));
      if (res.status === 403 || res.status === 404 || res.status === 410) {
        // Permanent: signed URL expired/revoked or chunk gone — retrying
        // only wastes minutes before failing the whole job.
        throw markGated(
          new Error(
            `Stream chunk unavailable (${res.status}) — the link likely expired. Replay the video, hit Rescan, and retry right away.`,
          ),
        );
      }
      if (res.status === 429 || res.status === 503) {
        // Transient throttle: honor Retry-After when present, else back off.
        const retryAfter = Number(res.headers.get("retry-after") || "0");
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 30
          ? retryAfter * 1000
          : 800 * attempt + Math.random() * 400;
        throw new ThrottledError(waitMs);
      }
      if (!res.ok) {
        const err = new Error(`Segment fetch failed (${res.status}): ${url}`);
        // Other 4xx: the request was refused, not the connection. Relayable.
        throw res.status >= 400 && res.status < 500 ? markGated(err) : err;
      }
      const buf = await res.arrayBuffer();
      rejectErrorPage(res.headers.get("content-type"), buf);
      return buf;
    } catch (err) {
      if (signal?.aborted) throw new Error("Download cancelled.");
      // Permanent failures (and our own validation errors) fail fast.
      if (err instanceof Error && /unavailable \(40|error page instead of video/i.test(err.message)) {
        throw err;
      }
      if (err instanceof ThrottledError) {
        lastErr = new Error(`Server throttled the download (429/503): ${url}`);
        if (attempt < FETCH_RETRIES) {
          await new Promise((r) => setTimeout(r, err.waitMs));
          continue;
        }
        throw lastErr;
      }
      // Timeout shows up as an AbortError on our inner controller while the
      // outer signal is still live — retry with a fresh connection.
      if (err instanceof DOMException && err.name === "AbortError" && !signal?.aborted) {
        lastErr = new Error(`Segment timed out after ${SEGMENT_TIMEOUT_MS / 1000}s: ${url}`);
      } else {
        lastErr = err;
      }
      if (attempt < FETCH_RETRIES) {
        await new Promise((r) => setTimeout(r, 400 * attempt + Math.random() * 300));
      }
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onOuterAbort);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`Segment fetch failed: ${url}`);
}

/**
 * Fetch one segment: direct first, and — only when the CDN refused the
 * request itself — the same URL through `relay` (the page's own request
 * context). A relay that also fails surfaces the ORIGINAL error, which is the
 * one that explains what the server said about this document's request.
 */
async function fetchBuffer(
  url: string,
  signal?: AbortSignal,
  scope?: { byOrigin: Record<string, NetReplay> },
  relay?: SegmentRelayFn,
): Promise<ArrayBuffer> {
  try {
    return await fetchBufferDirect(url, signal, scope);
  } catch (err) {
    if (!relay || signal?.aborted || !isGateFailure(err)) throw err;
    try {
      const buf = await relay(url, signal);
      rejectErrorPage(null, buf);
      return buf;
    } catch (relayErr) {
      // A relayed error page is the most specific explanation (and drives the
      // refresh-and-retry path); anything else keeps the direct refusal.
      if (relayErr instanceof Error && /error page instead of video/i.test(relayErr.message)) {
        throw relayErr;
      }
      throw err;
    }
  }
}

/** Internal: transient CDN throttle signal carrying the desired wait. */
class ThrottledError extends Error {
  waitMs: number;
  constructor(waitMs: number) {
    super("throttled");
    this.waitMs = waitMs;
  }
}

/**
 * Refuse error pages baked in as "video": expired signed URLs and blocked
 * requests often return 200 with an XML/HTML/JSON body. Concatenating one
 * silent-poisons the whole file, so fail here with a clear message.
 * (No valid video container starts with `<`, `{`, or `[`.)
 */
function rejectErrorPage(contentType: string | null, buf: ArrayBuffer): void {
  if (buf.byteLength === 0) return;
  const head = new Uint8Array(buf, 0, Math.min(4, buf.byteLength));
  const ct = (contentType ?? "").toLowerCase().split(";")[0].trim();
  const textish =
    ct.startsWith("text/") ||
    ct.includes("xml") ||
    ct.includes("json") ||
    ct.includes("html") ||
    ct === "";
  if (head[0] === 0x3c || ((head[0] === 0x7b || head[0] === 0x5b) && textish)) {
    throw new Error(
      "A stream chunk came back as an error page instead of video (link expired or request blocked). Replay the video, hit Rescan, and retry right away.",
    );
  }
}

/** Bounded parallel fetch that preserves segment order for concat. */
async function fetchAllOrdered(
  urls: string[],
  mime: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  scope?: { byOrigin: Record<string, NetReplay> },
): Promise<Blob> {
  const parts = await fetchSegments(urls, onProgress, signal, scope);
  throwIfAborted(signal);
  return new Blob(orderAndValidateSegmentParts(parts), { type: mime });
}

/**
 * Natural (numeric-aware) ordering for observed chunk URLs. The cluster
 * engine records URLs in network-arrival order, which breaks on seeks,
 * retries, and parallel range fetches — sort by the numbers in the path so
 * `seg-2` precedes `seg-10`. Stable: ties keep arrival order.
 */
export function sortSegmentsNatural(urls: string[]): string[] {
  const tokenize = (s: string): Array<string | number> => {
    const out: Array<string | number> = [];
    const re = /\d+|\D+/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s)) !== null) {
      out.push(/^\d+$/.test(m[0]) ? Number(m[0]) : m[0]);
    }
    return out;
  };
  const keys = urls.map((u) => {
    let s: string;
    try {
      const parsed = new URL(u);
      s = parsed.pathname + parsed.search;
    } catch {
      s = u;
    }
    return tokenize(s);
  });
  return urls
    .map((_, i) => i)
    .sort((a, b) => {
      const ka = keys[a];
      const kb = keys[b];
      const n = Math.max(ka.length, kb.length);
      for (let i = 0; i < n; i++) {
        const x = ka[i];
        const y = kb[i];
        if (x === undefined) return -1;
        if (y === undefined) return 1;
        if (typeof x === "number" && typeof y === "number") {
          if (x !== y) return x - y;
        } else {
          const xs = String(x);
          const ys = String(y);
          if (xs !== ys) return xs < ys ? -1 : 1;
        }
      }
      return a - b;
    })
    .map((i) => urls[i]);
}

// ---------- grouped-chunk validation (refuse corrupt files, don't make them) ----------

type SniffedKind = "ts" | "fmp4" | "webm" | "ogg" | "mp3" | "text" | "unknown";

/** Identify a container from its first bytes (cheap, per fetched chunk). */
export function sniffKind(head: Uint8Array): SniffedKind {
  if (head.length === 0) return "unknown";
  const b0 = head[0];
  if (b0 === 0x47) return "ts"; // MPEG-TS sync byte
  if (b0 === 0x3c) return "text"; // '<' — XML/HTML error page
  if (head.length >= 4) {
    if (b0 === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "webm";
    if (b0 === 0x4f && head[1] === 0x67 && head[2] === 0x67 && head[3] === 0x53) return "ogg";
    if (b0 === 0x49 && head[1] === 0x44 && head[2] === 0x33) return "mp3";
  }
  if (head.length >= 8) {
    const t = String.fromCharCode(head[4], head[5], head[6], head[7]);
    if (
      t === "ftyp" || t === "styp" || t === "sidx" || t === "moof" ||
      t === "moov" || t === "mdat" || t === "free" || t === "wide" ||
      t === "emsg" || t === "prft" || t === "mfra" || t === "skip" ||
      t === "uuid" || t === "pssh"
    ) {
      return "fmp4";
    }
  }
  return "unknown";
}

/**
 * A concatenated fMP4 stream is playable when the moov header appears in
 * the very first chunk — anything else (error page, missing init segment,
 * HTML) is rejected before it becomes a corrupt download. TS streams are
 * accepted as-is (checked by sync byte in the caller's fallback sniff).
 */
export function isPlayableMp4(head: Uint8Array): boolean {
  if (sniffKind(head) === "fmp4") return findInitChunk([head.buffer as ArrayBuffer]) !== undefined;
  return false;
}

/**
 * Decide how an over-cap capture splits into per-track part sets.
 * Returns null when every track fits under the cap (no split needed);
 * otherwise one part-count per track (>= 1 each).
 */
export function planCaptureSplit(trackBytes: number[], cap = MAX_BYTES): number[] | null {
  if (!trackBytes.some((n) => n > cap)) return null;
  return trackBytes.map((n) => (n > 0 ? Math.ceil(n / cap) : 1));
}

/**
 * Walk ISOBMFF boxes (bounded) looking for moov/pssh/media.
 * Descends into moov containers: DRM's SystemID header lives in a pssh
 * nested INSIDE moov on most packagers, so a top-level-only scan would let
 * encrypted streams through validation (the muxer would still refuse them,
 * but the error surfaces later and differently than intended).
 * Container types walked: moov (where pssh legally lives). Fragments
 * (moof) are NOT descended — senc/saiz there are the muxer's job and a
 * corrupt moof must not mask the container verdict.
 */
function scanTopLevel(
  buf: ArrayBuffer,
  budget = 262144,
): { moov: boolean; pssh: boolean; media: boolean } {
  const v = new Uint8Array(buf);
  const n = Math.min(v.length, budget);
  let moov = false;
  let pssh = false;
  let media = false;

  /** Bounded recursive walk; depth 1 (into moov) keeps worst case linear. */
  const walk = (start: number, end: number, depth: number): void => {
    let off = start;
    while (off + 8 <= end) {
      let size =
        (v[off] * 16777216 + v[off + 1] * 65536 + v[off + 2] * 256 + v[off + 3]) >>> 0;
      const type = String.fromCharCode(v[off + 4], v[off + 5], v[off + 6], v[off + 7]);
      let hdr = 8;
      if (size === 1) {
        // 64-bit largesize follows the type.
        if (off + 16 > end) return;
        const hi =
          (v[off + 8] * 16777216 + v[off + 9] * 65536 + v[off + 10] * 256 + v[off + 11]) >>> 0;
        const lo =
          (v[off + 12] * 16777216 + v[off + 13] * 65536 + v[off + 14] * 256 + v[off + 15]) >>> 0;
        const large = hi * 4294967296 + lo;
        if (!Number.isSafeInteger(large) || large < 16 || large > v.length) return;
        size = large;
        hdr = 16;
      } else if (size === 0) {
        return; // box extends to end of file — nothing more to learn
      }
      if (size < hdr) return; // corrupt
      if (type === "moov") moov = true;
      else if (type === "pssh") pssh = true;
      else if (type === "moof" || type === "mdat") media = true;
      if (moov && pssh && media) return;
      if (type === "moov" && depth < 1) {
        walk(off + hdr, Math.min(off + size, end), depth + 1);
      }
      const next = off + size;
      if (next <= off || next > end) return;
      off = next;
    }
  };

  walk(0, n, 0);
  return { moov, pssh, media };
}

function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a);
  const vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) {
    if (va[i] !== vb[i]) return false;
  }
  return true;
}

/**
 * Validate fetched chunks BEFORE they become a file, and repair what is
 * safely repairable (moving a lone init chunk first). Throws a clear,
 * actionable error instead of producing an unplayable download when:
 * - any chunk is an error page / non-video data,
 * - chunks mix containers/qualities (can't merge into one file),
 * - fragmented-MP4 chunks lack their init (`moov`) header,
 * - chunks carry a `pssh` box, top level or nested in moov (encrypted —
 *   undecryptable by design).
 */
export function orderAndValidateSegmentParts(parts: ArrayBuffer[]): ArrayBuffer[] {
  if (parts.length === 0) throw new Error("No segments to download.");
  const kinds = parts.map((p) =>
    sniffKind(new Uint8Array(p, 0, Math.min(8, p.byteLength))),
  );
  if (kinds.includes("text")) {
    throw new Error(
      "A stream chunk came back as an error page instead of video (link expired or request blocked). Replay the video, hit Rescan, and retry right away.",
    );
  }
  const unknownIdx = kinds.findIndex((k) => k === "unknown");
  if (unknownIdx >= 0) {
    throw new Error(
      "A stream chunk isn't video data (the server refused the request or a non-media URL got mixed in). Replay the video from the start, Rescan, and retry.",
    );
  }
  const distinct = new Set(kinds);
  if (distinct.size > 1) {
    throw new Error(
      "Grouped chunks contain mixed formats or qualities, so they can't be merged into one file. Try a manifest quality (HLS/DASH row) or the Capture row instead.",
    );
  }
  if (kinds[0] !== "fmp4") return parts; // TS/WebM/Ogg concat is order-tolerant

  const scans = parts.map((p) => scanTopLevel(p));
  if (scans.some((s) => s.pssh)) {
    throw new Error("Protected content — chunks are encrypted and cannot be downloaded.");
  }
  const moovIdx: number[] = [];
  scans.forEach((s, i) => {
    if (s.moov) moovIdx.push(i);
  });
  if (moovIdx.length === 0) {
    throw new Error(
      `Couldn't rebuild a playable file from ${parts.length} grouped chunks — the stream's header segment wasn't captured (common after seeking or late detection). Replay the video from the start, then Rescan and retry.`,
    );
  }
  if (moovIdx.length > 1) {
    // Safe salvage: some packagers repeat the SAME pure init (ftyp+moov, no
    // media) per segment block. Dropping byte-identical media-less copies
    // can never corrupt the file — anything else stays a refusal.
    const first = parts[moovIdx[0]];
    const salvageable = moovIdx.slice(1).every((i) => {
      if (scans[i].media) return false;
      return buffersEqual(parts[i], first);
    });
    if (salvageable) {
      const drop = new Set(moovIdx.slice(1));
      parts = parts.filter((_, i) => !drop.has(i));
    } else {
      throw new Error(
        "These segments carry multiple quality headers (the site switches quality mid-stream), so they can't be merged into one file. Try a single quality from the dropdown, the direct-file row if listed, or the Capture row instead.",
      );
    }
  }
  if (moovIdx[0] !== 0) {
    // Lone init chunk arrived out of order — init must lead the file.
    const [init] = parts.splice(moovIdx[0], 1);
    parts.unshift(init);
  }
  return parts;
}

/**
 * Return the buffer holding the fMP4 init (`moov`) header, if any.
 * Continuation parts of a split download prepend a copy of it so every
 * part file is playable on its own.
 */
export function findInitChunk(parts: ArrayBuffer[]): ArrayBuffer | undefined {
  for (const p of parts) {
    try {
      if (scanTopLevel(p).moov) return p;
    } catch {
      /* ignore corrupt scans — validation reports them */
    }
  }
  return undefined;
}

/** One contiguous slice of a segment list, with resumable partial progress. */
export interface SegmentRange {
  start: number;
  end: number;
  partials?: Array<ArrayBuffer | undefined>;
}

/** A fully fetched range, ready to validate and save. */
export interface SegmentedPart {
  start: number;
  end: number;
  buffers: ArrayBuffer[];
}

/**
 * Fetch one URL window. `existingParts` (same length as `urls`) pre-fills
 * already-fetched buffers so only holes are fetched. Must attach
 * `partials` to any thrown error (fetchSegments does) so progress survives.
 */
export type FetchRangeFn = (
  urls: string[],
  opts: {
    start: number;
    end: number;
    existingParts?: Array<ArrayBuffer | undefined>;
    onProgress?: ProgressCallback;
  },
) => Promise<ArrayBuffer[]>;

/** Persist one fetched part before the next range starts (bounds memory). */
export type SavePartFn = (part: SegmentedPart, partNo: number, multi: boolean) => Promise<void>;

/**
 * Fetch a segment list that may exceed MAX_BYTES, splitting it into
 * sequentially saved parts. Fast path: the whole list is tried first, so
 * files under the cap behave exactly like a single fetchSegments call
 * (`multi` is false and the part is the complete file). On a cap halt the
 * failing range is binary-split (keeping fetched buffers via `partials`)
 * until every range fits; ranges are fetched and saved strictly in
 * playlist order, so part N always precedes part N+1.
 *
 * Returns `{ parts, multi }`. Throws the original network error for
 * non-cap failures, or an actionable error when a single segment alone
 * exceeds the cap.
 */
export async function fetchSegmentedParts(
  urls: string[],
  fetchRange: FetchRangeFn,
  onPart: SavePartFn,
): Promise<{ parts: number; multi: boolean }> {
  if (urls.length === 0) throw new Error("No segments to download.");
  const stack: SegmentRange[] = [{ start: 0, end: urls.length }];
  let saved = 0;
  let everSplit = false;
  while (stack.length > 0) {
    const range = stack.pop() as SegmentRange;
    const win = urls.slice(range.start, range.end);
    let buffers: ArrayBuffer[];
    try {
      buffers = await fetchRange(win, {
        start: range.start,
        end: range.end,
        existingParts:
          range.partials?.length === win.length ? range.partials : undefined,
      });
    } catch (err) {
      if (!isCapExceeded(err)) throw err;
      if (range.end - range.start <= 1) {
        throw new Error(
          "A single video chunk is larger than the 1.5 GB safety cap — pick a lower quality from the quality dropdown and retry.",
        );
      }
      everSplit = true;
      const mid = range.start + Math.ceil((range.end - range.start) / 2);
      const partials = capPartials(err);
      // Stack (LIFO): push the second half first so the first half — which
      // must be saved first for ordered part files — pops next.
      stack.push({
        start: mid,
        end: range.end,
        partials: partials ? partials.slice(mid - range.start) : undefined,
      });
      stack.push({
        start: range.start,
        end: mid,
        partials: partials ? partials.slice(0, mid - range.start) : undefined,
      });
      continue;
    }
    saved++;
    const multi = everSplit || stack.length > 0;
    await onPart({ start: range.start, end: range.end, buffers }, saved, multi);
  }
  return { parts: saved, multi: everSplit || saved > 1 };
}

/**
 * Fetch segment URLs with bounded parallelism, retries, and safety caps.
 * Returns ordered ArrayBuffers (caller decides concat vs mux).
 * Supports pause (workers wait while isPaused) and resume via existingParts.
 * A segment this document is refused (`isGateFailure`) is retried through
 * `opts.relay` — the page's own request context — before the job fails.
 * On failure, partial parts are attached to the thrown error as `partials`
 * so callers can retry only the holes (e.g. after playlist refresh).
 */
export async function fetchSegments(
  urls: string[],
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  scope?: { byOrigin: Record<string, NetReplay> },
  opts?: FetchSegmentsOptions,
): Promise<ArrayBuffer[]> {
  if (urls.length === 0) throw new Error("No segments to download.");
  if (urls.length > MAX_SEGMENTS) {
    throw new Error(
      `Playlist lists ${urls.length} segments (likely a live stream) — only bounded videos up to ${MAX_SEGMENTS} segments are supported.`,
    );
  }
  const total = urls.length;
  const parts: Array<ArrayBuffer | undefined> = opts?.existingParts?.length === total
    ? [...opts.existingParts]
    : new Array(total);
  let done = 0;
  let bytes = 0;
  for (let i = 0; i < total; i++) {
    if (parts[i]) {
      done++;
      bytes += parts[i]!.byteLength;
    }
  }
  if (done > 0) onProgress?.(done, total, bytes);
  // Skip-ahead cursor: start after the leading run of completed parts so a
  // resume doesn't re-queue everything through the pool.
  let next = 0;
  while (next < total && parts[next]) next++;
  const waitWhilePaused = async (): Promise<void> => {
    while (opts?.isPaused?.()) {
      throwIfAborted(signal);
      await new Promise((r) => setTimeout(r, 200));
    }
  };
  let firstErr: unknown = null;
  const worker = async (): Promise<void> => {
    while (true) {
      throwIfAborted(signal);
      // Drain, don't stampede: after one segment fails, in-flight fetches
      // finish (their bytes are kept in partials) but no NEW indices start —
      // the remainder will be retried with refreshed URLs by the caller.
      if (firstErr) return;
      await waitWhilePaused();
      if (firstErr) return;
      const i = next++;
      if (i >= total) return;
      // Skip holes filled by a racing worker after resume mapping.
      if (parts[i]) continue;
      try {
        const buf = await fetchBuffer(urls[i], signal, scope, opts?.relay);
        parts[i] = buf;
        bytes += buf.byteLength;
        if (bytes > MAX_BYTES) {
          if (!firstErr) {
            const cap = new CapExceededError();
            (cap as unknown as Record<string, unknown>).partials = parts;
            firstErr = cap;
          }
          return;
        }
        try {
          opts?.onSegmentDone?.(i, buf);
        } catch {
          /* persistence is best-effort */
        }
        done++;
        onProgress?.(done, total, bytes);
      } catch (err) {
        // Cancel keeps fail-fast semantics (nothing is resumable anyway).
        if (signal?.aborted) throw err;
        if (!firstErr) firstErr = err;
        return;
      }
    }
  };
  const pool = Math.min(FETCH_CONCURRENCY, total);
  await Promise.all(Array.from({ length: pool }, () => worker()));
  throwIfAborted(signal);
  if (firstErr) {
    // Preserve partial progress for refresh-and-retry callers.
    if (firstErr && typeof firstErr === "object" && !("partials" in (firstErr as object))) {
      (firstErr as unknown as Record<string, unknown>).partials = parts;
    }
    throw firstErr;
  }
  return parts as ArrayBuffer[];
}

/**
 * HLS assembly: fetch every segment of the chosen variant in order,
 * concatenate into a single Blob (video/mp2t). No remuxing — the .ts
 * plays in VLC and most players. Pure bytes-in/Blob-out: must run in a
 * document context with DOM APIs (offscreen document) — NOT in the
 * service worker. The caller (service worker) performs the actual
 * chrome.downloads.download(), because offscreen documents only have
 * the chrome.runtime API.
 */
export async function assembleHlsBlob(
  variantPlaylistUrl: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  scope?: { byOrigin: Record<string, NetReplay> },
): Promise<Blob> {
  throwIfAborted(signal);
  const playlistRes = await fetch(variantPlaylistUrl, netInit(pickNet(scope, variantPlaylistUrl), signal));
  if (!playlistRes.ok)
    throw new Error(
      `Variant playlist fetch failed (${playlistRes.status})`,
    );
  const text = await playlistRes.text();

  // Refuse encrypted streams — never attempt to fetch/decrypt them.
  if (/#EXT-X-KEY\s*:\s*[^\r\n]*METHOD\s*=\s*(?!NONE\b)/i.test(text)) {
    throw new Error("Protected content — cannot download (encrypted HLS).");
  }

  const segmentUrls = extractHlsSegments(text, variantPlaylistUrl);
  if (segmentUrls.length === 0)
    throw new Error("No segments found in the HLS variant playlist.");

  // 8-way parallel fetch, order preserved for concat; retries + caps inside.
  return fetchAllOrdered(segmentUrls, "video/mp2t", onProgress, signal, scope);
}

/** DASH assembly: same concat approach over the parsed variant's segments. */
export async function assembleDashBlob(
  segmentUrls: string[],
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
  scope?: { byOrigin: Record<string, NetReplay> },
): Promise<Blob> {
  if (segmentUrls.length === 0)
    throw new Error("No segments listed for this DASH variant.");
  // DASH segments are typically fragmented MP4; concat preserves playability
  // for many players without a full remux (stretch goal, not v1).
  return fetchAllOrdered(segmentUrls, "video/mp4", onProgress, signal, scope);
}

/** Blob -> base64 data URL for transfer to the service worker. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error("Failed to encode download file."));
      reader.onload = () => {
        if (typeof reader.result === "string") resolve(reader.result);
        else reject(new Error("Failed to encode download file."));
      };
      reader.readAsDataURL(blob);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
