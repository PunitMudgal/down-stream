import { filenameForUrl } from "./lib/download";
import type { DownloadJobState, MediaItem } from "./lib/types";

const listEl = document.getElementById("list") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const rescanBtn = document.getElementById("rescan") as HTMLButtonElement;

let currentTabId: number | null = null;
let currentHost = "";
let jobs: DownloadJobState[] = [];

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 40 ? "…" + u.pathname.slice(-39) : u.pathname;
    return u.host + path;
  } catch {
    return url.slice(0, 60);
  }
}

function variantLabel(v: { resolution?: string; bandwidth?: number; codecs?: string }, idx: number): string {
  const parts: string[] = [];
  if (v.resolution) {
    // "1920x1080" -> "1080p"
    const m = /(\d+)x(\d+)/.exec(v.resolution);
    parts.push(m ? `${m[2]}p` : v.resolution);
  } else {
    parts.push(`Variant ${idx + 1}`);
  }
  if (v.bandwidth) parts.push(`— ${(v.bandwidth / 1_000_000).toFixed(1)} Mbps`);
  return parts.join(" ");
}

function setStatus(msg: string): void {
  statusEl.textContent = msg;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out — the background worker may be restarting. Reopen the popup.`)), ms),
    ),
  ]);
}

async function activeTab(): Promise<{ id: number | null; host: string }> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try {
    if (tab?.url) host = new URL(tab.url).host;
  } catch {
    /* ignore */
  }
  return { id: tab?.id ?? null, host };
}

function jobForItem(itemUrl: string): DownloadJobState | undefined {
  const related = jobs.filter((j) => j.itemUrl === itemUrl);
  return related.sort((a, b) => b.updatedAt - a.updatedAt)[0];
}

async function loadMedia(): Promise<void> {
  setStatus("Scanning…");
  listEl.innerHTML = "";
  jobs = [];
  try {
    const { id, host } = await withTimeout(activeTab(), 5000, "Finding active tab");
    currentTabId = id;
    currentHost = host;
    if (id == null) {
      setStatus("No active tab found.");
      return;
    }
    const [mediaRes, jobsRes] = await withTimeout(
      Promise.all([
        chrome.runtime.sendMessage({ type: "GET_MEDIA", tabId: id }),
        chrome.runtime.sendMessage({ type: "GET_JOBS", tabId: id }),
      ]),
      8000,
      "Reading detections",
    );
    const items: MediaItem[] = mediaRes?.items ?? [];
    jobs = jobsRes?.jobs ?? [];

    if (items.length === 0) {
      setStatus("");
      const div = document.createElement("div");
      div.className = "empty";
      div.textContent = currentHost
        ? `No video detected on ${currentHost} yet. Play the video, then hit Rescan.`
        : "No video detected yet. Play the video, then hit Rescan.";
      listEl.appendChild(div);
      return;
    }
    const downloadable = items.filter((x) => x.type !== "blob").length;
    setStatus(
      downloadable > 0
        ? `${downloadable} downloadable video${downloadable > 1 ? "s" : ""} detected.`
        : "Found player streams, but no direct file yet — play the video, then Rescan.",
    );
    for (const item of items) listEl.appendChild(renderCard(item));
  } catch (err) {
    // Never leave the UI stuck on "Scanning…".
    setStatus(err instanceof Error ? err.message : String(err));
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "Could not load detections. Close and reopen the popup, or reload the extension.";
    listEl.appendChild(div);
  }
}

function renderCard(item: MediaItem): HTMLElement {
  const card = document.createElement("div");
  card.className = "card";
  card.dataset.itemUrl = item.url;

  if (item.poster) {
    const img = document.createElement("img");
    img.className = "thumb";
    img.src = item.poster;
    img.alt = "";
    card.appendChild(img);
  } else {
    const fb = document.createElement("div");
    fb.className = "thumb-fallback";
    fb.textContent = "▶";
    card.appendChild(fb);
  }

  const meta = document.createElement("div");
  meta.className = "meta";

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = item.type.toUpperCase();
  meta.appendChild(badge);

  const urlDiv = document.createElement("div");
  urlDiv.className = "url";
  urlDiv.textContent = shortUrl(item.url);
  urlDiv.title = item.url;
  meta.appendChild(urlDiv);

  if (item.error && !item.variants?.length && !isDirect(item)) {
    const e = document.createElement("div");
    e.className = "error";
    e.textContent = item.error;
    meta.appendChild(e);
  }

  if (item.drmProtected) {
    const p = document.createElement("div");
    p.className = "protected";
    p.textContent = item.drmReason ?? "Protected content — cannot download.";
    meta.appendChild(p);
  } else if (isDirect(item)) {
    const btn = document.createElement("button");
    btn.className = "dl";
    btn.textContent = "Download";
    btn.onclick = () => void handleStartDownload(item, undefined, btn);
    meta.appendChild(btn);
  } else if (item.type === "hls" || item.type === "dash") {
    if (!item.variants || item.variants.length === 0) {
      const note = document.createElement("div");
      note.className = "error";
      note.textContent = item.error ?? "Parsing manifest… reopen popup in a moment.";
      meta.appendChild(note);
    } else {
      const sel = document.createElement("select");
      item.variants.forEach((v, i) => {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = variantLabel(v, i);
        sel.appendChild(opt);
      });
      const existing = jobForItem(item.url);
      if (existing?.variantId) {
        const idx = item.variants.findIndex((v) => v.id === existing.variantId);
        if (idx >= 0) sel.selectedIndex = idx;
      }
      meta.appendChild(sel);

      const btn = document.createElement("button");
      btn.className = "dl";
      btn.textContent = "Download variant";
      btn.onclick = () => void handleStartDownload(item, sel.value, btn);
      meta.appendChild(btn);
    }
  } else if (item.type === "blob") {
    const note = document.createElement("div");
    note.className = "error";
    note.textContent = item.error ?? "Blob stream — not directly downloadable.";
    meta.appendChild(note);
  }

  const prog = document.createElement("div");
  prog.className = "progress";
  prog.hidden = true;
  meta.appendChild(prog);

  card.appendChild(meta);
  paintJobState(card, item);
  return card;
}

function isDirect(item: MediaItem): boolean {
  return ["mp4", "webm", "ogg", "mov"].includes(item.type);
}

/** Reflect the latest known job for this item (survives popup reopen). */
function paintJobState(card: HTMLElement, item: MediaItem): void {
  const prog = card.querySelector(".progress") as HTMLElement | null;
  const btn = card.querySelector("button.dl") as HTMLButtonElement | null;
  if (!prog || !btn) return;
  const job = jobForItem(item.url);
  if (!job) {
    prog.hidden = true;
    btn.disabled = false;
    return;
  }
  if (job.status === "running") {
    btn.disabled = true;
    prog.hidden = false;
    prog.textContent =
      job.total > 1
        ? `Downloading… ${job.done}/${job.total} segments (safe to close popup)`
        : "Downloading… (safe to close popup)";
  } else if (job.status === "done") {
    btn.disabled = false;
    btn.textContent = isDirect(item) ? "Download again" : "Download variant again";
    prog.hidden = false;
    prog.textContent = "Done — check your downloads folder.";
  } else {
    btn.disabled = false;
    prog.hidden = false;
    prog.textContent = `Failed: ${job.error ?? "unknown error"}`;
  }
}

function refreshCard(itemUrl: string): void {
  const card = listEl.querySelector(`[data-item-url="${CSS.escape(itemUrl)}"]`) as HTMLElement | null;
  if (!card) return;
  // Re-resolve the item from the rendered card's context is complex;
  // instead patch the progress/button in place using a lightweight lookup.
  const prog = card.querySelector(".progress") as HTMLElement | null;
  const btn = card.querySelector("button.dl") as HTMLButtonElement | null;
  if (!prog || !btn) return;
  const job = jobForItem(itemUrl);
  if (!job) return;
  const badge = card.querySelector(".badge")?.textContent ?? "";
  const direct = ["MP4", "WEBM", "OGG", "MOV"].includes(badge);
  if (job.status === "running") {
    btn.disabled = true;
    prog.hidden = false;
    prog.textContent =
      job.total > 1
        ? `Downloading… ${job.done}/${job.total} segments (safe to close popup)`
        : "Downloading… (safe to close popup)";
  } else if (job.status === "done") {
    btn.disabled = false;
    btn.textContent = direct ? "Download again" : "Download variant again";
    prog.hidden = false;
    prog.textContent = "Done — check your downloads folder.";
  } else {
    btn.disabled = false;
    prog.hidden = false;
    prog.textContent = `Failed: ${job.error ?? "unknown error"}`;
  }
}

async function handleStartDownload(
  item: MediaItem,
  variantId: string | undefined,
  btn: HTMLButtonElement,
): Promise<void> {
  if (currentTabId == null) {
    setStatus("No active tab found.");
    return;
  }
  btn.disabled = true;
  try {
    const res = await withTimeout(
      chrome.runtime.sendMessage({
        type: "START_DOWNLOAD",
        tabId: currentTabId,
        itemUrl: item.url,
        variantId,
      }),
      15000,
      "Starting download",
    );
    if (!res?.ok) {
      setStatus(`Download failed: ${res?.error ?? "unknown error"}`);
      btn.disabled = false;
      return;
    }
    const job = res.job as DownloadJobState;
    jobs = [job, ...jobs.filter((j) => j.jobId !== job.jobId)];
    if (item.type === "hls" || item.type === "dash") {
      setStatus(`Download running in background for ${item.filename || filenameForUrl(item.url, item.type)} — you can close this popup.`);
    } else {
      setStatus("Download started.");
    }
    refreshCard(item.url);
  } catch (err) {
    setStatus(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    btn.disabled = false;
  }
}

// Live updates while the popup stays open (optional — state persists regardless).
chrome.runtime.onMessage.addListener((msg) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = msg as any;
  if (m?.type === "JOB_UPDATED" && m.job) {
    const job = m.job as DownloadJobState;
    jobs = [job, ...jobs.filter((j) => j.jobId !== job.jobId)];
    refreshCard(job.itemUrl);
  }
  return false;
});

rescanBtn.onclick = () => {
  void (async () => {
    setStatus("Rescanning…");
    if (currentTabId == null) {
      const t = await activeTab();
      currentTabId = t.id;
      currentHost = t.host;
    }
    if (currentTabId == null) {
      setStatus("No active tab found.");
      return;
    }
    try {
      await withTimeout(
        chrome.runtime.sendMessage({ type: "RESCAN", tabId: currentTabId }),
        8000,
        "Rescan",
      );
      // Give the content script a moment to report back, then reload list.
      setTimeout(() => void loadMedia(), 900);
    } catch (err) {
      setStatus(`Rescan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
};

void loadMedia();
