// Frame-addressed messaging.
//
// Page-context work — reading a playlist the player already fetched, fetching
// one from the page's own JS world, relaying a refused chunk, pulling a Blob or
// an MSE capture — has to reach THE frame the media lives in. That frame is the
// one whose Referer/Origin/cookies the CDN accepted, and the only one holding
// the player's buffer; asking every frame instead means a wrong-context request
// (and, for Blob/capture pulls, a wrong frame reporting a failure for media it
// never had).
//
// Frame ids are per-navigation, so a stored id can outlive it. Every send here
// therefore falls back to the whole tab, which is exactly the behavior that
// existed before ids were tracked: never strand a download on a stale id.

/** A frame id that can be addressed (0 is the top frame; -1/absent = any). */
export function addressableFrame(frameId: number | undefined): number | undefined {
  return typeof frameId === "number" && frameId >= 0 ? frameId : undefined;
}

/**
 * Send `msg` to `frameId` in `tabId`, falling back to the whole tab when that
 * frame is gone (navigated away, discarded, or never had a content script).
 * Throws only when no frame could take it.
 */
export async function sendToFrame<T = unknown>(
  tabId: number,
  frameId: number | undefined,
  msg: unknown,
): Promise<T | undefined> {
  const frame = addressableFrame(frameId);
  if (frame !== undefined) {
    try {
      return (await chrome.tabs.sendMessage(tabId, msg, { frameId: frame })) as T;
    } catch {
      /* frame recreated or script gone — the tab-wide send below is the retry */
    }
  }
  return (await chrome.tabs.sendMessage(tabId, msg)) as T | undefined;
}

/** Frame ids in a tab, best-effort (needs the webNavigation permission). */
async function frameIdsFor(tabId: number): Promise<number[]> {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return (frames ?? [])
      .map((f) => f.frameId)
      .filter((id): id is number => typeof id === "number" && id >= 0);
  } catch {
    return [];
  }
}

/**
 * Send a message only ONE frame can serve — the frame holding a page Blob or an
 * MSE capture. Frames that don't own it answer `{declined: true}` (no side
 * effects), so the search walks the tab's frames until one accepts. That is
 * what keeps an iframe-hosted player from being failed by a sibling frame that
 * never had the bytes.
 *
 * Falls back to a plain tab-wide send, which is the behavior that existed
 * before frames were tracked — a missing answer must never strand a download.
 */
export async function sendToAcceptingFrame<T = unknown>(
  tabId: number,
  frameId: number | undefined,
  msg: unknown,
  maxFrames = 12,
): Promise<{ accepted: boolean; error?: string; response?: T }> {
  const preferred = addressableFrame(frameId);
  const all = await frameIdsFor(tabId);
  const ordered =
    preferred === undefined ? all : [preferred, ...all.filter((id) => id !== preferred)];
  let declineError: string | undefined;
  for (const id of ordered.slice(0, maxFrames)) {
    try {
      const res = (await chrome.tabs.sendMessage(tabId, msg, { frameId: id })) as {
        declined?: boolean;
        error?: string;
      };
      if (res?.declined === true) {
        declineError = declineError ?? res.error;
        continue; // this frame doesn't hold it — ask the next one
      }
      return { accepted: true, response: res as T };
    } catch {
      /* no content script in that frame */
    }
  }
  // Last resort (also covers subframes the frame list missed).
  const res = (await chrome.tabs.sendMessage(tabId, msg)) as {
    declined?: boolean;
    error?: string;
  };
  if (res?.declined === true) return { accepted: false, error: declineError ?? res.error };
  return { accepted: true, response: res as T };
}
