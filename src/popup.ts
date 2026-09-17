import {
  downloadDirect,
  downloadHlsVariant,
  downloadDashVariant,
  filenameForUrl,
  sanitizeFilename,
} from "./lib/download";
import type { MediaItem } from "./lib/types";

const listEl = document.getElementById("list") as HTMLElement;
const statusEl = document.getElementById("status") as HTMLElement;
const rescanBtn = document.getElementById("rescan") as HTMLButtonElement;

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

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function loadMedia(): Promise<void> {
  setStatus("Scanning…");
  listEl.innerHTML = "";
  const tabId = await activeTabId();
  if (tabId == null) {
    setStatus("No active tab found.");
    return;
  }
  let items: MediaItem[] = [];
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_MEDIA", tabId });
    items = res?.items ?? [];
  } catch (err) {
    setStatus(`Could not reach background worker: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  if (items.length === 0) {
    setStatus("");
    const div = document.createElement("div");
    div.className = "empty";
    div.textContent = "No video detected yet. Play the video, then reopen this popup.";
    listEl.appendChild(div);
    return;
  }
  setStatus(`${items.length} video${items.length > 1 ? "s" : ""} detected.`);
  for (const item of items) listEl.appendChild(renderCard(item));
}

function renderCard(item: MediaItem): HTMLElement {
  const card = document.createElement("div");
  card.className = "card";

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
    btn.onclick = () => void handleDirect(item, btn, meta);
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
        opt.value = String(i);
        opt.textContent = variantLabel(v, i);
        sel.appendChild(opt);
      });
      meta.appendChild(sel);

      const btn = document.createElement("button");
      btn.className = "dl";
      btn.textContent = "Download variant";
      btn.onclick = () => void handleStreaming(item, sel, btn, meta);
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
  return card;
}

function isDirect(item: MediaItem): boolean {
  return ["mp4", "webm", "ogg", "mov"].includes(item.type);
}

function progressInto(meta: HTMLElement) {
  return (done: number, total: number) => {
    const el = meta.querySelector(".progress") as HTMLElement | null;
    if (el) {
      el.hidden = false;
      el.textContent = `Downloading… ${done}/${total} segments`;
    }
  };
}

async function handleDirect(item: MediaItem, btn: HTMLButtonElement, meta: HTMLElement): Promise<void> {
  btn.disabled = true;
  try {
    await downloadDirect(item.url, item.filename || filenameForUrl(item.url, item.type));
    setStatus("Download started.");
  } catch (err) {
    setStatus(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    btn.disabled = false;
  }
  void meta;
}

async function handleStreaming(
  item: MediaItem,
  sel: HTMLSelectElement,
  btn: HTMLButtonElement,
  meta: HTMLElement,
): Promise<void> {
  const variant = item.variants?.[Number(sel.value)];
  if (!variant) {
    setStatus("No variant selected.");
    return;
  }
  btn.disabled = true;
  const onProgress = progressInto(meta);
  try {
    if (item.type === "hls") {
      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const base = sanitizeFilename(item.filename.replace(/\.[a-z0-9]+$/i, ""), `hls-video-${ts}`);
      await downloadHlsVariant(variant.url, `${base}.ts`, onProgress);
    } else {
      await downloadDashVariant(variant.segments ?? [], item.filename || filenameForUrl(item.url, item.type), onProgress);
    }
    setStatus("Download started.");
  } catch (err) {
    setStatus(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    btn.disabled = false;
  }
}

rescanBtn.onclick = () => {
  void (async () => {
    setStatus("Rescanning…");
    const tabId = await activeTabId();
    if (tabId == null) {
      setStatus("No active tab found.");
      return;
    }
    try {
      await chrome.runtime.sendMessage({ type: "RESCAN", tabId });
      // Give the content script a moment to report back, then reload list.
      setTimeout(() => void loadMedia(), 800);
    } catch (err) {
      setStatus(`Rescan failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
};

void loadMedia();
