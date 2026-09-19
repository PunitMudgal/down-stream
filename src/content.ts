import { extractWithAdapters, matchAdapters, type AdapterPage } from "./lib/adapters";
import { pickShortcutVideo, type ShortcutVideoSnapshot } from "./lib/pickVideo";
import type { BlobFileInfo, MediaItem, MsSessionMeta, VideoSignal } from "./lib/types";

const MAX_FETCH_BYTES = 5_000_000;

/*
 * PERFORMANCE CONTRACT (this script is injected into every frame of every
 * page, including YouTube/Grok-style heavy SPAs):
 * - No full-document scans on DOM mutations. A live registry of <video>
 *   elements is maintained incrementally from MutationObserver addedNodes
 *   (bounded by added-subtree size); one full scan happens once, idle.
 * - The observer watches childList only. Attribute churn (progress bars,
 *   framework patches) must never trigger collection.
 * - No layout-thrashing reads: textContent only, never innerText; expensive
 *   title/poster lookups are cached per element with a TTL.
 * - Hidden tabs do no work; subframes stay silent unless they found media.
 * - If the extension context is gone (reload/update), the script shuts
 *   itself down instead of burning CPU on doomed sendMessage calls.
 */

const IN_SUBFRAME = (() => {
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
})();

let dead = false;

function noteDead(err: unknown): void {
  if (
    err instanceof Error &&
    /extension context invalidated|context invalidated/i.test(err.message)
  ) {
    dead = true;
    try {
      observer.disconnect();
    } catch {
      /* ignore */
    }
    if (reportTimer !== undefined) {
      window.clearTimeout(reportTimer);
      reportTimer = undefined;
    }
  }
}

/** Best-effort send; returns false (and shuts down) when the context died. */
async function bgSend(msg: object): Promise<boolean> {
  if (dead) return false;
  try {
    await chrome.runtime.sendMessage(msg);
    return true;
  } catch (err) {
    noteDead(err);
    return false;
  }
}

// ---- MSE capture bridge (MAIN-world hook <-> extension) ----
interface MsPending {
  resolve: (v: unknown) => void;
  timer: number;
}
const msPending = new Map<string, MsPending>();

function msNonce(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

window.addEventListener("message", (event) => {
  try {
    if (event.source !== window) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const d = event.data as any;
    if (!d || typeof d !== "object" || typeof d.nonce !== "string") return;
    const p = msPending.get(d.nonce);
    if (!p) return;
    msPending.delete(d.nonce);
    window.clearTimeout(p.timer);
    p.resolve(d);
  } catch {
    /* ignore */
  }
});

function askHook(msg: object, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve) => {
    const nonce = msNonce();
    const timer = window.setTimeout(() => {
      msPending.delete(nonce);
      resolve({ __vdg: "timeout", nonce });
    }, timeoutMs);
    msPending.set(nonce, { resolve, timer });
    try {
      window.postMessage({ ...(msg as object), nonce }, "*");
    } catch {
      msPending.delete(nonce);
      window.clearTimeout(timer);
      resolve({ __vdg: "post-failed", nonce });
    }
  });
}

/** Metadata-only snapshot of page MSE capture sessions (never bytes). */
async function queryMsSessions(): Promise<MsSessionMeta[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await askHook({ __vdg: "ms-sessions" }, 1500)) as any;
    if (res && res.__vdg === "ms-sessions-result" && Array.isArray(res.sessions)) {
      return res.sessions as MsSessionMeta[];
    }
  } catch {
    /* hook absent (older injection, odd frame) — no sessions */
  }
  return [];
}

/** Blobs the page published (url/size/type only — bytes stay put). */
async function queryBlobs(): Promise<BlobFileInfo[]> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await askHook({ __vdg: "blob-list" }, 1500)) as any;
    if (res && res.__vdg === "blob-list-result" && Array.isArray(res.blobs)) {
      return (res.blobs as BlobFileInfo[]).filter(
        (b) => b && typeof b.url === "string" && typeof b.size === "number" && b.size > 0,
      );
    }
  } catch {
    /* ignore */
  }
  return [];
}

function absolutize(raw: string | null): string | null {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || s.startsWith("data:")) return null;
  try {
    return new URL(s, location.href).toString();
  } catch {
    return null;
  }
}

// ---- Incremental <video> registry ----
const liveVideos = new Set<HTMLVideoElement>();

/** The <video> under the cursor when the context menu opened (for CONTEXT_DOWNLOAD). */
let contextVideo: HTMLVideoElement | null = null;
try {
  document.addEventListener(
    "contextmenu",
    (e) => {
      const t = e.target;
      contextVideo = t instanceof HTMLVideoElement ? t : null;
    },
    true,
  );
} catch {
  /* ignore */
}

function takeVideo(v: HTMLVideoElement): boolean {
  if (liveVideos.has(v)) return false;
  if (liveVideos.size >= 100) return false; // absurd pages: bound the set
  liveVideos.add(v);
  return true;
}

