export type MediaType =
  | "mp4"
  | "webm"
  | "ogg"
  | "mov"
  | "mkv"
  | "avi"
  | "flv"
  | "wmv"
  | "mpg"
  | "hls"
  | "dash"
  | "segments"
  | "capture"
  | "blob"
  | "blobfile"
  | "unknown";

export interface Variant {
  id: string;
  /** Absolute URL of the variant playlist (HLS) or manifest (DASH, single entry). */
  url: string;
  resolution?: string;
  height?: number;
  width?: number;
  bandwidth?: number;
  codecs?: string;
  /** Resolved segment URLs for the chosen variant (populated at download time for HLS). */
  segments?: string[];
  /** Separate HLS audio-rendition playlist (from #EXT-X-MEDIA:TYPE=AUDIO) to mux in. */
  audioUrl?: string;
}

export interface MediaItem {
  url: string;
  tabId: number;
  type: MediaType;
  filename: string;
  /** Human title for display + file naming (video/post title when found). */
  title?: string;
  /** True when the title came from the page title rather than the player. */
  titleFromPage?: boolean;
  /** True while filename is still fallback-generated (no real title yet). */
  autoNamed?: boolean;
  detectedAt: number;
  drmProtected: boolean;
  drmReason?: string;
  variants?: Variant[];
  /** Observed segment URLs for auto-grouped `segments` items. */
  segments?: string[];
  /** MSE capture reference `msId:trackIdx` for `capture` items. */
  captureRef?: string;
  /** Track kind for `capture` items (sibling audio lookup for muxing). */
  captureKind?: "video" | "audio" | "other";
  poster?: string;
  pageTitle?: string;
  /** Short human line, e.g. "1280×720 • 0:34 • playing". */
  meta?: string;
  error?: string;
}

