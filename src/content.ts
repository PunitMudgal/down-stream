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
  if (candidates.length === 0 && !el.poster) return null;
  return {
    currentSrc: candidates[0] ?? "",
    candidates,
    poster: el.poster || undefined,
    duration: Number.isFinite(el.duration) ? el.duration : undefined,
    paused: el.paused,
    width: el.videoWidth || undefined,
    height: el.videoHeight || undefined,
  };
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
      const key = JSON.stringify(videos.map((v) => [v.currentSrc, v.poster, v.paused])) + "|" + sessKey;
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
    const d = event.data as { __vdg?: unknown; urls?: unknown } | null;
    if (!d || d.__vdg !== "manifest-urls" || !Array.isArray(d.urls)) return;
    const urls = (d.urls as unknown[]).filter((u): u is string => typeof u === "string").slice(0, 30);
    if (!urls.length) return;
    void chrome.runtime.sendMessage({
      type: "VIDEO_ELEMENTS",
      tabId: -1, // background resolves the real tab via sender.tab
      videos: urls.map((u) => ({ currentSrc: u, candidates: [u] })),
      pageTitle: document.title,
    });
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
  try {
    const sessions = await queryMsSessions();
    const session = sessions.find((s) => s.id === captureId);
    const track = session?.tracks[trackIdx];
    if (!session || !track) {
      fail("Capture expired — the page dropped the player buffer. Replay the video and Rescan.");
      return;
    }
    if (track.bytes <= 0) {
      fail("Capture is empty — let the video play longer, then retry.");
      return;
    }
    await chrome.runtime.sendMessage({
      type: "MS_TRACK_START",
      jobId,
      total: track.bytes,
      mime: track.mime,
      filename,
    });
    let cursor = 0;
    let index = 0;
    for (;;) {
      if (msAbort.has(jobId)) {
        msAbort.delete(jobId);
        fail("Download cancelled.");
        return;
      }
      if (cursor > MS_TRANSFER_CAP) {
        fail("Capture exceeds the 500 MB safety cap.");
        return;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const res = (await askHook(
        { __vdg: "ms-get", id: captureId, track: trackIdx, cursor },
        20000,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      )) as any;
      if (!res || res.__vdg !== "ms-chunk" || res.error) {
        fail(typeof res?.error === "string" ? res.error : "Capture transfer failed.");
        return;
      }
      if (res.buf instanceof ArrayBuffer && res.buf.byteLength > 0) {
        await chrome.runtime.sendMessage({
          type: "MS_TRACK_CHUNK",
          jobId,
          index,
          total: track.bytes,
          buf: res.buf,
        });
        index++;
      }
      cursor = typeof res.next === "number" ? res.next : cursor;
      if (res.done) break;
    }
    await chrome.runtime.sendMessage({ type: "MS_TRACK_END", jobId });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
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
    void driveMsDownload(m.jobId, String(m.captureId ?? ""), Number(m.trackIdx) || 0, String(m.filename ?? "capture.mp4"));
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