/**
 * Ingest one added node and its descendants (O(added subtree), never
 * O(document)). Shadow roots are pierced only inside added subtrees.
 */
function ingestAdded(node: Node): boolean {
  let added = false;
  try {
    if (node instanceof HTMLVideoElement) {
      if (takeVideo(node)) added = true;
    }
    if (node instanceof Element) {
      const stack: Element[] = [node];
      while (stack.length) {
        const el = stack.pop() as Element;
        if (el instanceof HTMLVideoElement) {
          if (takeVideo(el)) added = true;
        }
        const sr = (el as HTMLElement).shadowRoot;
        if (sr) {
          try {
            sr.querySelectorAll("video").forEach((v) => {
              if (takeVideo(v as HTMLVideoElement)) added = true;
            });
          } catch {
            /* ignore */
          }
          try {
            for (const c of Array.from(sr.children)) stack.push(c);
          } catch {
            /* ignore */
          }
        }
        try {
          for (const c of Array.from(el.children)) stack.push(c);
        } catch {
          /* ignore */
        }
      }
    } else if (node instanceof DocumentFragment || node instanceof ShadowRoot) {
      try {
        (node as unknown as ParentNode).querySelectorAll?.("video").forEach((v) => {
          if (takeVideo(v as HTMLVideoElement)) added = true;
        });
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return added;
}

/**
 * One-time full scan (idle boot + explicit rescans only): direct videos,
 * same-origin iframes, and shadow hosts (bounded host count).
 */
function fullScan(): boolean {
  let added = false;
  try {
    document.querySelectorAll("video").forEach((v) => {
      if (takeVideo(v as HTMLVideoElement)) added = true;
    });
  } catch {
    /* ignore */
  }
  try {
    const hosts = document.querySelectorAll("*");
    if (hosts.length <= 15000) {
      hosts.forEach((el) => {
        const sr = (el as HTMLElement).shadowRoot;
        if (sr && ingestAdded(sr)) added = true;
      });
    }
  } catch {
    /* ignore */
  }
  // Same-origin iframes (cross-origin ones are opaque to us).
  try {
    Array.from(document.querySelectorAll("iframe")).forEach((frame) => {
      try {
        const doc = frame.contentDocument;
        if (doc) {
          doc.querySelectorAll("video").forEach((v) => {
            if (takeVideo(v as HTMLVideoElement)) added = true;
          });
        }
      } catch {
        /* cross-origin iframe — skip */
      }
    });
  } catch {
    /* ignore */
  }
  return added;
}

function signalFrom(el: HTMLVideoElement): VideoSignal | null {
  const candidates: string[] = [];
  if (el.currentSrc) candidates.push(el.currentSrc);
  const srcAttr = absolutize(el.getAttribute("src"));
  if (srcAttr && !candidates.includes(srcAttr)) candidates.push(srcAttr);
  el.querySelectorAll("source[src]").forEach((n) => {
    const u = absolutize(n.getAttribute("src"));
    if (u && !candidates.includes(u)) candidates.push(u);
  });
  // Some players stash the file URL on data-* attributes.
  for (const attr of ["data-src", "data-url", "data-video-url", "data-source"]) {
    const u = absolutize(el.getAttribute(attr));
    if (u && !candidates.includes(u)) candidates.push(u);
  }
  const cached = cachedExpensiveMeta(el);
  const poster = cached.poster || undefined;
  const title = cached.title || undefined;
  if (candidates.length === 0 && !poster && !title) return null;
  return {
    currentSrc: candidates[0] ?? "",
    candidates,
    poster,
    title,
    duration: Number.isFinite(el.duration) ? el.duration : undefined,
    paused: el.paused,
    width: el.videoWidth || undefined,
    height: el.videoHeight || undefined,
  };
}

/** Title/poster lookups touch ancestors — cache per element with a TTL. */
const META_CACHE_MS = 20_000;
const metaCache = new WeakMap<HTMLVideoElement, { title: string | null; poster: string | null; at: number }>();

function cachedExpensiveMeta(el: HTMLVideoElement): { title: string | null; poster: string | null } {
  const now = Date.now();
  const hit = metaCache.get(el);
  if (hit && now - hit.at < META_CACHE_MS) return hit;
  const fresh = { title: findTitle(el), poster: findPoster(el), at: now };
  try {
    metaCache.set(el, fresh);
  } catch {
    /* ignore */
  }
  return fresh;
}

function cleanSnippet(s: string | null | undefined, max = 140): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length < 5 || t.length > max) return null;
  return t;
}

/**
 * Best-effort per-video title: player attributes first, then post/caption
 * text near the player (X-style tweet text, figcaptions, nearby headings),
 * so each download can carry the video's name instead of a hash.
 *
 * NOTE: textContent only — innerText forces style/layout and janks
 * streaming pages (Grok token streaming, YouTube comments) on every scan.
 */
function findTitle(el: HTMLVideoElement): string | null {
  try {
    const direct =
      cleanSnippet(el.getAttribute("aria-label")) || cleanSnippet(el.getAttribute("title"));
    if (direct) return direct;
    let node: HTMLElement | null = el;
    for (let level = 0; level < 6 && node; level++) {
      node = node.parentElement;
      if (!node) break;
      const safe = node.querySelectorAll(
        '[data-testid="tweetText"], figcaption, [class*="caption" i]',
      );
      for (const c of Array.from(safe)) {
        const t = cleanSnippet((c as HTMLElement).textContent);
        if (t) return t;
      }
      // Headings/named blocks only close to the player (avoids site chrome).
      if (level < 3) {
        const near = node.querySelectorAll("h1, h2, h3, [class*=\"video-title\" i], [class*=\"media-title\" i]");
        for (const c of Array.from(near)) {
          const t = cleanSnippet((c as HTMLElement).textContent, 100);
          if (t) return t;
        }
      }
    }
    // Page-level fallbacks (Pinterest-style pins expose these, not DOM text).
    const og = document.querySelector('meta[property="og:title"], meta[name="twitter:title"]');
    const ogTitle = cleanSnippet(og?.getAttribute("content"), 100);
    if (ogTitle) return ogTitle;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * X/feed players rarely set video.poster — the visible thumbnail is usually
 * an <img> in the same media container. Walk up a few levels and take the
 * best-scoring image (media-ish URL, decent size), skipping tiny avatars.
 */
function findPoster(el: HTMLVideoElement): string | null {
  try {
    let node: HTMLElement | null = el;
    for (let level = 0; level < 5 && node; level++) {
      node = node.parentElement;
      if (!node) break;
      let best: string | null = null;
      let bestScore = 0;
      node.querySelectorAll("img[src]").forEach((img) => {
        if (img === el) return;
        const src = absolutize(img.getAttribute("src"));
        if (!src || src === el.currentSrc) return;
        let score = 1;
        if (/media|video|thumb|poster|preview|twimg|pbs/i.test(src)) score += 2;
        const w = (img as HTMLImageElement).naturalWidth || Number(img.getAttribute("width")) || 0;
        if (w >= 200) score += 2;
        else if (w > 0 && w < 100) score -= 2; // avatar-sized
        if (score > bestScore) {
          bestScore = score;
          best = src;
        }
      });
      if (best && bestScore >= 3) return best;
    }
    // Page-level fallback: og:image is the pin/post thumbnail on sites
    // (Pinterest) whose player DOM carries no usable <img>.
    const og = document.querySelector('meta[property="og:image"], meta[name="twitter:image"]');
    const ogSrc = absolutize(og?.getAttribute("content") ?? null);
    if (ogSrc) return ogSrc;
  } catch {
    /* ignore */
  }
  return null;
}

/**
 * The video a keyboard shortcut should act on (deterministic priority lives in
 * `pickShortcutVideo` — see lib/pickVideo.ts). Returns null when the page has
 * no <video> at all.
 */
function bestVideoForShortcut(): HTMLVideoElement | null {
  try {
    const candidates: Array<{ el: HTMLVideoElement; snap: ShortcutVideoSnapshot }> = [];
    liveVideos.forEach((v) => {
      try {
        if (!v.isConnected) return;
        const r = v.getBoundingClientRect();
        candidates.push({
          el: v,
          snap: {
            playing: !v.paused && !v.ended,
            area: Math.max(0, r.width) * Math.max(0, r.height),
            hasSource: !!(v.currentSrc || v.getAttribute("src")),
          },
        });
      } catch {
        /* ignore */
      }
    });
    const idx = pickShortcutVideo(candidates.map((c) => c.snap));
    return idx >= 0 ? candidates[idx].el : null;
  } catch {
    return null;
  }
}

function collect(): VideoSignal[] {
  try {
    const out: VideoSignal[] = [];
    liveVideos.forEach((v) => {
      try {
        if (!v.isConnected) {
          liveVideos.delete(v);
          return;
        }
        const s = signalFrom(v);
        if (s) out.push(s);
      } catch {
        /* ignore single-element failures */
      }
    });
    return out;
  } catch {
    return [];
  }
}

/** Stable content script fingerprint for adapter extraction results. */
let lastAdapterKey = "";

/**
 * Run registered site adapters against this frame's media snapshot. Adapters
 * return complete media items; classification, manifest parsing, persistence,
 * and deduplication happen downstream in the background worker. Failures and
 * empty results are indistinguishable downstream, so this is strictly
 * additive to generic detection.
 */
function collectAdapterItems(videos: VideoSignal[]): MediaItem[] {
  if (matchAdapters(location.href).length === 0) return [];
  try {
    const mediaUrls: string[] = [];
    for (const signal of videos) {
      if (signal.currentSrc) mediaUrls.push(signal.currentSrc);
      for (const candidate of signal.candidates ?? []) mediaUrls.push(candidate);
    }
    const page: AdapterPage = { url: location.href, title: document.title, mediaUrls };
    const items = extractWithAdapters(page);
    if (items.length === 0) {
      lastAdapterKey = "";
      return [];
    }
    lastAdapterKey = items
      .map((item) => item.url)
      .sort()
      .join("|");
    return items;
  } catch {
    return [];
  }
}

function pageHidden(): boolean {
  try {
    return document.hidden;
  } catch {
    return false;
  }
}

let lastSent = "";
let lastSessQuery = 0;
let reportTimer: number | undefined;

function scheduleReport(): void {
  if (dead || reportTimer !== undefined) return;
  reportTimer = window.setTimeout(
    () => {
      reportTimer = undefined;
      void report(false);
    },
    IN_SUBFRAME ? 3000 : 1500,
  );
}

async function report(force: boolean): Promise<void> {
  if (dead) return;
  // Hidden tabs do no work — refresh on visibility return instead.
  if (!force && pageHidden()) return;
  try {
    const videos = collect();
    const adapterItems = collectAdapterItems(videos);
    const hasAdapterItems = adapterItems.length > 0;
    const now = Date.now();
    let sessions: MsSessionMeta[] = [];
    let blobs: BlobFileInfo[] = [];
    // Session/blob metadata only on demand or at a slow cadence: every
    // report used to round-trip the MAIN hook, waking both worlds constantly.
    if (force || now - lastSessQuery > 15000) {
      lastSessQuery = now;
      [sessions, blobs] = await Promise.all([queryMsSessions(), queryBlobs()]);
      if (dead) return;
    }
    // Subframes stay silent unless they actually found something worth
    // reporting (ads/embeds/trackers otherwise chatter on every scan).
    if (IN_SUBFRAME && !force && videos.length === 0 && sessions.length === 0 && blobs.length === 0 && !hasAdapterItems) return;
    // Session bytes rounded to MB: reports refresh as captures grow,
    // without spamming on every appended chunk.
    const sessKey = sessions
      .map((s) => `${s.id}:${Math.floor(s.bytes / 1_000_000)}:${s.tracks.length}`)
      .join(",");
    const blobKey = blobs.map((b) => `${b.url}:${b.size}`).join(",");
    const key =
      JSON.stringify(videos.map((v) => [v.currentSrc, v.poster, v.paused, v.title])) +
      "|" +
      sessKey +
      "|" +
      blobKey +
      "|" +
      (hasAdapterItems ? lastAdapterKey : "");
    if (
      !force &&
      key === lastSent &&
      videos.length === 0 &&
      sessions.length === 0 &&
      blobs.length === 0 &&
      !hasAdapterItems
    ) {
      return;
    }
    lastSent = key;
    await bgSend({
      type: "VIDEO_ELEMENTS",
      tabId: -1, // background resolves the real tab via sender.tab
      videos,
      pageTitle: document.title,
      msSessions: sessions,
      blobs,
      adapterItems: hasAdapterItems ? adapterItems : undefined,
    });
  } catch (err) {
    noteDead(err);
    /* extension context may be unavailable — enrichment is best-effort */
  }
}

// Continuous watch for SPA feeds (X/Twitter timeline, infinite scroll):
// players mount <video> nodes long after load. childList only — attribute
// churn must never schedule work (see header contract).
const observer = new MutationObserver((records) => {
  if (dead) return;
  try {
    let changed = false;
    for (const r of records) {
      if (r.addedNodes.length) {
        r.addedNodes.forEach((n) => {
          if (ingestAdded(n)) changed = true;
        });
      }
      if (r.removedNodes.length) {
        r.removedNodes.forEach((n) => {
          try {
            if (n instanceof HTMLVideoElement) {
              if (liveVideos.delete(n)) changed = true;
            } else if (
              n instanceof Element &&
              (n.querySelector?.("video") || (n as HTMLElement).shadowRoot)
            ) {
              // A subtree containing players was removed — prune lazily and
              // refresh so stale rows disappear.
              changed = true;
            }
          } catch {
            /* ignore */
          }
        });
      }
      if (changed) break;
    }
    if (changed) scheduleReport();
  } catch {
    /* ignore */
  }
});
try {
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }
} catch {
  /* ignore */
}

// Report the moment anything starts playing (covers players that only set
// a real URL on play, and refreshes paused/playing + duration metadata).
document.addEventListener("play", () => scheduleReport(), true);
document.addEventListener("loadedmetadata", () => scheduleReport(), true);
// Hidden tab did no work while away — catch up once on return.
document.addEventListener("visibilitychange", () => {
  if (!dead && !pageHidden()) scheduleReport();
});

// Deferred boot: never compete with page load. The observer above already
// tracks anything mounted meanwhile; this just establishes the baseline.
try {
  const kick = (): void => {
    if (dead) return;
    try {
      fullScan();
    } catch {
      /* ignore */
    }
    void report(true);
  };
  const ric = (window as unknown as { requestIdleCallback?: unknown }).requestIdleCallback;
  if (typeof ric === "function") {
    (ric as (cb: () => void, opts?: { timeout: number }) => void).call(window, kick, { timeout: 4000 });
  } else {
    window.setTimeout(kick, 2500);
  }
} catch {
  /* ignore */
}

// Findings from the MAIN-world API hook (fetch/XHR responses embedding
// manifest URLs). Only extracted URL strings ever cross into the extension.
window.addEventListener("message", (event) => {
  try {
    if (dead) return;
    if (event.source !== window) return;
    const d = event.data as { __vdg?: unknown; urls?: unknown; pairs?: unknown } | null;
    if (!d || typeof d !== "object") return;
    if (d.__vdg === "manifest-urls" && Array.isArray(d.urls)) {
      const urls = (d.urls as unknown[]).filter((u): u is string => typeof u === "string").slice(0, 30);
      if (!urls.length) return;
      void bgSend({
        type: "VIDEO_ELEMENTS",
        tabId: -1, // background resolves the real tab via sender.tab
        videos: urls.map((u) => ({ currentSrc: u, candidates: [u] })),
        pageTitle: document.title,
      });
    } else if (d.__vdg === "manifest-meta" && Array.isArray(d.pairs)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pairs = (d.pairs as any[])
        .filter((p) => typeof p?.manifest === "string" && Array.isArray(p?.thumbs))
        .slice(0, 30)
        .map((p) => ({ manifest: p.manifest as string, thumbs: (p.thumbs as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 5) }));
      if (!pairs.length) return;
      void bgSend({
        type: "MANIFEST_META",
        tabId: -1,
        pairs,
      });
    }
  } catch {
    /* ignore */
  }
});

// ---- MSE capture download driver ----
// Pulls captured bytes from the MAIN-world hook in paced ≤4MB steps and
// streams them to the offscreen document, which assembles + hands off to
// the worker through the normal DOWNLOAD_BLOB flow.
const msAbort = new Set<string>();
const MS_TRANSFER_CAP = 500_000_000;

async function driveMsDownload(
  jobId: string,
  captureId: string,
  trackIdx: number,
  filename: string,
  pairTrackIdx?: number,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fail = (error: string): void => {
    void bgSend({ type: "DOWNLOAD_ERROR", jobId, error });
  };
  const pullTrack = async (idx: number, which: 0 | 1, indexStart: number): Promise<number> => {
    const sessions = await queryMsSessions();
    const track = sessions.find((s) => s.id === captureId)?.tracks[idx];
    if (!track) throw new Error("Capture expired — the page dropped the player buffer. Replay the video and Rescan.");
    if (track.bytes <= 0) throw new Error("Capture is empty — let the video play longer, then retry.");
    let cursor = 0;
    let index = indexStart;
    for (;;) {
      if (msAbort.has(jobId)) throw new Error("Download cancelled.");
      if (cursor > MS_TRANSFER_CAP) throw new Error("Capture exceeds the 500 MB safety cap.");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = (await askHook(
        { __vdg: "ms-get", id: captureId, track: idx, cursor },
        20000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      )) as any;
      if (!res || res.__vdg !== "ms-chunk" || res.error) {
        throw new Error(typeof res?.error === "string" ? res.error : "Capture transfer failed.");
      }
      if (res.buf instanceof ArrayBuffer && res.buf.byteLength > 0) {
        const ok = await bgSend({
          type: "MS_TRACK_CHUNK",
          jobId,
          which,
          index,
          total: track.bytes,
          buf: res.buf,
        });
        if (!ok) throw new Error("Download cancelled.");
        index++;
      }
      cursor = typeof res.next === "number" ? res.next : cursor;
      if (res.done) break;
    }
    return index;
  };
  try {
    const sessions = await queryMsSessions();
    const session = sessions.find((s) => s.id === captureId);
    const track = session?.tracks[trackIdx];
    if (!session || !track || track.bytes <= 0) {
      fail(!session || !track ? "Capture expired — the page dropped the player buffer. Replay the video and Rescan." : "Capture is empty — let the video play longer, then retry.");
      return;
    }
    const pair = pairTrackIdx != null ? session.tracks[pairTrackIdx] : undefined;
    const total = track.bytes + (pair && pair.bytes > 0 ? pair.bytes : 0);
    await bgSend({
      type: "MS_TRACK_START",
      jobId,
      total,
      mime: track.mime,
      filename,
    });
    let index = await pullTrack(trackIdx, 0, 0);
    if (pair && pair.bytes > 0) {
      index = await pullTrack(pairTrackIdx as number, 1, index);
      void index;
    }
    await bgSend({ type: "MS_TRACK_END", jobId });
  } catch (err) {
    if (msAbort.has(jobId)) {
      msAbort.delete(jobId);
      fail("Download cancelled.");
    } else {
      fail(err instanceof Error ? err.message : String(err));
    }
  } finally {
    msAbort.delete(jobId);
  }
}

// ---- Blob-file download driver ----
// Streams a page-held Blob (whole-file blob: playback) to the offscreen
// document in ≤4MB slices, reusing the MS_TRACK_* accumulation + save flow.
const BLOB_STEP = 4_000_000;

async function driveBlobDownload(
  jobId: string,
  blobUrl: string,
  filename: string,
  known?: { size: number; mime: string },
): Promise<void> {
  const fail = (error: string): void => {
    void bgSend({ type: "DOWNLOAD_ERROR", jobId, error });
  };
  try {
    let total = known?.size ?? 0;
    let mime = known?.mime ?? "video/mp4";
    if (total <= 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const info = (await askHook({ __vdg: "blob-info", url: blobUrl }, 8000)) as any;
      if (
        !info ||
        info.__vdg !== "blob-info-result" ||
        typeof info.size !== "number" ||
        info.size <= 0
      ) {
        fail(
          typeof info?.error === "string" ? info.error : "Blob expired — replay the video and Rescan.",
        );
        return;
      }
      total = info.size as number;
      mime = typeof info.type === "string" && info.type ? info.type : "video/mp4";
    }
    await bgSend({ type: "MS_TRACK_START", jobId, total, mime, filename });
    let cursor = 0;
    let index = 0;
    for (;;) {
      if (msAbort.has(jobId)) throw new Error("Download cancelled.");
      if (cursor >= total) break;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = (await askHook({ __vdg: "blob-get", url: blobUrl, cursor, len: BLOB_STEP }, 20000)) as any;
      if (!res || res.__vdg !== "blob-chunk" || res.error) {
        throw new Error(typeof res?.error === "string" ? res.error : "Blob transfer failed.");
      }
      if (res.buf instanceof ArrayBuffer && res.buf.byteLength > 0) {
        await bgSend({ type: "MS_TRACK_CHUNK", jobId, which: 0, index, total, buf: res.buf });
        index++;
      }
      const next = typeof res.next === "number" ? res.next : cursor;
      cursor = next <= cursor ? cursor + (res.buf instanceof ArrayBuffer ? res.buf.byteLength : 0) : next;
      if (res.done || cursor >= total) break;
      if (index > 500) throw new Error("Blob exceeds the transfer cap.");
    }
    await bgSend({ type: "MS_TRACK_END", jobId });
  } catch (err) {
    if (msAbort.has(jobId)) {
      msAbort.delete(jobId);
      fail("Download cancelled.");
    } else {
      fail(err instanceof Error ? err.message : String(err));
    }
  } finally {
    msAbort.delete(jobId);
  }
}

// ---- page-context manifest access ----------------------------------------
// The worker's fetch is a chrome-extension:// request: it cannot present the
// page's Referer/Origin/Sec-Fetch-* headers, its cookie jar, or its network
// fingerprint — and token-gated CDNs answer that with 403/404 even while the
// video plays fine. So we go through the page itself, in two steps:
//   1. reuse the playlist bytes the player already downloaded (no request);
//   2. otherwise have the MAIN world fetch it — a request the CDN has already
//      proven it accepts.

/** Playlist bytes the page's own player already fetched (no network). */
async function pageCapturedManifest(url: string): Promise<string | undefined> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await askHook({ __vdg: "manifest-text", url }, 900)) as any;
    if (
      res?.__vdg === "manifest-text-result" &&
      res.found === true &&
      typeof res.text === "string" &&
      res.text.length > 0
    ) {
      return res.text;
    }
  } catch {
    /* hook absent (older injection, odd frame) — fall through */
  }
  return undefined;
}

