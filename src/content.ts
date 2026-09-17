import type { VideoSignal } from "./lib/types";

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

function collect(): VideoSignal[] {
  return Array.from(document.querySelectorAll("video")).flatMap((v) => {
    const candidates: string[] = [];
    if (v.currentSrc) candidates.push(v.currentSrc);
    const srcAttr = absolutize(v.getAttribute("src"));
    if (srcAttr && !candidates.includes(srcAttr)) candidates.push(srcAttr);
    v.querySelectorAll("source[src]").forEach((n) => {
      const u = absolutize(n.getAttribute("src"));
      if (u && !candidates.includes(u)) candidates.push(u);
    });
    // Some players stash the file URL on data-* attributes.
    for (const attr of ["data-src", "data-url", "data-video-url", "data-source"]) {
      const u = absolutize(v.getAttribute(attr));
      if (u && !candidates.includes(u)) candidates.push(u);
    }
    if (candidates.length === 0 && !v.poster) return [];
    return [
      {
        currentSrc: candidates[0] ?? "",
        candidates,
        poster: v.poster || undefined,
        duration: Number.isFinite(v.duration) ? v.duration : undefined,
        paused: v.paused,
        width: v.videoWidth || undefined,
        height: v.videoHeight || undefined,
      },
    ];
  });
}

let lastSent = "";
function report(force = false): void {
  try {
    const videos = collect();
    const key = JSON.stringify(videos.map((v) => [v.currentSrc, v.poster]));
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
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ["src", "poster"],
});

// Popup "Rescan page" path.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((msg as any)?.type === "COLLECT_NOW") {
    report(true);
    sendResponse({ ok: true });
  }
  return false;
});
