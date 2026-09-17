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
  detectedAt: number;
  drmProtected: boolean;
  drmReason?: string;
  variants?: Variant[];
  /** Observed segment URLs for auto-grouped `segments` items. */
  segments?: string[];
  /** MSE capture reference `msId:trackIdx` for `capture` items. */
  captureRef?: string;
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
  | { type: "OFFSCREEN_CANCEL"; jobId: string }
  | { type: "FETCH_TEXT"; tabId: number; url: string }
  // --- MSE capture transfer (content script <-> hook <-> offscreen) ---
  | { type: "MS_DOWNLOAD"; jobId: string; captureId: string; trackIdx: number; filename: string }
  | { type: "MS_CANCEL"; jobId: string }
  | { type: "MS_TRACK_START"; jobId: string; total: number; mime: string; filename: string }
  | { type: "MS_TRACK_CHUNK"; jobId: string; index: number; total: number; buf: ArrayBuffer }
  | { type: "MS_TRACK_END"; jobId: string }
  // --- Offscreen <-> background ---
  | { type: "OFFSCREEN_DOWNLOAD"; job: DownloadJobRequest }
  | { type: "DOWNLOAD_PROGRESS"; jobId: string; done: number; total: number }
  | { type: "JOB_STAGE"; jobId: string; stage: DownloadJobStage }
  | {
      type: "DOWNLOAD_BLOB";
      jobId: string;
      dataUrl: string;
      filename: string;
    }
  | { type: "DOWNLOAD_ERROR"; jobId: string; error: string }
  | { type: "JOB_UPDATED"; job: DownloadJobState };

export interface VideoSignal {
  currentSrc: string;
  poster?: string;
  duration?: number;
  paused?: boolean;
  width?: number;
  height?: number;
  /** Raw src attribute + <source> children (may differ from currentSrc). */
  candidates?: string[];
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
  filename: string;
  mime?: string;
  /** Per-origin replay contexts (auth scoped to capture origin). */
  netScope?: { byOrigin: Record<string, NetReplay> };
}

export type DownloadJobStatus =
  | "running"
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
  stage?: DownloadJobStage;
  downloadId?: number;
  error?: string;
  updatedAt: number;
}
