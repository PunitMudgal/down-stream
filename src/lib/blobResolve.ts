/**
 * Routing for `blob:` player rows.
 *
 * A `<video src="blob:...">` is one of two very different things:
 * - a whole file the page already fetched and wrapped in a Blob — the bytes
 *   can be read back out (`fetch(blobUrl)` works, in the page, forever);
 * - a MediaSource buffer fed segment by segment — there is no file to fetch,
 *   only the bytes the hook copied while the player appended them.
 *
 * The hook resolves which one applies (`blob-resolve`), this module turns that
 * reply into a route, and both the content script (transfer driver) and the
 * page hook agree on these strings — one place to change them.
 */

export interface BlobTrackRef {
  idx: number;
  kind?: string;
  bytes: number;
}

/** Bytes are readable: stream the Blob out of the page, slice by slice. */
export interface BlobBytesRoute {
  kind: "blob";
  size: number;
  mime: string;
}

/** Live MediaSource buffer: download the captured appends instead. */
export interface BlobMseRoute {
  kind: "mse";
  sessionId: string;
  videoTrackIdx: number;
  audioTrackIdx?: number;
}

/** Nothing to read (revoked, never existed, or a buffer with no capture). */
export interface BlobDeadRoute {
  kind: "dead";
  /** Raw reason token from the hook (`not-held`, `not-fetchable`, `empty`) or any message. */
  reason: string;
}

export type BlobRoute = BlobBytesRoute | BlobMseRoute | BlobDeadRoute;

/**
 * Shown on the card the worker/popup creates for a `blob:` player. Worded as
 * an instruction, not a failure: the row IS downloadable (the button next to
 * it reads the video out of the player), it just needs the video to have been
 * played so the player has buffered something to read.
 */
export const BLOB_PLACEHOLDER_HINT =
  "Player buffer (blob:). Download reads the video out of the player itself — nothing is captured until the video starts playing, so play a few seconds first if the download reports an empty buffer.";

/** The page revoked the buffer, or we are looking at a stale blob: URL. */
export const BLOB_GONE_HINT =
  "The page released this player's buffer (one-time stream or revoked URL) and it hasn't been re-buffered. Replay the video, then Rescan and download again.";

/** A live MediaSource URL, with no captured appends to fall back on. */
export const BLOB_MSE_HINT =
  "This player streams into a browser buffer instead of loading a file, and no bytes have been buffered since the capture hook started. Play the video for a few seconds — or reload the tab so capture starts with playback — then Rescan.";

/** Captured appends exist but carry no bytes yet. */
export const BLOB_EMPTY_HINT =
  "The player's buffer is still empty. Let the video play for a few seconds, then download again.";

/**
 * Turn a hook reply (or nothing at all) into a route. Defensive on purpose:
 * this crosses the page↔extension boundary, so every field is validated.
 */
export function parseBlobRoute(raw: unknown): BlobRoute | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (r.__vdg !== "blob-resolve-result") return undefined;

  if (typeof r.error === "string" || r.error === true) {
    return {
      kind: "dead",
      reason: typeof r.error === "string" && r.error ? r.error : "not-fetchable",
    };
  }
  const kind = typeof r.kind === "string" ? r.kind : "blob";

  if (kind === "mse") {
    if (typeof r.sessionId !== "string" || !r.sessionId) return undefined;
    const tracks = Array.isArray(r.tracks) ? (r.tracks as BlobTrackRef[]) : [];
    // A session with no bytes yet (player hasn't appended, or the hook missed
    // the early appends) is not a downloadable route — report it as empty so
    // the caller fails fast with "play a few seconds" AND can fall back to a
    // manifest/segments row instead of starting a doomed buffer transfer.
    if (!tracks.some((t) => t && typeof t.bytes === "number" && t.bytes > 0)) {
      return { kind: "dead", reason: "empty" };
    }
    const picked = pickCaptureTracks(tracks);
    return {
      kind: "mse",
      sessionId: r.sessionId,
      videoTrackIdx: picked.videoTrackIdx,
      audioTrackIdx: picked.audioTrackIdx,
    };
  }

  const size = typeof r.size === "number" && Number.isFinite(r.size) ? r.size : 0;
  if (size <= 0) return { kind: "dead", reason: "empty" };
  const mime = typeof r.type === "string" && r.type ? r.type : "video/mp4";
  return { kind: "blob", size, mime };
}

/**
 * Which captured track is the video, and which is its audio pair? The track
 * with the most bytes wins (a player that opened a track never fed it leaves
 * an empty one behind); `other` counts as video because some players label
 * fMP4 muxed tracks without a `video/` MIME. Ties keep the earliest track.
 * An audio track with no bytes is not a pair — pairing it would only add an
 * empty second track to the file.
 */
export function pickCaptureTracks(tracks: BlobTrackRef[]): {
  videoTrackIdx: number;
  audioTrackIdx?: number;
} {
  const list = Array.isArray(tracks) ? tracks : [];
  let video: BlobTrackRef | undefined;
  let audio: BlobTrackRef | undefined;
  for (const t of list) {
    if (!t || !Number.isFinite(Number(t.idx))) continue;
    if (t.kind === "audio") {
      if (t.bytes > 0 && (!audio || t.bytes > audio.bytes)) audio = t;
      continue;
    }
    if (!video || t.bytes > video.bytes) video = t;
  }
  const videoTrackIdx = video ? Number(video.idx) : 0;
  const audioTrackIdx = audio ? Number(audio.idx) : undefined;
  return audioTrackIdx !== undefined && audioTrackIdx !== videoTrackIdx
    ? { videoTrackIdx, audioTrackIdx }
    : { videoTrackIdx };
}

/** User-facing message for a dead route (hook tokens map to prose). */
export function blobDeadMessage(reason?: string): string {
  const r = (reason ?? "").trim();
  if (!r) return BLOB_GONE_HINT;
  if (r === "empty") return BLOB_EMPTY_HINT;
  if (r === "not-fetchable") return BLOB_MSE_HINT;
  if (r === "not-held") return BLOB_GONE_HINT;
  // Anything else is already a message from the page.
  return r;
}
