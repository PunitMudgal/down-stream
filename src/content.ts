import type { VideoSignal } from "./lib/types";

function collect(): VideoSignal[] {
  return Array.from(document.querySelectorAll("video")).map((v) => ({
    currentSrc: v.currentSrc || v.src || "",
    poster: v.poster || undefined,
    duration: Number.isFinite(v.duration) ? v.duration : undefined,
    paused: v.paused,
    width: v.videoWidth || undefined,
    height: v.videoHeight || undefined,
  }));
}

function report(): void {
  try {
    const videos = collect();
    if (videos.length === 0) return;
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

// Initial sweep + re-sweep as players mount <video> late.
report();
let sweeps = 0;
const timer = setInterval(() => {
  report();
  if (++sweeps >= 5) clearInterval(timer);
}, 3000);

// Popup "Rescan page" path.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((msg as any)?.type === "COLLECT_NOW") {
    report();
    sendResponse({ ok: true });
  }
  return false;
});
