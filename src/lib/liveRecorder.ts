// Live HLS/DASH recording engine.
//
// A live playlist has no end: its segment window slides while the broadcast
// runs. This engine records it — poll the playlist on its target duration,
// fetch each newly-published segment, append its bytes to OPFS as they land
// (restart-recoverable), and roll the accumulated bytes into sequential
// `.partN` files whenever a part crosses the size budget so recordings of
// any length work with bounded memory.
//
// End conditions:
//   - the playlist closes (HLS gains #EXT-X-ENDLIST / DASH turns static),
//   - the user presses Stop / Cancel (whatever is recorded is finalized),
//   - too many consecutive polls fetch nothing (the stream went dead).
//
// DRM is never fetched: encrypted segments are refused at resolve time
// (freshStream) exactly like bounded downloads.

import { fetchSegments, isGateFailure } from "./download";
import {
  liveLoadMeta,
  livePersistSupported,
  liveSaveInit,
  liveSaveMeta,
  liveSaveSegment,
  type LiveMeta,
} from "./liveRecord";
import type { NetReplay } from "./types";

/** Stop pressed: finish with whatever is recorded so far. */
export class LiveStoppedError extends Error {
  constructor() {
    super("Recording stopped.");
    this.name = "LiveStoppedError";
  }
}

export function isLiveStopped(err: unknown): boolean {
  return err instanceof LiveStoppedError;
}

/** One newly-published segment of a live track. */
export interface LiveSegmentEntry {
  /** Stable identity across reloads (HLS media-sequence; DASH list index). */
  seq: number;
  url: string;
}

/** One playlist/MPD reload's view of a live track. */
export interface LivePollSnapshot {
  entries: LiveSegmentEntry[];
  /** Playlist closed — the broadcast is over; finish after these. */
  ended: boolean;
  /** Override poll interval when the manifest specifies one. */
  pollSec?: number;
  /** fMP4 init segment URL for this track, when declared. */
  initUrl?: string;
  /** Diff by URL instead of sequence number (DASH windows reuse indices). */
  byUrl?: boolean;
}

export interface LiveTrackDef {
  /** Poll the manifest and return its current window. */
  poll: () => Promise<LivePollSnapshot>;
  /** Default poll interval (seconds) when the manifest doesn't say. */
  pollSec: number;
  /** Separate audio track to capture in parallel (split A/V live). */
  pair?: { poll: () => Promise<LivePollSnapshot>; pollSec: number };
}

export interface LiveRecorderOptions {
  jobId: string;
  signal: AbortSignal;
  scope?: { byOrigin: Record<string, NetReplay> };
  isPaused?: () => boolean;
  isStopping?: () => boolean;
  /** Last-resort transport for gated segments (page's own request context). */
  relay?: (url: string, signal?: AbortSignal) => Promise<ArrayBuffer>;
  concurrency?: number;
  /** Progress in absolute segment counts + bytes (both tracks combined). */
  onProgress?: (segments: number, bytes: number) => void;
  /** Flush accumulated bytes into a part file; returns its filename. */
  savePart: (parts: ArrayBuffer[], partNo: number, last: boolean) => Promise<string>;
  /** Init chunk persisted by an earlier session (heads part 2+). */
  recoveredInit?: ArrayBuffer;
  /** Persisted-but-unspooled segments of an interrupted session, in order. */
  recoveredPending?: ArrayBuffer[];
  /** How many segments the recovered pending bytes represent. */
  recoveredCount?: number;
  /** True when the init chunk already heads recoveredPending[0]. */
  recoveredHasInit?: boolean;
}

export interface LiveRecordResult {
  parts: number;
  bytes: number;
  segments: number;
  /** Set when the broadcast ended on its own (vs user-stopped). */
  endedNaturally: boolean;
}