export type RuntimeMessage =
  | { type: "PING" }
  | { type: "GET_MEDIA"; tabId: number }
  | { type: "RESCAN"; tabId: number }
  | { type: "RETRY_PARSE"; tabId: number; itemUrl: string }
  | {
      type: "VIDEO_ELEMENTS";
      tabId: number;
      videos: VideoSignal[];
      pageTitle?: string;
      msSessions?: MsSessionMeta[];
      /** Blobs the page exposed via URL.createObjectURL (hook-held bytes). */
      blobs?: BlobFileInfo[];
      /** Fully formed items supplied by a site adapter. */
      adapterItems?: MediaItem[];
    }
  | {
      type: "MANIFEST_META";
      tabId: number;
      pairs: Array<{ manifest: string; thumbs: string[] }>;
    }
  // --- Background-mediated downloads (survive popup close) ---
  | {
      type: "START_DOWNLOAD";
      tabId: number;
      itemUrl: string;
      variantId?: string;
    }
  | { type: "GET_JOBS"; tabId: number }
  /** Worker -> content script: resolve the video under the cursor / the page's best video. */
  | { type: "CONTEXT_DOWNLOAD" }
  /** Popup -> worker: measure this item's connection speed and recommend a quality. */
  | { type: "PROBE_QUALITY"; tabId: number; itemUrl: string }
  /** Worker -> offscreen: time a small first-segments fetch (bandwidth probe). */
  | {
      type: "OFFSCREEN_PROBE";
      probeId: string;
      urls: string[];
      netScope?: { byOrigin: Record<string, NetReplay> };
    }
  | { type: "CANCEL_JOB"; jobId: string }
  | { type: "PAUSE_JOB"; jobId: string }
  | { type: "RESUME_JOB"; jobId: string }
  /** Re-dispatch an interrupted job under the same id to resume from OPFS. */
  | { type: "RETRY_JOB"; jobId: string }
  | { type: "OFFSCREEN_CANCEL"; jobId: string }
  | { type: "OFFSCREEN_PAUSE"; jobId: string }
  | { type: "OFFSCREEN_RESUME"; jobId: string }
  | { type: "FETCH_TEXT"; tabId: number; url: string; captureOnly?: boolean }
  // Page relay: bytes for a segment this extension is not allowed to fetch
  // (worker -> content script starts it; the slices come back as
  // PAGE_BYTES_CHUNK broadcasts that the offscreen document assembles).
  | { type: "PAGE_FETCH_BYTES"; transferId: string; url: string; jobId?: string }
  | { type: "PAGE_BYTES_CANCEL"; transferId: string }
  | {
      type: "PAGE_BYTES_CHUNK";
      transferId: string;
      index: number;
      total: number;
      done: boolean;
      buf: ArrayBuffer;
    }
  | { type: "PAGE_BYTES_FAILED"; transferId: string; error: string }
  // --- MSE capture transfer (content script <-> hook <-> offscreen) ---
  | { type: "MS_DOWNLOAD"; jobId: string; captureId: string; trackIdx: number; filename: string; pairTrackIdx?: number }
  | { type: "MS_CANCEL"; jobId: string }
  // --- Blob-file transfer (page Blob object URL -> hook slices -> offscreen) ---
  | { type: "BLOB_DOWNLOAD"; jobId: string; url: string; filename: string }
  | { type: "MS_TRACK_START"; jobId: string; total: number; mime: string; filename: string }
  | { type: "MS_TRACK_CHUNK"; jobId: string; which: 0 | 1; index: number; total: number; buf: ArrayBuffer }
  | { type: "MS_TRACK_END"; jobId: string }
  /** Drop a finished capture's buffered parts (bounded offscreen memory). */
  | { type: "PURGE_CAPTURE"; jobId: string }
  /** Drop a job's OPFS-persisted segments (cancel / superseded download). */
  | { type: "PURGE_JOB_DATA"; jobId: string }
  // --- Offscreen <-> background ---
  | { type: "OFFSCREEN_DOWNLOAD"; job: DownloadJobRequest }
  /** Worker asks the live offscreen which job it is running (restart recovery). */
  | { type: "OFFSCREEN_STATUS" }
  | { type: "DOWNLOAD_PROGRESS"; jobId: string; done: number; total: number; bytesDone?: number }
  | { type: "JOB_STAGE"; jobId: string; stage: DownloadJobStage }
  | {
      type: "DOWNLOAD_BLOB";
      jobId: string;
      dataUrl: string;
      filename: string;
    }
  /** Offscreen saved the file itself (chooser/anchor download) — no bytes moved. */
  | { type: "DOWNLOAD_DONE"; jobId: string; filename: string; note?: string; downloadId?: number }
  // --- Settings, history and batch (options page + popup) ---
  | { type: "GET_SETTINGS" }
  | { type: "SAVE_SETTINGS"; settings: Record<string, unknown> }
  | { type: "GET_HISTORY" }
  | { type: "CLEAR_HISTORY" }
  | { type: "REDOWNLOAD"; entryId: string }
  | { type: "JOB_NOTE"; jobId: string; note: string }
  | { type: "REQUEST_PAGE_BYTES"; jobId: string; transferId: string; url: string }
  | { type: "START_BATCH"; tabId: number; items: Array<{ itemUrl: string; variantId?: string }> }
  | { type: "GET_BATCH" }
  /** Offscreen -> worker: save an assembled Blob via chrome.downloads (folder-aware). */
  | { type: "SAVE_BLOB_URL"; jobId: string; blobUrl: string; filename: string }
  /** Worker -> offscreen: the download finished, release the blob URL. */
  | { type: "RELEASE_BLOB_URL"; blobUrl: string }
  | { type: "DOWNLOAD_ERROR"; jobId: string; error: string; expired?: boolean; fallbackDirect?: boolean }
  | { type: "JOB_UPDATED"; job: DownloadJobState };

export interface VideoSignal {
  currentSrc: string;
  poster?: string;
  /** Per-video title found near the player (post text, aria-label, …). */
  title?: string;
  duration?: number;
  paused?: boolean;
  width?: number;
  height?: number;
  /** Raw src attribute + <source> children (may differ from currentSrc). */
  candidates?: string[];
}

