import type { VideoSignal } from "./lib/types";

const MAX_FETCH_BYTES = 5_000_000;

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
  try {
    const videos = collect();
    const key = JSON.stringify(videos.map((v) => [v.currentSrc, v.poster, v.paused]));
    if (!force && (key === lastSent || videos.length === 0)) return;
    lastSent = key;
    void chrome.runtime.sendMessage({
      type: "VIDEO_ELEMENTS",
      tabId: -1, // background resolves the real tab via sender.tab
      videos,
      pageTitle: document.title,
    });
  } catch {
    /* extension context may be unavailable — enrichment is best-effort */
  }
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
    try {
      sendResponse({ ok: true, videos: collect(), pageTitle: document.title });
    } catch (err) {
      sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) });
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