/** Flush a part once this many bytes have accumulated. */
export const LIVE_PART_BYTES = 1_200_000_000;
/** Polls that fetch nothing before the stream is declared dead. */
export const LIVE_MAX_IDLE_POLLS = 6;
/** Floor for the poll loop so a hostile manifest can't spin it. */
const MIN_POLL_MS = 1_500;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(t);
      reject(new Error("Download cancelled."));
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    if (signal.aborted) {
      clearTimeout(t);
      reject(new Error("Download cancelled."));
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

interface TrackState {
  poll: () => Promise<LivePollSnapshot>;
  pollSec: number;
  track: 0 | 1;
  /** Absolute index of the next segment to fetch. */
  cursor: number;
  /** Buffered bytes waiting to be rolled into a part file. */
  pending: ArrayBuffer[];
  pendingBytes: number;
  partNo: number;
  initCaptured: boolean;
  initUrl?: string;
  /** Init chunk bytes: persisted, and prepended to every part after the first. */
  initBuf?: ArrayBuffer;
  /** True when pending[0] already IS the init chunk (don't prepend twice). */
  pendingHasInit: boolean;
  ended: boolean;
  /** URLs already fetched (DASH has no sequence numbers — diff by URL). */
  seenUrls: Set<string>;
  idlePolls: number;
  segments: number;
  bytes: number;
}

/** Record one live stream (main track + optional paired audio). */
export async function recordLive(
  def: LiveTrackDef,
  opts: LiveRecorderOptions,
): Promise<LiveRecordResult> {
  const persisted = await livePersistSupported();
  const prior = persisted ? await liveLoadMeta(opts.jobId).catch(() => undefined) : undefined;

  const mkTrack = (
    poll: () => Promise<LivePollSnapshot>,
    pollSec: number,
    track: 0 | 1,
  ): TrackState => {
    // Recovery: an interrupted session's pending bytes come back through the
    // main track only (paired audio re-fetches its current window).
    const recovered =
      track === 0 && opts.recoveredPending?.length ? opts.recoveredPending : [];
    return {
      poll,
      pollSec,
      track,
      cursor: track === 1 ? (prior?.pairCursor ?? 0) : (prior?.cursor ?? 0),
      pending: [...recovered],
      pendingBytes: recovered.reduce((n, b) => n + b.byteLength, 0),
      partNo: 1,
      initCaptured: track === 0 ? (opts.recoveredHasInit ?? false) : false,
      initBuf: track === 0 ? opts.recoveredInit : undefined,
      pendingHasInit: track === 0 && (opts.recoveredHasInit ?? false),
      ended: false,
      seenUrls: new Set<string>(),
      idlePolls: 0,
      segments: track === 0 ? (opts.recoveredCount ?? 0) : 0,
      bytes: recovered.reduce((n, b) => n + b.byteLength, 0),
    };
  };
  const tracks: TrackState[] = [mkTrack(def.poll, def.pollSec, 0)];
  if (def.pair) tracks.push(mkTrack(def.pair.poll, def.pair.pollSec, 1));

  const meta: LiveMeta = { pollSec: def.pollSec, ...(prior ?? {}) };
  const saveMeta = (): void => {
    meta.cursor = tracks[0].cursor;
    meta.pairCursor = tracks[1]?.cursor;
    if (persisted) void liveSaveMeta(opts.jobId, meta);
  };

  const reportProgress = (): void => {
    opts.onProgress?.(
      tracks.reduce((n, t) => n + t.segments, 0),
      tracks.reduce((n, t) => n + t.bytes, 0),
    );
  };

  /** Roll one track's buffered bytes into a part file. */
  const flushPart = async (t: TrackState, last: boolean): Promise<void> => {
    if (!t.pending.length) return;
    let parts = [...t.pending];
    // fMP4 part files must carry the init header to play standalone. Part 1
    // already has it (captureInit pushed it first); parts 2+ get it prepended.
    if (t.partNo > 1 && t.initBuf && !t.pendingHasInit) parts = [t.initBuf, ...parts];
    t.pending = [];
    t.pendingBytes = 0;
    t.pendingHasInit = false;
    await opts.savePart(parts, t.partNo, last);
    t.partNo++;
  };

  /** Fetch one batch of newly-published segments for a track. */
  const fetchBatch = async (t: TrackState, batch: LiveSegmentEntry[]): Promise<void> => {
    if (!batch.length) return;
    const urls = batch.map((e) => e.url);
    const bufs = await fetchSegments(urls, undefined, opts.signal, opts.scope, {
      isPaused: opts.isPaused,
      relay: opts.relay,
      concurrency: Math.max(1, Math.min(opts.concurrency ?? 4, 4)),
      maxRefreshes: 0, // the poll loop re-resolves; in-batch refresh can't map live indices
    });
    for (let i = 0; i < bufs.length; i++) {
      const buf = bufs[i];
      t.pending.push(buf);
      t.pendingBytes += buf.byteLength;
      t.bytes += buf.byteLength;
      t.segments++;
      t.cursor = batch[i].seq + 1;
      if (persisted) void liveSaveSegment(opts.jobId, t.track, batch[i].seq, buf);
      if (t.pendingBytes >= LIVE_PART_BYTES) await flushPart(t, false);
    }
    saveMeta();
    reportProgress();
  };

  /** Capture the track's declared init segment once (heads every part file). */
  const captureInit = async (t: TrackState, snap: LivePollSnapshot): Promise<void> => {
    if (t.initCaptured) return;
    t.initCaptured = true;
    const initUrl = snap.initUrl ?? t.initUrl;
    if (!initUrl) return;
    t.initUrl = initUrl;
    try {
      let buf: ArrayBuffer | undefined;
      try {
        buf = (
          await fetchSegments([initUrl], undefined, opts.signal, opts.scope, {
            relay: opts.relay,
            concurrency: 1,
            maxRefreshes: 0,
          })
        )[0];
      } catch (err) {
        if (opts.relay && isGateFailure(err)) buf = await opts.relay(initUrl, opts.signal);
        else throw err;
      }
      if (buf?.byteLength) {
        meta.hasInit = true;
        t.initBuf = buf;
        if (persisted) void liveSaveInit(opts.jobId, buf);
        t.pending.push(buf);
        t.pendingBytes += buf.byteLength;
        t.pendingHasInit = true;
      }
    } catch (err) {
      if (opts.signal.aborted) throw new Error("Download cancelled.");
      // A missing init is not fatal for TS; fMP4 part files want it, but the
      // segment bytes may still be playable — keep recording.
    }
  };

  /** Diff one poll snapshot against the track cursor → new segments. */
  const diffNew = (t: TrackState, snap: LivePollSnapshot): LiveSegmentEntry[] => {
    if (!snap.entries.length) return [];
    let fresh: LiveSegmentEntry[];
    if (snap.byUrl) {
      // DASH: the window is regenerated per reload without stable indices —
      // the URL is the identity (the init URL is captured separately).
      fresh = snap.entries.filter((e) => !t.seenUrls.has(e.url) && e.url !== t.initUrl);
      for (const e of fresh) t.seenUrls.add(e.url);
    } else {
      const firstSeq = snap.entries[0].seq;
      if (t.cursor < firstSeq) t.cursor = firstSeq; // window slid past us / first poll
      fresh = snap.entries.filter((e) => e.seq >= t.cursor);
      for (const e of fresh) t.seenUrls.add(e.url);
    }
    return fresh;
  };

  let endedNaturally = false;
  let stopRequested = false;
  try {
    for (;;) {
      if (opts.signal.aborted) throw new Error("Download cancelled.");
      if (opts.isStopping?.()) {
        stopRequested = true;
        break;
      }
      while (opts.isPaused?.()) {
        await sleep(250, opts.signal);
        if (opts.isStopping?.()) {
          stopRequested = true;
          break;
        }
      }
      if (stopRequested) break;

      let fetchedAny = false;
      let allEnded = true;
      let minPollSec = Number.POSITIVE_INFINITY;
      for (const t of tracks) {
        if (t.ended) continue;
        let snap: LivePollSnapshot;
        try {
          snap = await t.poll();
        } catch (err) {
          if (opts.signal.aborted) throw new Error("Download cancelled.");
          // A flaky reload must not kill the recording — count it idle and
          // let the loop's dead-stream guard decide.
          t.idlePolls++;
          allEnded = false;
          minPollSec = Math.min(minPollSec, t.pollSec);
          continue;
        }
        if (typeof snap.pollSec === "number" && snap.pollSec > 0) t.pollSec = snap.pollSec;
        if (snap.ended) t.ended = true;
        else allEnded = false;
        minPollSec = Math.min(minPollSec, t.pollSec);
        await captureInit(t, snap);
        const fresh = diffNew(t, snap);
        if (fresh.length) {
          t.idlePolls = 0;
          fetchedAny = true;
          await fetchBatch(t, fresh);
        } else {
          t.idlePolls++;
        }
      }
      if (allEnded && tracks.every((t) => t.ended)) {
        endedNaturally = true;
        break;
      }
      if (!fetchedAny && tracks.every((t) => t.ended || t.idlePolls >= LIVE_MAX_IDLE_POLLS)) {
        throw new Error(
          "The live stream stopped publishing segments (it may have ended without closing its playlist).",
        );
      }
      const pollMs = Math.max(
        MIN_POLL_MS,
        (Number.isFinite(minPollSec) ? minPollSec : def.pollSec) * 1000,
      );
      await sleep(pollMs, opts.signal);
    }
  } finally {
    saveMeta();
  }

  // Finalize: flush whatever remains (broadcast ended, or Stop was pressed).
  for (const t of tracks) await flushPart(t, true);
  return {
    parts: Math.max(...tracks.map((t) => t.partNo - 1), 0),
    bytes: tracks.reduce((n, t) => n + t.bytes, 0),
    segments: tracks.reduce((n, t) => n + t.segments, 0),
    endedNaturally: endedNaturally && !stopRequested,
  };
}
