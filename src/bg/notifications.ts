/**
 * Completion notifications.
 *
 * Every finished download can raise a system notification with a
 * "Show in folder" action. Whether that action can do anything depends on the
 * download having been tracked by `chrome.downloads` (which the
 * blob-URL save path guarantees); untracked saves still notify, just without
 * the button.
 *
 * The notification id -> downloadId map lives in `storage.session` so a
 * button click still works after the service worker was suspended.
 */
import { basenameOf } from "../lib/filename";
import { getSettings } from "../lib/settings";
import type { DownloadJobState } from "../lib/types";

const NOTIF_MAP_KEY = "downStreamNotifMap";
const ICON_URL = "downstream.png";

interface NotifTarget {
  downloadId: number;
  jobId: string;
}

async function readMap(): Promise<Record<string, NotifTarget>> {
  try {
    const got = await chrome.storage.session.get(NOTIF_MAP_KEY);
    const raw = (got as Record<string, unknown>)[NOTIF_MAP_KEY];
    return raw && typeof raw === "object" ? (raw as Record<string, NotifTarget>) : {};
  } catch {
    return {};
  }
}

async function remember(notifId: string, target: NotifTarget): Promise<void> {
  try {
    const map = await readMap();
    map[notifId] = target;
    await chrome.storage.session.set({ [NOTIF_MAP_KEY]: map });
  } catch {
    /* best-effort */
  }
}

async function recall(notifId: string): Promise<NotifTarget | undefined> {
  return (await readMap())[notifId];
}

async function forget(notifId: string): Promise<void> {
  try {
    const map = await readMap();
    if (notifId in map) {
      delete map[notifId];
      await chrome.storage.session.set({ [NOTIF_MAP_KEY]: map });
    }
  } catch {
    /* ignore */
  }
}

/** Raise a completion notification for a finished job (respects settings). */
export async function notifyDownloadComplete(job: DownloadJobState): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.notifyOnComplete) return;
    const notifId = `vdg-${job.jobId}`;
    const name = basenameOf(job.filename) || job.filename || "video";
    const hasFolder = typeof job.downloadId === "number";
    const message = job.note ? `${name} — ${job.note}` : name;
    await chrome.notifications.create(notifId, {
      type: "basic",
      iconUrl: chrome.runtime.getURL(ICON_URL),
      title: job.title ? `Downloaded: ${job.title}` : "Download complete",
      message,
      ...(hasFolder ? { buttons: [{ title: "Show in folder" }] } : {}),
    });
    if (hasFolder) await remember(notifId, { downloadId: job.downloadId as number, jobId: job.jobId });
  } catch {
    /* notifications unavailable (or user blocked them) — never fail a download */
  }
}

/** Reveal a tracked download in the OS file manager. */
async function showInFolder(downloadId: number): Promise<void> {
  try {
    await chrome.downloads.show(downloadId);
  } catch {
    /* download already removed from the list */
  }
}

/**
 * Wire notification interactions. Called once at worker startup; the listeners
 * are cheap and must exist before any notification is clicked.
 */
export function wireNotifications(): void {
  try {
    chrome.notifications.onButtonClicked.addListener((notifId, buttonIndex) => {
      if (buttonIndex !== 0) return;
      void (async () => {
        const target = await recall(notifId);
        if (target) await showInFolder(target.downloadId);
        try {
          await chrome.notifications.clear(notifId);
        } catch {
          /* ignore */
        }
      })();
    });
    chrome.notifications.onClicked.addListener((notifId) => {
      void (async () => {
        const target = await recall(notifId);
        if (target) {
          await showInFolder(target.downloadId);
          try {
            await chrome.notifications.clear(notifId);
          } catch {
            /* ignore */
          }
        } else {
          try {
            await chrome.runtime.openOptionsPage();
          } catch {
            /* ignore */
          }
        }
      })();
    });
    chrome.notifications.onClosed.addListener((notifId) => {
      void forget(notifId);
    });
  } catch {
    /* notifications API unavailable */
  }
}