/** Fetch from the page's JS world: the request context the site itself uses. */
async function pageWorldFetch(url: string): Promise<{ text: string; truncated: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res = (await askHook({ __vdg: "page-fetch", url }, 13_000)) as any;
  if (res?.__vdg !== "page-fetch-result") throw new Error("Page fetch unavailable on this page.");
  if (!res?.ok) {
    throw new Error(res?.status ? `Page fetch failed (${res.status})` : String(res?.error ?? "Page fetch failed"));
  }
  return { text: String(res.text ?? ""), truncated: res.truncated === true };
}

// ---- frame ownership probes -----------------------------------------------
// A download request reaches every frame of a tab unless the worker knows which
// frame owns the media. These probes let a frame that does NOT own the bytes
// decline instead of reporting a failure for a buffer it never had.

/** Ownership probe timeout: the hook answers from a map, so this is generous. */
const OWNERSHIP_PROBE_MS = 300;

/** Does THIS frame's page hook hold that MSE capture session? */
async function thisFrameOwnsCapture(captureId: string): Promise<boolean> {
  if (!captureId) return false;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await askHook({ __vdg: "ms-sessions" }, OWNERSHIP_PROBE_MS)) as any;
    if (res?.__vdg !== "ms-sessions-result" || !Array.isArray(res.sessions)) return false;
    return (res.sessions as MsSessionMeta[]).some((s) => s?.id === captureId);
  } catch {
    return false;
  }
}

