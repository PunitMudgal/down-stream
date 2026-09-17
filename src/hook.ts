/* MAIN-world page hook: watches the page's own fetch()/XHR traffic for
 * API responses that embed manifest URLs (e.g. {"playbackUrl":"...m3u8"}).
 *
 * Runs in the page's JS world (no chrome.* APIs here — findings are
 * postMessage'd to the isolated content script). Wrappers are transparent:
 * originals are always called with original args, bodies are only ever read
 * from clones, media/API-excluded traffic is skipped, everything is bounded.
 */
(function () {
  const w = window as unknown as Record<string, unknown>;
  if (w.__vdgHookInstalled) return;
  w.__vdgHookInstalled = true;

  const MAX_BODY = 400_000;
  const MAX_URLS = 30;
  const sent = new Set<string>();

  const MANIFEST_RE =
    /(https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mpd)(?:\?[^\s"'<>\\]*)?|\/\/[^\s"'<>\\]+\.(?:m3u8|mpd)(?:\?[^\s"'<>\\]*)?)/gi;

  function clean(text: string): string {
    return text.replace(/\\\//g, "/");
  }

  function extractUrls(text: string): string[] {
    const out: string[] = [];
    MANIFEST_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while (out.length < MAX_URLS && (m = MANIFEST_RE.exec(text)) !== null) {
      let u = m[0];
      if (u.startsWith("//")) u = window.location.protocol + u;
      if (!sent.has(u)) {
        sent.add(u);
        out.push(u);
      }
    }
    return out;
  }

  function emit(urls: string[]): void {
    if (!urls.length) return;
    try {
      window.postMessage({ __vdg: "manifest-urls", urls }, "*");
    } catch {
      /* ignore */
    }
  }

  function mediaish(url: string, contentType: string | null): boolean {
    const u = url.toLowerCase().split("?")[0];
    if (/\.(ts|m4s|m4v|cmfv|cmfa|mp4|webm|m3u8|mpd|mp3|wav|ogg|jpg|jpeg|png|gif|webp|avif|css|js|woff2?)$/.test(u)) return true;
    if (contentType) {
      const ct = contentType.toLowerCase().split(";")[0].trim();
      if (ct.startsWith("video/") || ct.startsWith("audio/") || ct.startsWith("image/")) return true;
      if (ct === "text/event-stream") return true;
    }
    return false;
  }

  function apiish(contentType: string | null): boolean {
    if (!contentType) return true; // unknown — peek with size guard
    const ct = contentType.toLowerCase().split(";")[0].trim();
    return (
      ct.includes("json") ||
      ct === "text/plain" ||
      ct === "text/html" ||
      ct === "" ||
      ct === "application/octet-stream"
    );
  }

  function urlOf(input: unknown): string {
    try {
      if (typeof input === "string") return input;
      if (input instanceof URL) return input.toString();
      const req = input as { url?: unknown };
      if (req && typeof req.url === "string") return req.url;
    } catch {
      /* ignore */
    }
    return "";
  }

  // ---- fetch() ----
  try {
    const origFetch = window.fetch.bind(window);
    const hooked = function (input: unknown, init?: unknown): Promise<Response> {
      let p: Promise<Response>;
      try {
        p = origFetch(input as RequestInfo, init as RequestInit | undefined);
      } catch (err) {
        return Promise.reject(err);
      }
      try {
        const method = ((init as { method?: unknown } | undefined)?.method as string | undefined) ?? "GET";
        if (String(method).toUpperCase() !== "GET") return p;
        const url = urlOf(input);
        if (!url || mediaish(url, null)) return p;
        p.then((res) => {
          try {
            const ct = res.headers?.get?.("content-type") ?? null;
            if (mediaish(url, ct) || !apiish(ct)) return;
            const len = Number(res.headers?.get?.("content-length") ?? "0");
            if (len > MAX_BODY * 2) return;
            const done = res
              .clone()
              .text()
              .then((t) => emit(extractUrls(clean(t.slice(0, MAX_BODY)))))
              .catch(() => undefined);
            void Promise.race([
              done,
              new Promise((r) => setTimeout(r, 3000)),
            ]);
          } catch {
            /* never break page traffic */
          }
        }).catch(() => undefined);
      } catch {
        /* never break page traffic */
      }
      return p;
    };
    (window as unknown as { fetch: unknown }).fetch = hooked;
  } catch {
    /* fetch not wrappable here */
  }

  // ---- XMLHttpRequest ----
  try {
    const OrigXHR = window.XMLHttpRequest;
    if (OrigXHR) {
      const open = OrigXHR.prototype.open;
      const send = OrigXHR.prototype.send;
      OrigXHR.prototype.open = function (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        ...rest: unknown[]
      ): void {
        try {
          (this as unknown as Record<string, unknown>).__vdgUrl =
            typeof url === "string" ? url : (url as URL).toString();
          (this as unknown as Record<string, unknown>).__vdgMethod = method;
        } catch {
          /* ignore */
        }
        (open as Function).apply(this, [method, url, ...rest]);
      };
      OrigXHR.prototype.send = function (this: XMLHttpRequest, ...args: unknown[]): void {
        try {
          this.addEventListener("load", function (this: XMLHttpRequest) {
            try {
              if (this.status < 200 || this.status >= 300) return;
              const rec = this as unknown as Record<string, unknown>;
              if (String(rec.__vdgMethod ?? "GET").toUpperCase() !== "GET") return;
              const url = String(rec.__vdgUrl ?? "");
              const ct: string | null =
                typeof this.getResponseHeader === "function"
                  ? this.getResponseHeader("content-type")
                  : null;
              if (!url || mediaish(url, ct) || !apiish(ct)) return;
              const text = typeof this.responseText === "string" ? this.responseText : "";
              if (!text || text.length > MAX_BODY * 2) return;
              emit(extractUrls(clean(text.slice(0, MAX_BODY))));
            } catch {
              /* never break page traffic */
            }
          });
        } catch {
          /* ignore */
        }
        (send as Function).apply(this, args);
      };
    }
  } catch {
    /* XHR not wrappable here */
  }

  // ---- MediaSource / SourceBuffer capture ----
  // Large players feed segments via MediaSource, so <video> shows only a
  // blob: URL. We copy the exact bytes appended per SourceBuffer (in order),
  // which reassemble into playable per-track files for CLEAR content only.
  // Any EME (Widevine/FairPlay/PlayReady-style) involvement marks the
  // session refused — captured DRM bytes are never offered for download.
  try {
    const TRACK_CAP = 250_000_000; // per-track memory cap
    const XFER = 4_000_000; // bytes per postMessage chunk

    interface MsTrack {
      mime: string;
      kind: "video" | "audio" | "other";
      parts: Uint8Array[];
      bytes: number;
      overflow: boolean;
    }
    interface MsSession {
      id: string;
      blobUrl?: string;
      tracks: MsTrack[];
      eme: boolean;
      created: number;
    }

    const MS = window as unknown as {
      MediaSource?: typeof MediaSource;
    };
    let msSeq = 0;
    let pageEme = false;
    const sessions = new Map<string, MsSession>();
    const msByObj = new WeakMap<object, string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sbInfo = new WeakMap<object, { msId: string; trackIdx: number }>();
    const blobToMs = new Map<string, string>();

    function trackKind(mime: string): "video" | "audio" | "other" {
      const m = mime.toLowerCase();
      if (m.startsWith("video")) return "video";
      if (m.startsWith("audio")) return "audio";
      return "other";
    }

    function ensureMs(ms: object): string {
      let id = msByObj.get(ms);
      if (!id) {
        id = `ms-${++msSeq}`;
        msByObj.set(ms, id);
        sessions.set(id, { id, tracks: [], eme: false, created: Date.now() });
      }
      return id;
    }

    function sessionForElement(el: unknown): MsSession | undefined {
      try {
        const v = el as HTMLVideoElement;
        if (!v || typeof v !== "object") return undefined;
        const so = (v as unknown as { srcObject?: unknown }).srcObject;
        if (so && typeof so === "object") {
          const id = msByObj.get(so);
          if (id) return sessions.get(id);
        }
        const src =
          (v.currentSrc as string | undefined) ||
          (typeof v.getAttribute === "function" ? v.getAttribute("src") : null);
        if (src) {
          const id = blobToMs.get(src);
          if (id) return sessions.get(id);
        }
      } catch {
        /* ignore */
      }
      return undefined;
    }

    function toBytes(data: unknown): Uint8Array | null {
      try {
        if (data instanceof ArrayBuffer) return new Uint8Array(data).slice();
        if (ArrayBuffer.isView(data)) {
          const v = data as ArrayBufferView & { buffer: ArrayBufferLike; byteOffset: number; byteLength: number };
          return new Uint8Array(v.buffer, v.byteOffset, v.byteLength).slice();
        }
      } catch {
        /* ignore */
      }
      return null;
    }

    // -- URL.createObjectURL: map blob: URL -> MediaSource session --
    try {
      const origCUO = URL.createObjectURL.bind(URL);
      (URL as unknown as Record<string, unknown>).createObjectURL = function (obj: unknown): string {
        const url = (origCUO as (o: unknown) => string)(obj);
        try {
          if (MS.MediaSource && obj instanceof MS.MediaSource) {
            const id = ensureMs(obj as object);
            blobToMs.set(url, id);
            const s = sessions.get(id);
            if (s) s.blobUrl = url;
          }
        } catch {
          /* ignore */
        }
        return url;
      };
    } catch {
      /* ignore */
    }

    // -- addSourceBuffer: bind track + wrap appendBuffer --
    try {
      if (MS.MediaSource?.prototype?.addSourceBuffer) {
        const origAdd = MS.MediaSource.prototype.addSourceBuffer;
        MS.MediaSource.prototype.addSourceBuffer = function (
          this: MediaSource,
          mime: string,
        ): SourceBuffer {
          const sb = origAdd.call(this, mime);
          try {
            const msId = ensureMs(this as object);
            const session = sessions.get(msId);
            const trackIdx = session ? session.tracks.length : 0;
            const track: MsTrack = { mime: String(mime ?? ""), kind: trackKind(String(mime ?? "")), parts: [], bytes: 0, overflow: false };
            session?.tracks.push(track);
            sbInfo.set(sb as object, { msId, trackIdx });
            const origAppend = sb.appendBuffer.bind(sb);
            (sb as unknown as Record<string, unknown>).appendBuffer = function (data: unknown): void {
              try {
                const info = sbInfo.get(sb as object);
                const sess = info ? sessions.get(info.msId) : undefined;
                const trk = sess?.tracks[info?.trackIdx ?? -1];
                if (trk && !trk.overflow) {
                  const bytes = toBytes(data);
                  if (bytes && bytes.byteLength > 0) {
                    if (trk.bytes + bytes.byteLength > TRACK_CAP) {
                      trk.overflow = true;
                    } else {
                      trk.parts.push(bytes);
                      trk.bytes += bytes.byteLength;
                    }
                  }
                }
              } catch {
                /* capture must never break playback */
              }
              (origAppend as (d: unknown) => void)(data);
            };
          } catch {
            /* ignore */
          }
          return sb;
        };
      }
    } catch {
      /* ignore */
    }

    // -- EME detection: attribute to sessions, plus page-level flag --
    function markEme(el: unknown): void {
      try {
        const s = sessionForElement(el);
        if (s) s.eme = true;
      } catch {
        /* ignore */
      }
    }
    try {
      const nav = navigator as unknown as Record<string, unknown>;
      if (typeof nav.requestMediaKeySystemAccess === "function") {
        const origRMKSA = (navigator.requestMediaKeySystemAccess as Function).bind(navigator);
        (nav as Record<string, unknown>).requestMediaKeySystemAccess = function (...args: unknown[]): Promise<unknown> {
          pageEme = true;
          return (origRMKSA as (...a: unknown[]) => Promise<unknown>)(...args);
        };
      }
    } catch {
      /* ignore */
    }
    try {
      const HME = (window as unknown as { HTMLMediaElement?: typeof HTMLMediaElement }).HTMLMediaElement;
      if (HME?.prototype?.setMediaKeys) {
        const origSMK = HME.prototype.setMediaKeys;
        HME.prototype.setMediaKeys = function (
          this: HTMLMediaElement,
          keys: MediaKeys | null,
        ): Promise<void> {
          try {
            if (keys) markEme(this);
          } catch {
            /* ignore */
          }
          return origSMK.call(this, keys);
        };
      }
    } catch {
      /* ignore */
    }
    try {
      document.addEventListener("encrypted", (e) => markEme(e.target), true);
    } catch {
      /* ignore */
    }

    // -- Session listing + cursor-based chunk serving --
    function sessionMeta(): unknown[] {
      const out: unknown[] = [];
      sessions.forEach((s) => {
        let bytes = 0;
        const tracks = s.tracks.map((t, idx) => {
          bytes += t.bytes;
          return { idx, mime: t.mime, kind: t.kind, bytes: t.bytes, chunks: t.parts.length };
        });
        out.push({
          id: s.id,
          blobUrl: s.blobUrl,
          tracks,
          bytes,
          complete: s.tracks.length > 0 && s.tracks.every((t) => !t.overflow),
          eme: s.eme,
          pageEme,
        });
      });
      return out;
    }

    function serveSlice(id: string, trackIdx: number, cursor: number): unknown {
      const s = sessions.get(id);
      const t = s?.tracks[trackIdx];
      if (!s || !t) return { __vdg: "ms-chunk", error: "Capture session expired (page navigated or video reloaded)." };
      if (cursor < 0 || cursor > t.bytes) return { __vdg: "ms-chunk", error: "Bad cursor." };
      if (cursor >= t.bytes) {
        return { __vdg: "ms-chunk", cursor, next: cursor, done: true, total: t.bytes };
      }
      // Walk parts to the cursor, then copy up to XFER bytes (may span parts).
      const buf = new Uint8Array(Math.min(XFER, t.bytes - cursor));
      let filled = 0;
      let off = 0;
      for (const part of t.parts) {
        if (off + part.byteLength <= cursor) {
          off += part.byteLength;
          continue;
        }
        const startInPart = Math.max(0, cursor - off);
        const take = Math.min(part.byteLength - startInPart, buf.byteLength - filled);
        buf.set(part.subarray(startInPart, startInPart + take), filled);
        filled += take;
        off += part.byteLength;
        if (filled >= buf.byteLength) break;
      }
      const out = buf.slice(0, filled);
      return { __vdg: "ms-chunk", cursor, next: cursor + filled, done: cursor + filled >= t.bytes, total: t.bytes, buf: out.buffer };
    }

    window.addEventListener("message", (event) => {
      try {
        if (event.source !== window) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = event.data as any;
        if (!d || typeof d !== "object") return;
        if (d.__vdg === "ms-sessions" && d.nonce) {
          window.postMessage({ __vdg: "ms-sessions-result", nonce: d.nonce, sessions: sessionMeta() }, "*");
        } else if (d.__vdg === "ms-get" && d.nonce && typeof d.id === "string") {
          const res = serveSlice(d.id, Number(d.track) || 0, Number(d.cursor) || 0) as Record<string, unknown>;
          (res as Record<string, unknown>).nonce = d.nonce;
          const tx = res.buf instanceof ArrayBuffer ? [res.buf] : [];
          try {
            window.postMessage(res, "*", tx);
          } catch {
            // Transfer failed (e.g. neutered buffer) — resend as a copy.
            try {
              window.postMessage(res, "*");
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* MSE capture unavailable here */
  }
})();
