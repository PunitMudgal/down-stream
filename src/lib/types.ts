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
  | {
      type: "VIDEO_ELEMENTS";
      tabId: number;
      videos: VideoSignal[];
      pageTitle?: string;
      msSessions?: MsSessionMeta[];
      /** Blobs the page exposed via URL.createObjectURL (hook-held bytes). */
      blobs?: BlobFileInfo[];
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
  | { type: "CANCEL_JOB"; jobId: string }
  | { type: "PAUSE_JOB"; jobId: string }
  | { type: "RESUME_JOB"; jobId: string }
  | { type: "OFFSCREEN_CANCEL"; jobId: string }
  | { type: "OFFSCREEN_PAUSE"; jobId: string }
  | { type: "OFFSCREEN_RESUME"; jobId: string }
  | { type: "FETCH_TEXT"; tabId: number; url: string }
  // --- MSE capture transfer (content script <-> hook <-> offscreen) ---
  | { type: "MS_DOWNLOAD"; jobId: string; captureId: string; trackIdx: number; filename: string; pairTrackIdx?: number }
  | { type: "MS_CANCEL"; jobId: string }
  // --- Blob-file transfer (page Blob object URL -> hook slices -> offscreen) ---
  | { type: "BLOB_DOWNLOAD"; jobId: string; url: string; filename: string }
  | { type: "MS_TRACK_START"; jobId: string; total: number; mime: string; filename: string }
  | { type: "MS_TRACK_CHUNK"; jobId: string; which: 0 | 1; index: number; total: number; buf: ArrayBuffer }
  | { type: "MS_TRACK_END"; jobId: string }
  // --- Offscreen <-> background ---
  | { type: "OFFSCREEN_DOWNLOAD"; job: DownloadJobRequest }
  | { type: "DOWNLOAD_PROGRESS"; jobId: string; done: number; total: number; bytesDone?: number }
  | { type: "JOB_STAGE"; jobId: string; stage: DownloadJobStage }
  | {
      type: "DOWNLOAD_BLOB";
      jobId: string;
      dataUrl: string;
      filename: string;
    }
  /** Offscreen saved the file itself (anchor download) — no bytes moved. */
  | { type: "DOWNLOAD_DONE"; jobId: string; filename: string }
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
  /** Wall-clock start of the job (for speed calc). */
  startedAt?: number;
  stage?: DownloadJobStage;
  downloadId?: number;
  error?: string;
  /** True when the failure looks like expired signed URLs (offers Refresh & Retry). */
  expired?: boolean;
  updatedAt: number;
}