/** Size/type of a Blob THIS frame's hook still holds (undefined when absent). */
async function thisFrameBlob(
  blobUrl: string,
): Promise<{ size: number; mime: string } | undefined> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = (await askHook({ __vdg: "blob-info", url: blobUrl }, OWNERSHIP_PROBE_MS)) as any;
    if (res?.__vdg !== "blob-info-result" || typeof res.size !== "number" || res.size <= 0) {
      return undefined;
    }
    return {
      size: res.size as number,
      mime: typeof res.type === "string" && res.type ? res.type : "video/mp4",
    };
  } catch {
    return undefined;
  }
}

// ---- page-relayed segment bytes -------------------------------------------
// A CDN can refuse the extension's request for a stream chunk while the page
// fetches the same URL fine. When that happens the offscreen document asks the
// worker, the worker asks this tab, and the chunk is fetched by the page's own
// JS world and streamed back to the extension in ≤4MB slices (the same
// broadcast channel the MSE capture uses).

/** Page fetches + transfers this tab should stop (cancel, or tab teardown). */
const pageBytesCancelled = new Set<string>();

/** Fetch one URL in the page's world and stream it to the offscreen document. */
async function drivePageBytes(transferId: string, url: string): Promise<void> {
  const fail = (error: string): void => {
    void bgSend({ type: "PAGE_BYTES_FAILED", transferId, error });
  };
  // The nonce doubles as the page-side buffer token: even if the open times
  // out, we can still close it (which aborts the page's fetch).
  let token = "";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opened = (await askHook({ __vdg: "seg-open", url }, 95_000)) as any;
    token = typeof opened?.token === "string" ? opened.token : String(opened?.nonce ?? "");
    if (opened?.__vdg !== "seg-open-result" || opened.ok !== true) {
      fail(
        String(
          opened?.error ??
            (opened?.status ? `The page was refused (${opened.status}).` : "The page could not fetch this chunk."),
        ),
      );
      return;
    }
    const total = Number(opened.size) || 0;
    if (total <= 0) {
      fail("The page got an empty response.");
      return;
    }
    let cursor = 0;
    let index = 0;
    while (cursor < total) {
      if (dead || pageBytesCancelled.has(transferId)) return; // cancelled
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const slice = (await askHook({ __vdg: "seg-slice", token, cursor }, 25_000)) as any;
      if (slice?.__vdg !== "seg-slice-result" || !(slice.buf instanceof ArrayBuffer)) {
        throw new Error(String(slice?.error ?? "The page stopped sending this chunk."));
      }
      const next = Number(slice.next) || cursor + slice.buf.byteLength;
      index++;
      const sent = await bgSend({
        type: "PAGE_BYTES_CHUNK",
        transferId,
        index,
        total,
        done: next >= total,
        buf: slice.buf,
      });
      if (!sent) throw new Error("The extension worker is gone — reopen the popup and retry.");
      cursor = next;
    }
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  } finally {
    pageBytesCancelled.delete(transferId);
    if (token) void askHook({ __vdg: "seg-close", token }, 1500);
  }
}

