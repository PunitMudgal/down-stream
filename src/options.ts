/**
 * Options page: filename/subfolder settings with a live preview, plus the
 * download history with one-click re-download.
 *
 * The page talks to storage directly (settings + history live in
 * `chrome.storage.local`) and only calls the background worker for things that
 * need it — re-downloading, which must re-resolve fresh signed URLs.
 */
import { basenameOf, joinDownloadPath, renderFilename, TEMPLATE_PLACEHOLDERS } from "./lib/filename";
import { formatBytes, formatWhen } from "./lib/format";
import { clearHistory, loadHistory, type HistoryEntry } from "./lib/history";
import { DEFAULT_SETTINGS, getSettings, normalizeSettings, saveSettings, type Settings } from "./lib/settings";

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

const tabSettings = el<HTMLButtonElement>("tab-settings");
const tabHistory = el<HTMLButtonElement>("tab-history");
const panelSettings = el<HTMLElement>("panel-settings");
const panelHistory = el<HTMLElement>("panel-history");

const templateInput = el<HTMLInputElement>("template");
const subfolderInput = el<HTMLInputElement>("subfolder");
const notifyInput = el<HTMLInputElement>("notify");
const concurrencyInput = el<HTMLInputElement>("concurrency");
const templatePreview = el<HTMLElement>("template-preview");
const pathPreview = el<HTMLElement>("path-preview");
const settingsStatus = el<HTMLElement>("settings-status");
const resetButton = el<HTMLButtonElement>("reset");

const historyCount = el<HTMLElement>("history-count");
const historyRefresh = el<HTMLButtonElement>("history-refresh");
const historyClear = el<HTMLButtonElement>("history-clear");
const historyStatus = el<HTMLElement>("history-status");
const historyList = el<HTMLElement>("history-list");

/** Sample metadata so the preview shows exactly what a real save would look like. */
const SAMPLE = {
  title: "How to bake bread",
  quality: "1080p",
  ext: "mp4",
  host: "video.example.com",
  type: "hls",
} as const;

function currentSettings(): Settings {
  return normalizeSettings({
    filenameTemplate: templateInput.value,
    subfolder: subfolderInput.value,
    notifyOnComplete: notifyInput.checked,
    batchConcurrency: Number(concurrencyInput.value),
  });
}

function previewName(settings: Settings): string {
  if (!settings.filenameTemplate) return `${SAMPLE.title}.${SAMPLE.ext}`;
  return renderFilename(settings.filenameTemplate, { ...SAMPLE }, SAMPLE.title);
}

function renderPreviews(settings: Settings): void {
  const name = previewName(settings);
  templatePreview.innerHTML = "";
  templatePreview.append(document.createTextNode("Name: "));
  const nameCode = document.createElement("code");
  nameCode.textContent = name;
  templatePreview.append(nameCode);

  pathPreview.innerHTML = "";
  pathPreview.append(document.createTextNode("Saved to: "));
  const pathCode = document.createElement("code");
  pathCode.textContent = joinDownloadPath(settings.subfolder, name);
  pathPreview.append(pathCode);
}

/** Placeholder chips insert their token at the caret — no docs to memorise. */
function buildPlaceholderChips(): void {
  const row = document.createElement("div");
  row.className = "chips";
  for (const name of TEMPLATE_PLACEHOLDERS) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "linkish";
    chip.textContent = `{${name}}`;
    chip.title = `Insert {${name}}`;
    chip.onclick = () => {
      const start = templateInput.selectionStart ?? templateInput.value.length;
      const end = templateInput.selectionEnd ?? start;
      const token = `{${name}}`;
      templateInput.value =
        templateInput.value.slice(0, start) + token + templateInput.value.slice(end);
      templateInput.focus();
      templateInput.setSelectionRange(start + token.length, start + token.length);
      scheduleSave();
    };
    row.appendChild(chip);
  }
  templatePreview.after(row);
}

let saveTimer: number | undefined;
let statusTimer: number | undefined;

