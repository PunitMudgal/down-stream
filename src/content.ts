import type { MsSessionMeta, VideoSignal } from "./lib/types";

const MAX_FETCH_BYTES = 5_000_000;

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

/** Find <video> even inside shadow DOM and same-origin iframes' documents. */
function allVideos(root: Document | ShadowRoot): HTMLVideoElement[] {
  const out: HTMLVideoElement[] = [];
  const walk = (node: Document | ShadowRoot | Element): void => {
    const vids =
      node instanceof Document || node instanceof ShadowRoot
        ? node.querySelectorAll("video")
        : node.tagName === "VIDEO"
          ? [node as HTMLVideoElement]
          : node.querySelectorAll("video");
    vids.forEach((v) => out.push(v as HTMLVideoElement));
    const els =
      node instanceof Document || node instanceof ShadowRoot
        ? node.querySelectorAll("*")
        : node.querySelectorAll("*");
    els.forEach((el) => {
      const shadow = (el as HTMLElement).shadowRoot;
      if (shadow) walk(shadow);
    });
  };
  walk(root);
  // Same-origin iframes (cross-origin ones are opaque to us).
  try {
    Array.from(document.querySelectorAll("iframe")).forEach((frame) => {
      try {
        const doc = frame.contentDocument;
        if (doc) out.push(...allVideos(doc));
      } catch {
        /* cross-origin iframe — skip */
      }
    });
  } catch {
    /* ignore */
  }
  return out;
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
  const poster = el.poster || findPoster(el) || undefined;
  const title = findTitle(el) || undefined;
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
        const t = cleanSnippet((c as HTMLElement).innerText || c.textContent);
        if (t) return t;
      }
      // Headings/named blocks only close to the player (avoids site chrome).
      if (level < 3) {
        const near = node.querySelectorAll("h1, h2, h3, [class*=\"video-title\" i], [class*=\"media-title\" i]");
        for (const c of Array.from(near)) {
          const t = cleanSnippet((c as HTMLElement).innerText || c.textContent, 100);
          if (t) return t;
        }
      }
    }
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
  } catch {
    /* ignore */
  }
  return null;
}

function collect(): VideoSignal[] {
  try {
    return allVideos(document)
      .map(signalFrom)
      .filter((s): s is VideoSignal => s !== null);
  } catch {
    return [];
  }
}

let lastSent = "";
function report(force = false): void {
  void (async () => {
    try {
      const videos = collect();
      const sessions = await queryMsSessions();
      // Session bytes rounded to MB: reports refresh as captures grow,
      // without spamming on every appended chunk.
      const sessKey = sessions
        .map((s) => `${s.id}:${Math.floor(s.bytes / 1_000_000)}:${s.tracks.length}`)
        .join(",");
      const key =
        JSON.stringify(videos.map((v) => [v.currentSrc, v.poster, v.paused, v.title])) + "|" + sessKey;
      if (!force && (key === lastSent || (videos.length === 0 && sessions.length === 0))) return;
      lastSent = key;
      await chrome.runtime.sendMessage({
        type: "VIDEO_ELEMENTS",
        tabId: -1, // background resolves the real tab via sender.tab
        videos,
        pageTitle: document.title,
        msSessions: sessions,
      });
    } catch {
      /* extension context may be unavailable — enrichment is best-effort */
    }
  })();
}

// Initial sweep (force: even an empty page state is worth one report for posters).
report(true);

// Continuous watch for SPA feeds (X/Twitter timeline, infinite scroll):
// players mount <video> nodes and swap src/blob URLs long after load.
let pending = false;
const observer = new MutationObserver(() => {
  if (pending) return;
  pending = true;
  setTimeout(() => {
    pending = false;
    report();
  }, 1500);
});
try {
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "poster"],
    });
  }
} catch {
  /* ignore */
}

// Report the moment anything starts playing (covers players that only set
// a real URL on play, and refreshes paused/playing + duration metadata).
document.addEventListener("play", () => report(), true);
document.addEventListener("loadedmetadata", () => report(), true);

// Findings from the MAIN-world API hook (fetch/XHR responses embedding
// manifest URLs). Only extracted URL strings ever cross into the extension.
window.addEventListener("message", (event) => {
  try {
    if (event.source !== window) return;
    const d = event.data as { __vdg?: unknown; urls?: unknown; pairs?: unknown } | null;
    if (!d || typeof d !== "object") return;
    if (d.__vdg === "manifest-urls" && Array.isArray(d.urls)) {
      const urls = (d.urls as unknown[]).filter((u): u is string => typeof u === "string").slice(0, 30);
      if (!urls.length) return;
      void chrome.runtime.sendMessage({
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
      void chrome.runtime.sendMessage({
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
    try {
      void chrome.runtime
        .sendMessage({ type: "DOWNLOAD_ERROR", jobId, error })
        .catch(() => undefined);
    } catch {
      /* ignore */
    }
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
        await chrome.runtime.sendMessage({
          type: "MS_TRACK_CHUNK",
          jobId,
          which,
          index,
          total: track.bytes,
          buf: res.buf,
        });
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
    await chrome.runtime.sendMessage({
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
    await chrome.runtime.sendMessage({ type: "MS_TRACK_END", jobId });
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

// Popup paths + worker helpers. FETCH_TEXT runs with the page's cookie jar,
// so auth-walled manifests unreachable from the worker can still be parsed.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = msg as any;
  if (m?.type === "COLLECT_NOW") {
    report(true);
    sendResponse({ ok: true });
    return false;
  }
  if (m?.type === "COLLECT_FOR_POPUP") {
    void (async () => {
      try {
        const [videos, msSessions] = await Promise.all([
          Promise.resolve(collect()),
          queryMsSessions(),
        ]);
        sendResponse({ ok: true, videos, pageTitle: document.title, msSessions });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true; // async (session query)
  }
  if (m?.type === "MS_DOWNLOAD" && typeof m.jobId === "string") {
    const pair = typeof m.pairTrackIdx === "number" ? m.pairTrackIdx : undefined;
    void driveMsDownload(m.jobId, String(m.captureId ?? ""), Number(m.trackIdx) || 0, String(m.filename ?? "capture.mp4"), pair);
    try {
      sendResponse({ ok: true, accepted: true });
    } catch {
      /* ignore */
    }
    return false;
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
  if (m?.type === "FETCH_TEXT" && typeof m.url === "string") {
    void (async () => {
      try {
        const res = await fetch(m.url, { credentials: "include" });
        if (!res.ok) {
          sendResponse({ ok: false, error: `Page fetch failed (${res.status})` });
          return;
        }
        const text = await res.text();
        if (text.length > MAX_FETCH_BYTES) {
          sendResponse({ ok: true, text: "", truncated: true });
          return;
        }
        sendResponse({ ok: true, text });
      } catch (err) {
        sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true; // async response
  }
  return false;
});