// Popup paths + worker helpers. FETCH_TEXT runs with the page's cookie jar,
// so auth-walled manifests unreachable from the worker can still be parsed.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = msg as any;
  if (m?.type === "COLLECT_NOW") {
    if (!dead) {
      try {
        fullScan();
      } catch {
        /* ignore */
      }
      void report(true);
    }
    sendResponse({ ok: true });
    return false;
  }
  // Right-click → "Download this video": report the element's candidate media
  // URLs (best-first) so the worker resolves them against the tab's detected
  // items — the element alone can't name the file on MSE players. Also serves
  // the keyboard shortcut, where there is no cursor: falls back to the most
  // relevant video on the page (playing > largest > first).
  if (m?.type === "CONTEXT_DOWNLOAD") {
    try {
      const v = contextVideo && contextVideo.isConnected ? contextVideo : bestVideoForShortcut();
      if (!v || !v.isConnected) {
        sendResponse({ ok: false, error: "No video on this page." });
        return false;
      }
      const s = signalFrom(v);
      const candidates = Array.from(
        new Set(
          [s?.currentSrc ?? v.currentSrc, ...(s?.candidates ?? [])]
            .map((u) => (typeof u === "string" ? u.trim() : ""))
            .filter((u) => u.length > 0),
        ),
      );
      if (candidates.length === 0) {
        sendResponse({ ok: false, error: "This video exposes no source URL." });
        return false;
      }
      const title = typeof s?.title === "string" && s.title ? s.title : undefined;
      sendResponse({ ok: true, candidates, title });
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    return false;
  }
  if (m?.type === "COLLECT_FOR_POPUP") {
    void (async () => {
      try {
        if (dead) {
          sendResponse({ ok: false, error: "Content script context invalidated — reload the tab." });
          return;
        }
        try {
          fullScan();
        } catch {
          /* ignore */
        }
        lastSessQuery = Date.now();
        const [videos, msSessions, blobs] = await Promise.all([
          Promise.resolve(collect()),
          queryMsSessions(),
          queryBlobs(),
        ]);
        const adapterItems = collectAdapterItems(videos);
        sendResponse({ ok: true, videos, pageTitle: document.title, msSessions, blobs, adapterItems });
      } catch (err) {
        noteDead(err);
        try {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        } catch {
          /* ignore */
        }
      }
    })();
    return true; // async (session query)
  }
  if (m?.type === "MS_DOWNLOAD" && typeof m.jobId === "string") {
    const pair = typeof m.pairTrackIdx === "number" ? m.pairTrackIdx : undefined;
    const captureId = String(m.captureId ?? "");
    const trackIdx = Number(m.trackIdx) || 0;
    void (async () => {
      // Only the frame whose hook holds this capture can serve it. Any other
      // frame declines (no side effects) so the worker walks on to the right
      // one instead of failing a download the page can still complete.
      if (!(await thisFrameOwnsCapture(captureId))) {
        try {
          sendResponse({
            ok: false,
            declined: true,
            error: "Capture expired — the page dropped the player buffer. Replay the video and Rescan.",
          });
        } catch {
          /* ignore */
        }
        return;
      }
      void driveMsDownload(
        m.jobId,
        captureId,
        trackIdx,
        String(m.filename ?? "capture.mp4"),
        pair,
      );
      try {
        sendResponse({ ok: true, accepted: true });
      } catch {
        /* ignore */
      }
    })();
    return true; // async ownership probe
  }
  if (m?.type === "MS_CANCEL" && typeof m.jobId === "string") {
    msAbort.add(m.jobId);
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  if (m?.type === "BLOB_DOWNLOAD" && typeof m.jobId === "string" && typeof m.url === "string") {
    const blobUrl = String(m.url);
    void (async () => {
      // Same ownership rule as captures: the frame holding the Blob answers,
      // the rest decline so the worker can find it.
      const info = await thisFrameBlob(blobUrl);
      if (!info) {
        try {
          sendResponse({
            ok: false,
            declined: true,
            error: "Blob expired — replay the video and Rescan.",
          });
        } catch {
          /* ignore */
        }
        return;
      }
      void driveBlobDownload(m.jobId, blobUrl, String(m.filename ?? "video.mp4"), info);
      try {
        sendResponse({ ok: true, accepted: true });
      } catch {
        /* ignore */
      }
    })();
    return true; // async ownership probe
  }
  if (m?.type === "PAGE_BYTES_CANCEL" && typeof m.transferId === "string") {
    pageBytesCancelled.add(m.transferId);
    try {
      sendResponse({ ok: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  if (m?.type === "PAGE_FETCH_BYTES" && typeof m.url === "string" && typeof m.transferId === "string") {
    void drivePageBytes(String(m.transferId), String(m.url));
    try {
      sendResponse({ ok: true, accepted: true });
    } catch {
      /* ignore */
    }
    return false;
  }
  if (m?.type === "FETCH_TEXT" && typeof m.url === "string") {
    void (async () => {
      const url = String(m.url);
      const reply = (payload: object): void => {
        try {
          sendResponse(payload);
        } catch {
          /* popup gone */
        }
      };
      const ok = (text: string, source: string): void => {
        if (text.length > MAX_FETCH_BYTES) reply({ ok: true, text: "", truncated: true });
        else reply({ ok: true, text, source });
      };
      try {
        // 1. The player already loaded this playlist — reuse those exact bytes.
        const captured = await pageCapturedManifest(url);
        if (captured !== undefined) {
          ok(captured, "page-capture");
          return;
        }
        if (m.captureOnly === true) {
          // Cheap probe: the worker asks this first because it costs no
          // network at all when the player has the playlist in hand.
          reply({ ok: false, error: "No captured copy in the page." });
          return;
        }
        // 2. Page-world fetch: the site's own request context (cookies,
        //    Referer, Origin, Sec-Fetch-*, fingerprint).
        try {
          const page = await pageWorldFetch(url);
          if (page.truncated) {
            reply({ ok: false, error: "Manifest too large to parse (>5 MB)." });
            return;
          }
          ok(page.text, "page-world");
          return;
        } catch (pageErr) {
          // 3. Isolated-world fetch (extension-origin request, host permission):
          //    weaker context, but occasionally the only thing that works.
          try {
            const res = await fetch(url, { credentials: "include" });
            if (!res.ok) throw new Error(`Page fetch failed (${res.status})`);
            ok(await res.text(), "page-isolated");
            return;
          } catch (isolatedErr) {
            throw new Error(
              pageErr instanceof Error && pageErr.message
                ? `${pageErr.message}; ${isolatedErr instanceof Error ? isolatedErr.message : String(isolatedErr)}`
                : isolatedErr instanceof Error
                  ? isolatedErr.message
                  : String(isolatedErr),
            );
          }
        }
      } catch (err) {
        noteDead(err);
        try {
          sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
        } catch {
          /* ignore */
        }
      }
    })();
    return true; // async response
  }
  return false;
});