function showSettingsStatus(text: string, isError = false): void {
  settingsStatus.textContent = text;
  settingsStatus.classList.toggle("error", isError);
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => {
    settingsStatus.textContent = "";
  }, 2200);
}

function scheduleSave(): void {
  renderPreviews(currentSettings());
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void persistSettings(), 400);
}

async function persistSettings(): Promise<void> {
  try {
    const saved = await saveSettings({
      filenameTemplate: templateInput.value,
      subfolder: subfolderInput.value,
      notifyOnComplete: notifyInput.checked,
      batchConcurrency: Number(concurrencyInput.value),
    });
    // Reflect normalized values without fighting the user's caret: only the
    // numeric clamp is written back live.
    if (concurrencyInput.value !== String(saved.batchConcurrency) && document.activeElement !== concurrencyInput) {
      concurrencyInput.value = String(saved.batchConcurrency);
    }
    renderPreviews(saved);
    showSettingsStatus("Saved");
  } catch {
    showSettingsStatus("Could not save settings.", true);
  }
}

function populate(settings: Settings): void {
  templateInput.value = settings.filenameTemplate;
  subfolderInput.value = settings.subfolder;
  notifyInput.checked = settings.notifyOnComplete;
  concurrencyInput.value = String(settings.batchConcurrency);
  renderPreviews(settings);
}

// ---- history --------------------------------------------------------------

let historyRefreshTimer: number | undefined;

function scheduleHistoryRefresh(delay = 300): void {
  window.clearTimeout(historyRefreshTimer);
  historyRefreshTimer = window.setTimeout(() => void refreshHistory(), delay);
}

function showHistoryStatus(text: string, isError = false): void {
  historyStatus.textContent = text;
  historyStatus.classList.toggle("error", isError);
}

function metaChip(text: string, kind: "done" | "error" | "cancelled"): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `chip ${kind}`;
  chip.textContent = text;
  return chip;
}

function renderEntry(entry: HistoryEntry): HTMLElement {
  const item = document.createElement("div");
  item.className = "history-item";
  item.dataset.status = entry.status;

  const main = document.createElement("div");
  main.className = "history-main";

  const title = document.createElement("div");
  title.className = "history-title";
  title.textContent = entry.title || basenameOf(entry.filename) || "Video";
  main.appendChild(title);

  const file = document.createElement("div");
  file.className = "history-file";
  file.textContent = entry.filename || "(no file name)";
  file.title = entry.filename;
  main.appendChild(file);

  const meta = document.createElement("div");
  meta.className = "history-meta";
  const label = entry.status === "done" ? "Done" : entry.status === "cancelled" ? "Cancelled" : "Failed";
  meta.appendChild(metaChip(label, entry.status));
  if (entry.quality) meta.appendChild(metaChip(entry.quality, entry.status));
  if (entry.type) meta.appendChild(metaChip(entry.type, entry.status));
  const when = formatWhen(entry.at);
  if (when) {
    const span = document.createElement("span");
    span.textContent = when;
    meta.appendChild(span);
  }
  if (entry.bytes) {
    const span = document.createElement("span");
    span.textContent = formatBytes(entry.bytes);
    meta.appendChild(span);
  }
  main.appendChild(meta);

  if (entry.status !== "done" && entry.error) {
    const err = document.createElement("div");
    err.className = "history-file";
    err.style.color = "var(--danger)";
    err.textContent = entry.error;
    main.appendChild(err);
  }
  item.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "history-actions-col";

  const redl = document.createElement("button");
  redl.type = "button";
  redl.className = "linkish";
  redl.textContent = "Re-download";
  redl.title = "Fetch this video again, re-resolving fresh links";
  redl.onclick = () => void redownload(entry, redl);
  actions.appendChild(redl);

  if (typeof entry.downloadId === "number") {
    const show = document.createElement("button");
    show.type = "button";
    show.className = "linkish";
    show.textContent = "Show in folder";
    show.onclick = () => {
      void (async () => {
        try {
          await chrome.downloads.show(entry.downloadId as number);
        } catch {
          showHistoryStatus("That file is no longer in the browser's download list.", true);
        }
      })();
    };
    actions.appendChild(show);
  }

  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "linkish";
  copy.textContent = "Copy link";
  copy.onclick = () => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(entry.itemUrl);
        showHistoryStatus("Link copied.");
      } catch {
        showHistoryStatus("Could not copy the link.", true);
      }
    })();
  };
  actions.appendChild(copy);

  item.appendChild(actions);
  return item;
}

