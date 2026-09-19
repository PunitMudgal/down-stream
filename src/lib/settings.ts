/**
 * User settings, persisted in `chrome.storage.local` (never remote: this
 * extension stays fully local). Every read is defensively normalized so a
 * hand-edited or older stored value can never break a download.
 */
import { DEFAULT_FILENAME_TEMPLATE, sanitizeSubfolder } from "./filename";

export interface Settings {
  /** Output filename pattern; "" keeps the detected name untouched. */
  filenameTemplate: string;
  /** Relative download subfolder ("" = browser's default download folder). */
  subfolder: string;
  /** Show a completion notification with a "Show in folder" action. */
  notifyOnComplete: boolean;
  /** How many queued downloads run at once (batch mode). */
  batchConcurrency: number;
}

export const SETTINGS_KEY = "downStreamSettings";

export const DEFAULT_SETTINGS: Settings = {
  filenameTemplate: DEFAULT_FILENAME_TEMPLATE,
  subfolder: "DownStream",
  notifyOnComplete: true,
  batchConcurrency: 2,
};

export const BATCH_CONCURRENCY_MIN = 1;
export const BATCH_CONCURRENCY_MAX = 4;

/** Clamp/normalize anything that came out of storage. */
export function normalizeSettings(raw: unknown): Settings {
  const r = (raw ?? {}) as Partial<Settings>;
  const concurrency = Math.round(Number(r.batchConcurrency));
  return {
    filenameTemplate:
      typeof r.filenameTemplate === "string"
        ? r.filenameTemplate.slice(0, 160)
        : DEFAULT_SETTINGS.filenameTemplate,
    subfolder: typeof r.subfolder === "string" ? sanitizeSubfolder(r.subfolder) : DEFAULT_SETTINGS.subfolder,
    notifyOnComplete: typeof r.notifyOnComplete === "boolean" ? r.notifyOnComplete : DEFAULT_SETTINGS.notifyOnComplete,
    batchConcurrency: Number.isFinite(concurrency)
      ? Math.min(BATCH_CONCURRENCY_MAX, Math.max(BATCH_CONCURRENCY_MIN, concurrency))
      : DEFAULT_SETTINGS.batchConcurrency,
  };
}

/** Current settings (defaults on any storage failure). */
export async function getSettings(): Promise<Settings> {
  try {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    return normalizeSettings((got as Record<string, unknown>)[SETTINGS_KEY]);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Merge a patch into the stored settings and return the normalized result. */
export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const merged = normalizeSettings({ ...(await getSettings()), ...patch });
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  } catch {
    /* settings are best-effort — a failed write keeps the in-memory value */
  }
  return merged;
}

/** Subscribe to settings changes (options page keeps the worker-independent
 * popup in sync). Returns an unsubscribe function. */
export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  const listener = (
    changes: Record<string, chrome.storage.StorageChange>,
    area: string,
  ): void => {
    if (area !== "local" || !changes[SETTINGS_KEY]) return;
    cb(normalizeSettings(changes[SETTINGS_KEY].newValue));
  };
  try {
    chrome.storage.onChanged.addListener(listener);
  } catch {
    /* storage events unavailable */
  }
  return () => {
    try {
      chrome.storage.onChanged.removeListener(listener);
    } catch {
      /* ignore */
    }
  };
}
