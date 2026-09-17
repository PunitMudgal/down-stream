export type MediaType =
  | "mp4"
  | "webm"
  | "ogg"
  | "mov"
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
  error?: string;
}

export type RuntimeMessage =
  | { type: "GET_MEDIA"; tabId: number }
  | { type: "RESCAN"; tabId: number }
  | {
      type: "VIDEO_ELEMENTS";
      tabId: number;
      videos: VideoSignal[];
      pageTitle?: string;
    };

export interface VideoSignal {
  currentSrc: string;
  poster?: string;
  duration?: number;
  paused?: boolean;
  width?: number;
  height?: number;
}