async function refreshHistory(): Promise<void> {
  const entries = await loadHistory();
  historyCount.textContent = entries.length
    ? `${entries.length} download${entries.length === 1 ? "" : "s"}`
    : "";
  historyList.innerHTML = "";
  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent =
      "No downloads yet. Videos you download from the popup, the right-click menu or the shortcut show up here.";
    historyList.appendChild(empty);
    return;
  }
  historyList.append(...entries.map(renderEntry));
}

async function redownload(entry: HistoryEntry, btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  try {
    const res = (await chrome.runtime.sendMessage({ type: "REDOWNLOAD", entryId: entry.id })) as
      | { ok?: boolean; error?: string }
      | undefined;
    if (res?.ok) {
      showHistoryStatus(`Re-downloading ${basenameOf(entry.filename)}…`);
      scheduleHistoryRefresh(1800);
    } else {
      showHistoryStatus(`Could not re-download: ${res?.error ?? "unknown error"}`, true);
    }
  } catch {
    showHistoryStatus("Background worker isn't answering — reopen this page and retry.", true);
  } finally {
    btn.disabled = false;
  }
}

// ---- tabs -----------------------------------------------------------------

function selectTab(tab: "settings" | "history"): void {
  const settingsActive = tab === "settings";
  tabSettings.setAttribute("aria-selected", String(settingsActive));
  tabHistory.setAttribute("aria-selected", String(!settingsActive));
  panelSettings.hidden = !settingsActive;
  panelHistory.hidden = settingsActive;
  if (!settingsActive) {
    void refreshHistory();
    if (location.hash !== "#history") history.replaceState(null, "", "#history");
  } else if (location.hash === "#history") {
    history.replaceState(null, "", location.pathname);
  }
}

// ---- init -----------------------------------------------------------------

function wire(): void {
  tabSettings.onclick = () => selectTab("settings");
  tabHistory.onclick = () => selectTab("history");

  for (const input of [templateInput, subfolderInput]) {
    input.addEventListener("input", () => scheduleSave());
  }
  notifyInput.addEventListener("change", () => void persistSettings());
  concurrencyInput.addEventListener("input", () => scheduleSave());

  resetButton.onclick = () => {
    populate(DEFAULT_SETTINGS);
    void persistSettings();
    templateInput.focus();
  };

  historyRefresh.onclick = () => void refreshHistory();
  historyClear.onclick = () => {
    void (async () => {
      await clearHistory();
      showHistoryStatus("History cleared.");
      await refreshHistory();
    })();
  };

  // Live updates: history is written by the worker as jobs settle, and the
  // popup/other surfaces may change settings.
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.downStreamHistory) scheduleHistoryRefresh();
      if (changes.downStreamSettings) {
        const next = normalizeSettings(changes.downStreamSettings.newValue);
        if (document.activeElement !== templateInput) templateInput.value = next.filenameTemplate;
        if (document.activeElement !== subfolderInput) subfolderInput.value = next.subfolder;
        notifyInput.checked = next.notifyOnComplete;
        concurrencyInput.value = String(next.batchConcurrency);
        renderPreviews(next);
      }
    });
  } catch {
    /* storage events unavailable */
  }
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((msg as any)?.type === "JOB_UPDATED") scheduleHistoryRefresh(1000);
      return false;
    });
  } catch {
    /* ignore */
  }
}

async function init(): Promise<void> {
  buildPlaceholderChips();
  wire();
  populate(await getSettings());
  selectTab(location.hash === "#history" ? "history" : "settings");
  await refreshHistory();
}

void init();