/**
 * A Blob the page published via URL.createObjectURL and the MAIN hook
 * retained. Only blobs actually referenced by a <video> element become
 * downloadable `blobfile` items — the rest are never surfaced.
 */
export interface BlobFileInfo {
  url: string;
  size: number;
  type: string;
}

export type DownloadKind = "direct" | "hls" | "dash" | "capture";

/**
 * Replayable network context captured from the page's own successful
 * requests. Only safe-to-replay values are ever stored: Authorization and
 * custom X-* headers (same-origin only at lookup time) plus the page
 * referrer. Cookies are NEVER stored (and couldn't be replayed via fetch).
 */
export interface NetReplay {
  headers?: Record<string, string>;
  referrer?: string;
}

export interface DownloadJobRequest {
  jobId: string;
  tabId: number;
  kind: DownloadKind;
  /** Resolved URL to fetch: direct file, HLS variant playlist, or "" for DASH (uses segments). */
  url: string;
  segments?: string[];
  /** Audio sibling for split A/V (HLS variant playlist URL or DASH segments). Muxed into one file. */
  pairUrl?: string;
  pairSegments?: string[];
  filename: string;
  mime?: string;
  /** Per-origin replay contexts (auth scoped to capture origin). */
  netScope?: { byOrigin: Record<string, NetReplay> };
}

export type DownloadJobStatus =
  | "running"
  | "paused"
  | "done"
  | "error";

export type DownloadJobStage = "fetching" | "assembling" | "saving";

/**
 * MSE capture session metadata (hook -> content -> background).
 * Bytes stay in the page until a download is requested.
 */
export interface MsTrackMeta {
  idx: number;
  mime: string;
  kind: "video" | "audio" | "other";
  bytes: number;
  chunks: number;
}

export interface MsSessionMeta {
  id: string;
  blobUrl?: string;
  tracks: MsTrackMeta[];
  bytes: number;
  /** True when nothing was dropped (per-track memory cap never hit). */
  complete: boolean;
  /** EME (Widevine/FairPlay/PlayReady-style DRM path) touched this session. */
  eme: boolean;
  /** Page requested EME keys at all — unattributed sessions stay refused. */
  pageEme: boolean;
}

export type BatchStatus = "queued" | "running" | "done" | "failed";

/** One queued/active batch download (popup shows the aggregate). */
export interface BatchTaskState {
  itemUrl: string;
  title?: string;
  filename?: string;
  status: BatchStatus;
  error?: string;
}

/** Aggregate queue progress for the popup's batch bar. */
export interface BatchSnapshot {
  total: number;
  queued: number;
  running: number;
  done: number;
  failed: number;
  concurrency: number;
  active: boolean;
  tasks: BatchTaskState[];
}

export interface DownloadJobState {
  jobId: string;
  tabId: number;
  itemUrl: string;
  variantId?: string;
  filename: string;
  status: DownloadJobStatus;
  done: number;
  total: number;
  /** Progress unit: segment counts for HLS/DASH, raw bytes for direct streams. */
  unit?: "segments" | "bytes";
  /** Bytes assembled so far (for speed/ETA). Segments vary in size. */
  bytesDone?: number;
  /** Rolling transfer rate in bytes/second (worker-computed sliding window). */
  rateBps?: number;
  /** Wall-clock start of the job (for speed calc). */
  startedAt?: number;
  /** Display title of the source video (history rows). */
  title?: string;
  /** Page the video was detected on (re-download resolution). */
  pageUrl?: string;
  /** Human quality label of the chosen variant, e.g. "1080p" (history rows). */
  quality?: string;
  /** Media type of the source item (history rows). */
  mediaType?: MediaType;
  stage?: DownloadJobStage;
  downloadId?: number;
  error?: string;
  /** Extra completion detail, e.g. which part files a large download was split into. */
  note?: string;
  /** True when the failure looks like expired signed URLs (offers Refresh & Retry). */
  expired?: boolean;
  updatedAt: number;
}
