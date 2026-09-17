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

export type DownloadKind = "direct" | "hls" | "dash";

export interface DownloadJobRequest {
  jobId: string;
  tabId: number;
  kind: DownloadKind;
  /** Resolved URL to fetch: direct file, HLS variant playlist, or "" for DASH (uses segments). */
  url: string;
  segments?: string[];
  filename: string;
  mime?: string;
}

export type DownloadJobStatus =
  | "running"
  | "done"
  | "error";

export type DownloadJobStage = "fetching" | "assembling" | "saving";

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
