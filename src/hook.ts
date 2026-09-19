/* MAIN-world page hook: watches the page's own fetch()/XHR traffic for
 * API responses that embed manifest URLs (e.g. {"playbackUrl":"...m3u8"}).
 *
 * Runs in the page's JS world (no chrome.* APIs here — findings are
 * postMessage'd to the isolated content script). Wrappers are transparent:
 * originals are always called with original args.
 *
 * PERFORMANCE CONTRACT (this hook runs on every page incl. YouTube/Grok):
 * - Response bodies are NEVER fully buffered. Inspection uses a bounded
 *   reader peek (<=MAX_BODY chars, <=PEEK_TIME_MS wait, then cancelled), so
 *   long-lived streams (chat SSE, live chats) can't hang or bloat memory.
 * - Peeks are concurrency-capped and rate-limited per time window; over
 *   budget traffic is skipped, never queued.
 * - A cheap substring precheck runs before any regex, so ~all non-video
 *   API traffic costs one indexOf scan and nothing more.
 * - MSE byte capture is hard-capped per track and per session count, stops
 *   copying the moment a cap hits (pure passthrough afterwards), and frees
 *   buffered bytes as soon as a session is known DRM-tainted.
 * - Playlist (m3u8/mpd) bodies the page itself loads are kept (bounded count,
 *   chars, TTL, inflight/rate budget) so the extension can reuse the exact
 *   bytes the CDN served the page instead of re-fetching them — and, when
 *   asked, this world performs the fetch itself with the page's own context.
 */
import { extractMediaFileUrls, hasMediaBodyHint } from "./lib/apiUrls";

(function () {
  const w = window as unknown as Record<string, unknown>;
  if (w.__vdgHookInstalled) return;
  w.__vdgHookInstalled = true;

  const IS_SUBFRAME = (() => {
    try {
      return window.self !== window.top;
    } catch {
      return true;
    }
  })();

  // ---- inspection budgets ----
  const MAX_BODY = 200_000; // max chars inspected per response body
  const PEEK_TIME_MS = 1200; // max ms spent reading one body
  const MAX_URLS = 30;
  const MAX_PEEK_INFLIGHT = 2; // concurrent body peeks max
  // Subframes (ads/embeds/trackers) get a much smaller peek budget.
  const MAX_PEEK_PER_WINDOW = IS_SUBFRAME ? 10 : 40;
  const PEEK_WINDOW_MS = 10_000;
  let peekInflight = 0;
  let peekWindowStart = Date.now();
  let peekWindowCount = 0;

  function peekAllowed(): boolean {
    const now = Date.now();
    if (now - peekWindowStart > PEEK_WINDOW_MS) {
      peekWindowStart = now;
      peekWindowCount = 0;
    }
    if (peekInflight >= MAX_PEEK_INFLIGHT || peekWindowCount >= MAX_PEEK_PER_WINDOW) return false;
    peekWindowCount++;
    return true;
  }

  // High-traffic endpoints that never carry manifest URLs (telemetry, ads,
  // logging, beacons). Skipped before any body work.
  const SKIP_URL_RE =
    /(youtubei\/v1\/(log|att|player\/heartbeat)|youtube\/i\/api\/stats|googlevideo\.com\/(ptracking|pagead)|doubleclick\.net|google-analytics\.com|googletagmanager\.com|analytics\.|telemetry|hotjar|fullstory|segment\.(io|com)|sentry|bugsnag|datadog|newrelic|mixpanel|amplitude|facebook\.com\/tr|beacon|___beacon|collect\?|healthz|generate_204|client-registry|heartbeat|crashlog)/i;

  function skippable(url: string): boolean {
    if (!url || url.length > 4000) return true;
    return SKIP_URL_RE.test(url);
  }

  function pageHidden(): boolean {
    try {
      return typeof document !== "undefined" && document.hidden;
    } catch {
      return false;
    }
  }

  const sent = new Set<string>();
  function remember(u: string): boolean {
    if (sent.has(u)) return false;
    if (sent.size >= 1000) sent.clear(); // bounded; downstream dedupes by URL anyway
    sent.add(u);
    return true;
  }

  const MANIFEST_RE =
    /(https?:\/\/[^\s"'<>\\]+\.(?:m3u8|mpd)(?:\?[^\s"'<>\\]*)?|\/\/[^\s"'<>\\]+\.(?:m3u8|mpd)(?:\?[^\s"'<>\\]*)?)/gi;
  const IMAGE_RE =
    /https?:\/\/[^\s"'<>\\]+\.(?:jpg|jpeg|png|webp)(?:\?[^\s"'<>\\]*)?/gi;

  function clean(text: string): string {
    return text.replace(/\\\//g, "/");
  }

  /** Cheap gate before the regex engine: playlists, inline MPD, or file lists. */
  function hasManifestHint(text: string): boolean {
    return hasMediaBodyHint(text);
  }

  function extractImages(text: string): string[] {
    const out: string[] = [];
    IMAGE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while (out.length < 5 && (m = IMAGE_RE.exec(text)) !== null) {
      const u = m[0];
      if (!out.includes(u)) out.push(u);
    }
    return out;
  }

  function extractUrls(text: string): string[] {
    const out: string[] = [];
    MANIFEST_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while (out.length < MAX_URLS && (m = MANIFEST_RE.exec(text)) !== null) {
      let u = m[0];
      if (u.startsWith("//")) u = window.location.protocol + u;
      if (remember(u)) out.push(u);
    }
    return out;
  }

  function emit(urls: string[], textForThumbs?: string): void {
    if (!urls.length) return;
    try {
      window.postMessage({ __vdg: "manifest-urls", urls }, "*");
    } catch {
      /* ignore */
    }
    // Same API response often carries the poster next to the manifest URL —
    // pair them so rows get real thumbnails.
    try {
      if (textForThumbs) {
        const thumbs = extractImages(textForThumbs);
        if (thumbs.length) {
          window.postMessage(
            { __vdg: "manifest-meta", pairs: urls.map((u) => ({ manifest: u, thumbs })) },
            "*",
          );
        }
      }
    } catch {
      /* ignore */
    }
  }

  function handleText(text: string): void {
    if (!text || !hasManifestHint(text)) return;
    const cleanText = clean(text.length > 800_000 ? text.slice(0, 800_000) : text);
    const urls = extractUrls(cleanText);
    emit(urls, cleanText);
    // Progressive files in the same body (Pinterest HLS+mp4, Instagram
    // video_versions, inline DASH BaseURL). Independent of playlist hits —
    // Instagram GraphQL often has the mp4 and no .m3u8/.mpd URL at all.
    try {
      const files = extractMediaFileUrls(cleanText).filter((u) => remember("f:" + u));
      if (files.length) {
        try {
          window.postMessage({ __vdg: "manifest-urls", urls: files }, "*");
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* never break page traffic */
    }
  }

  /**
   * Bounded body peek: reads at most `maxChars` chars within `budgetMs`, then
   * cancels the clone. The page's original response is untouched and long-lived
   * streams can never stall us — we take a prefix and walk away. `truncated`
   * says whether the prefix is incomplete (cap hit or budget blown).
   */
  function peekBody(
    res: Response,
    maxChars: number,
    budgetMs: number,
  ): Promise<{ text: string; truncated: boolean }> {
    return new Promise((resolve) => {
      let out = "";
      let settled = false;
      let timedOut = false;
      const finish = (truncated: boolean): void => {
        if (!settled) {
          settled = true;
          resolve({ text: out, truncated });
        }
      };
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const body = res.clone().body;
        if (!body) {
          finish(false);
          return;
        }
        reader = body.getReader();
      } catch {
        finish(false);
        return;
      }
      const r = reader;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          r.cancel();
        } catch {
          /* ignore */
        }
        finish(true);
      }, budgetMs);
      const dec = new TextDecoder();
      (async () => {
        let capped = false;
        try {
          for (;;) {
            const { done, value } = await r.read();
            if (done) break;
            out += dec.decode(value, { stream: true });
            if (out.length >= maxChars) {
              out = out.slice(0, maxChars);
              capped = true;
              break;
            }
          }
          if (!capped) out += dec.decode();
        } catch {
          /* partial prefix is fine */
        }
        clearTimeout(timer);
        try {
          r.cancel();
        } catch {
          /* ignore */
        }
        finish(capped || timedOut);
      })();
    });
  }

  // ---- manifest body capture --------------------------------------------
  // The player has already downloaded every playlist it needs, with exactly
  // the cookies/Referer/Origin/fingerprint the CDN accepts. Re-fetching the
  // same URL from the extension is what fails (403/404 on most token-gated
  // CDNs), so we keep the bytes the page itself received and hand those to the
  // extension instead. Bounded: a handful of playlists, a hard char cap, a TTL,
  // and its own inflight/rate budget so page traffic is never slowed.
  const MANIFEST_PATH_RE = /\.(m3u8|mpd)(?:$|[?#])/i;
  /** Playlist served under a disguised/extensionless path. */
  const PLAYLIST_CT_RE = /(mpegurl|dash\+xml|vnd\.apple\.mpegurl)/i;
  const MANIFEST_MAX_ENTRIES = 8;
  const MANIFEST_MAX_CHARS = 2_000_000;
  const MANIFEST_MAX_AGE_MS = 10 * 60_000;
  const MANIFEST_PEEK_BUDGET_MS = 4000;
  // A master plus its variant playlists can load in parallel: allow two.
  const MANIFEST_MAX_INFLIGHT = 2;
  const MANIFEST_MAX_PER_WINDOW = 12;
  const MANIFEST_WINDOW_MS = 10_000;
  let manifestInflight = 0;
  let manifestWindowStart = Date.now();
  let manifestWindowCount = 0;

  interface ManifestEntry {
    url: string;
    text: string;
    at: number;
    /** Path-alias entry: the query string differed from the request. */
    alias: boolean;
  }
  const manifests = new Map<string, ManifestEntry>();
  /** path-alias -> the distinct URLs captured for it (ambiguity guard). */
  const manifestPaths = new Map<string, Set<string>>();

  function manifestAllowed(): boolean {
    const now = Date.now();
    if (now - manifestWindowStart > MANIFEST_WINDOW_MS) {
      manifestWindowStart = now;
      manifestWindowCount = 0;
    }
    if (manifestInflight >= MANIFEST_MAX_INFLIGHT || manifestWindowCount >= MANIFEST_MAX_PER_WINDOW) {
      return false;
    }
    manifestWindowCount++;
    return true;
  }

  /** Query-stripped identity: playlist tokens rotate, the path does not. */
  function manifestAlias(url: string): string {
    try {
      const u = new URL(url);
      return `${u.origin}${u.pathname}`.toLowerCase();
    } catch {
      return url;
    }
  }

  function pruneManifests(now: number): void {
    let dropped = false;
    manifests.forEach((e, k) => {
      if (now - e.at > MANIFEST_MAX_AGE_MS) {
        manifests.delete(k);
        dropped = true;
      }
    });
    if (!dropped) return;
    // Keep the ambiguity guard in step with the live entries.
    manifestPaths.forEach((urls, path) => {
      urls.forEach((u) => {
        if (!manifests.has(u)) urls.delete(u);
      });
      if (!urls.size) manifestPaths.delete(path);
    });
  }

  function recordManifest(url: string, text: string): void {
    if (!text || text.length > MANIFEST_MAX_CHARS) return; // partial playlists are worse than none
    const now = Date.now();
    pruneManifests(now);
    manifests.set(url, { url, text, at: now, alias: false });
    const alias = manifestAlias(url);
    if (alias !== url) {
      manifests.set(alias, { url, text, at: now, alias: true });
      let urls = manifestPaths.get(alias);
      if (!urls) {
        urls = new Set<string>();
        manifestPaths.set(alias, urls);
      }
      urls.add(url);
    }
    while (manifests.size > MANIFEST_MAX_ENTRIES * 2) {
      const oldest = manifests.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      manifests.delete(oldest);
    }
  }

  /**
   * Exact-URL hit first; the path alias covers a rotated token. The alias is
   * used only when exactly one URL was ever captured for that path — two videos
   * sharing `/hls/stream.m3u8` must never be handed each other's playlist.
   */
  function findManifest(url: string): ManifestEntry | undefined {
    const now = Date.now();
    pruneManifests(now);
    const exact = manifests.get(url);
    if (exact) return exact;
    const alias = manifestAlias(url);
    if (alias === url) return undefined;
    const urls = manifestPaths.get(alias);
    if (!urls || urls.size !== 1) return undefined;
    return manifests.get(alias);
  }

  /** Read a playlist the page just fetched, into the capture store. */
  function captureManifestBody(res: Response, url: string): void {
    manifestInflight++;
    void peekBody(res, MANIFEST_MAX_CHARS, MANIFEST_PEEK_BUDGET_MS)
      .then((r) => {
        if (r.truncated) return;
        if (r.text) recordManifest(url, r.text);
      })
      .catch(() => undefined)
      .finally(() => {
        manifestInflight--;
      });
  }

  // ---- page-relayed bytes (segments the extension may not fetch) --------
  // The CDN treats this world's request and the extension's differently: the
  // token, Referer/Origin/Sec-Fetch-*, cookies and the network fingerprint all
  // match the page. So when the extension is refused a segment, it asks here
  // for that one URL; the bytes are held briefly and served as ≤4MB slices.
  const SEG_MAX_BYTES = 64_000_000; // one segment; absurd payloads are refused
  const SEG_SLICE = 4_000_000;
  const SEG_MAX_ENTRIES = 2;
  const SEG_TTL_MS = 60_000;
  const SEG_FETCH_TIMEOUT_MS = 90_000;
  interface SegEntry {
    buf: ArrayBuffer;
    at: number;
    ctrl: AbortController;
    /** Fetched and awaiting slices (in-flight entries are never evicted). */
    ready: boolean;
  }
  const segStore = new Map<string, SegEntry>();

  function closeSeg(token: string): void {
    const e = segStore.get(token);
    if (!e) return;
    segStore.delete(token);
    try {
      e.ctrl.abort();
    } catch {
      /* ignore */
    }
  }

  function pruneSegs(now: number): void {
    segStore.forEach((e, k) => {
      if (e.ready && now - e.at > SEG_TTL_MS) closeSeg(k);
    });
  }

  /** Drop idle buffers over the cap; never abort a fetch still in flight. */
  function evictSegs(keep: string): void {
    while (segStore.size > SEG_MAX_ENTRIES) {
      let victim: string | undefined;
      segStore.forEach((e, k) => {
        if (victim === undefined && k !== keep && e.ready) victim = k;
      });
      if (victim === undefined) return;
      closeSeg(victim);
    }
  }

  // ---- page-context service (isolated world asks, page world answers) ----
  window.addEventListener("message", (event) => {
    try {
      if (event.source !== window) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = event.data as any;
      if (!d || typeof d !== "object" || typeof d.nonce !== "string") return;
      if (d.__vdg === "manifest-text" && typeof d.url === "string") {
        const hit = findManifest(d.url);
        window.postMessage(
          {
            __vdg: "manifest-text-result",
            nonce: d.nonce,
            url: d.url,
            found: Boolean(hit),
            source: hit?.url,
            alias: hit?.alias === true,
            text: hit?.text ?? "",
          },
          "*",
        );
        return;
      }
      if (d.__vdg === "seg-open" && typeof d.url === "string") {
        const nonce = d.nonce;
        const token = nonce;
        const url = String(d.url);
        void (async () => {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), SEG_FETCH_TIMEOUT_MS);
          try {
            pruneSegs(Date.now());
            segStore.set(token, { buf: new ArrayBuffer(0), at: Date.now(), ctrl, ready: false });
            const res = await window.fetch(url, { credentials: "include", signal: ctrl.signal });
            if (!res.ok) {
              closeSeg(token);
              window.postMessage(
                { __vdg: "seg-open-result", nonce, url, ok: false, status: res.status },
                "*",
              );
              return;
            }
            const buf = await res.arrayBuffer();
            if (buf.byteLength === 0 || buf.byteLength > SEG_MAX_BYTES) {
              closeSeg(token);
              window.postMessage(
                {
                  __vdg: "seg-open-result",
                  nonce,
                  url,
                  ok: false,
                  error:
                    buf.byteLength === 0 ? "The page got an empty response." : "Chunk too large.",
                },
                "*",
              );
              return;
            }
            segStore.set(token, { buf, at: Date.now(), ctrl, ready: true });
            // Keep the page's memory bounded: newest two chunks only.
            evictSegs(token);
            window.postMessage(
              { __vdg: "seg-open-result", nonce, url, ok: true, size: buf.byteLength },
              "*",
            );
          } catch (err) {
            closeSeg(token);
            window.postMessage(
              {
                __vdg: "seg-open-result",
                nonce,
                url,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
              "*",
            );
          } finally {
            clearTimeout(timer);
          }
        })();
        return;
      }
      if (d.__vdg === "seg-slice" && typeof d.token === "string") {
        const e = segStore.get(d.token);
        if (!e) {
          window.postMessage(
            { __vdg: "seg-slice-result", nonce: d.nonce, error: "Chunk is no longer buffered." },
            "*",
          );
          return;
        }
        const cursor = Math.max(0, Math.min(e.buf.byteLength, Number(d.cursor) || 0));
        const end = Math.min(e.buf.byteLength, cursor + SEG_SLICE);
        const slice = e.buf.slice(cursor, end);
        e.at = Date.now();
        try {
          window.postMessage(
            {
              __vdg: "seg-slice-result",
              nonce: d.nonce,
              cursor,
              next: end,
              done: end >= e.buf.byteLength,
              total: e.buf.byteLength,
              buf: slice,
            },
            "*",
            [slice],
          );
        } catch {
          window.postMessage(
            { __vdg: "seg-slice-result", nonce: d.nonce, error: "Chunk transfer failed." },
            "*",
          );
        }
        return;
      }
      if (d.__vdg === "seg-close" && typeof d.token === "string") {
        closeSeg(String(d.token));
        return;
      }
      if (d.__vdg === "page-fetch" && typeof d.url === "string") {
        const nonce = d.nonce;
        const url = String(d.url);
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 12_000);
        // window.fetch is the hooked wrapper, so this request also feeds the
        // capture store — the page's own context, for the extension's benefit.
        void window
          .fetch(url, { credentials: "include", signal: ctrl.signal })
          .then(async (res) => {
            if (!res.ok) {
              window.postMessage(
                { __vdg: "page-fetch-result", nonce, url, ok: false, status: res.status },
                "*",
              );
              return;
            }
            const body = await peekBody(res, MANIFEST_MAX_CHARS, 8000);
            window.postMessage(
              {
                __vdg: "page-fetch-result",
                nonce,
                url,
                ok: true,
                status: res.status,
                text: body.text,
                truncated: body.truncated,
              },
              "*",
            );
          })
          .catch((err: unknown) => {
            window.postMessage(
              {
                __vdg: "page-fetch-result",
                nonce,
                url,
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              },
              "*",
            );
          })
          .finally(() => clearTimeout(timer));
      }
    } catch {
      /* never break page messaging */
    }
  });

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
        if (!url || skippable(url)) return p;
        const urlIsPlaylist = MANIFEST_PATH_RE.test(url);
        if (!urlIsPlaylist && mediaish(url, null)) return p;
        p.then((res) => {
          let started = false;
          try {
            if (!res.ok) return; // error pages never carry manifests
            const ct = res.headers?.get?.("content-type") ?? null;
            // Playlist the player is loading (by extension or content type):
            // keep the bytes it received — the extension cannot re-fetch them
            // with the same cookies/Referer/Origin/fingerprint. Bounded.
            if (urlIsPlaylist || PLAYLIST_CT_RE.test(ct ?? "")) {
              if (manifestAllowed()) captureManifestBody(res, url);
              return;
            }
            if (pageHidden()) return; // background tab: never spend its CPU
            if (!peekAllowed()) return;
            if (mediaish(url, ct) || !apiish(ct)) return;
            const len = Number(res.headers?.get?.("content-length") ?? "0");
            const jsonish = (ct ?? "").toLowerCase().includes("json");
            // Instagram GraphQL bodies are often >400KB; the peek itself is
            // still bounded. Only skip absurd payloads.
            if (!jsonish && len > MAX_BODY * 2) return;
            if (jsonish && len > 5_000_000) return;
            started = true;
            peekInflight++;
            void peekBody(res, jsonish ? 800_000 : MAX_BODY, jsonish ? 2500 : PEEK_TIME_MS)
              .then((r) => handleText(r.text))
              .catch(() => undefined)
              .finally(() => {
                peekInflight--;
              });
          } catch {
            if (started) peekInflight--;
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
              // Binary/blob consumers never carry manifest text.
              const rt = (this as XMLHttpRequest).responseType;
              if (rt !== "" && rt !== "text" && rt !== "json") return;
              const rec = this as unknown as Record<string, unknown>;
              if (String(rec.__vdgMethod ?? "GET").toUpperCase() !== "GET") return;
              const url = String(rec.__vdgUrl ?? "");
              if (!url || skippable(url)) return;
              const urlIsPlaylist = MANIFEST_PATH_RE.test(url);
              if (!urlIsPlaylist && mediaish(url, null)) return;
              const responseCt =
                typeof this.getResponseHeader === "function"
                  ? this.getResponseHeader("content-type")
                  : null;
              // Playlist the player loaded (by extension or content type): keep
              // exactly the bytes it received.
              if (urlIsPlaylist || PLAYLIST_CT_RE.test(responseCt ?? "")) {
                if (manifestAllowed()) {
                  const body = typeof this.responseText === "string" ? this.responseText : "";
                  if (body) recordManifest(url, body);
                }
                return;
              }
              if (pageHidden()) return;
              if (!peekAllowed()) return;
              if (mediaish(url, responseCt) || !apiish(responseCt)) return;
              let text = "";
              if (rt === "json") {
                try {
                  const resp = this.response;
                  text = typeof resp === "string" ? resp : JSON.stringify(resp);
                } catch {
                  return;
                }
              } else {
                text = typeof this.responseText === "string" ? this.responseText : "";
              }
              if (!text) return;
              if (text.length > 800_000) text = text.slice(0, 800_000);
              handleText(text);
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

  // ---- Blob object-URL registry ----
  // Players that fetch a whole file and play it via URL.createObjectURL(new
  // Blob(...)) expose no manifest and no MSE traffic — the bytes only exist
  // as a page Blob. We retain a bounded registry of (url -> Blob) so the
  // extension can stream the exact bytes out on download. Only blobs that a
  // <video> element actually references are ever surfaced; entries are
  // age-pruned and the page's own playback is untouched.
  const BLOB_MIN_SIZE = 100_000;
  const BLOB_MAX_ENTRIES = 30;
  const BLOB_MAX_AGE_MS = 15 * 60_000;
  const BLOB_SLICE = 4_000_000;
  interface BlobEntry {
    blob: Blob;
    size: number;
    type: string;
    at: number;
  }
  const blobStore = new Map<string, BlobEntry>();

  function isMediaSourceObj(obj: unknown): boolean {
    try {
      const w = window as unknown as { MediaSource?: object; ManagedMediaSource?: object };
      if (w.MediaSource && obj instanceof (w.MediaSource as object as new () => object)) return true;
      if (w.ManagedMediaSource && obj instanceof (w.ManagedMediaSource as object as new () => object)) {
        return true;
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  function recordBlobUrl(url: string, obj: unknown): void {
    try {
      if (isMediaSourceObj(obj)) return;
      const b = obj as Partial<Blob>;
      if (!b || typeof b.size !== "number" || typeof b.slice !== "function") return;
      if (b.size < BLOB_MIN_SIZE) return;
      if (blobStore.size >= BLOB_MAX_ENTRIES) {
        // Evict the oldest entry.
        let oldestKey: string | undefined;
        let oldestAt = Infinity;
        blobStore.forEach((e, k) => {
          if (e.at < oldestAt) {
            oldestAt = e.at;
            oldestKey = k;
          }
        });
        if (oldestKey !== undefined) blobStore.delete(oldestKey);
      }
      blobStore.set(url, {
        blob: obj as Blob,
        size: b.size,
        type: typeof b.type === "string" ? b.type : "",
        at: Date.now(),
      });
    } catch {
      /* ignore */
    }
  }

  function pruneBlobs(now: number): void {
    try {
      blobStore.forEach((e, k) => {
        if (now - e.at > BLOB_MAX_AGE_MS) blobStore.delete(k);
      });
    } catch {
      /* ignore */
    }
  }

  function blobList(): unknown[] {
    pruneBlobs(Date.now());
    const out: unknown[] = [];
    blobStore.forEach((e, url) => {
      out.push({ url, size: e.size, type: e.type });
    });
    return out;
  }

  try {
    window.addEventListener("message", (event) => {
      try {
        if (event.source !== window) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const d = event.data as any;
        if (!d || typeof d !== "object" || typeof d.nonce !== "string") return;
        if (d.__vdg === "blob-list") {
          window.postMessage({ __vdg: "blob-list-result", nonce: d.nonce, blobs: blobList() }, "*");
        } else if (d.__vdg === "blob-info" && typeof d.url === "string") {
          pruneBlobs(Date.now());
          const e = blobStore.get(d.url);
          if (!e) {
            window.postMessage({ __vdg: "blob-info-result", nonce: d.nonce, error: "Blob expired — replay the video and Rescan." }, "*");
          } else {
            window.postMessage(
              { __vdg: "blob-info-result", nonce: d.nonce, size: e.size, type: e.type },
              "*",
            );
          }
        } else if (d.__vdg === "blob-get" && typeof d.url === "string") {
          const e = blobStore.get(d.url);
          if (!e) {
            window.postMessage({ __vdg: "blob-chunk", nonce: d.nonce, error: "Blob expired — replay the video and Rescan." }, "*");
            return;
          }
          const cursor = Math.max(0, Number(d.cursor) || 0);
          const len = Math.min(BLOB_SLICE, Math.max(1, Number(d.len) || BLOB_SLICE));
          if (cursor >= e.size) {
            window.postMessage({ __vdg: "blob-chunk", nonce: d.nonce, cursor, next: cursor, done: true, total: e.size }, "*");
            return;
          }
          const end = Math.min(e.size, cursor + len);
          void (async () => {
            try {
              const buf = await e.blob.slice(cursor, end).arrayBuffer();
              const res: Record<string, unknown> = {
                __vdg: "blob-chunk",
                nonce: d.nonce,
                cursor,
                next: cursor + buf.byteLength,
                done: cursor + buf.byteLength >= e.size,
                total: e.size,
                buf,
              };
              try {
                window.postMessage(res, "*", [buf]);
              } catch {
                try {
                  window.postMessage(res, "*");
                } catch {
                  /* ignore */
                }
              }
            } catch {
              try {
                window.postMessage({ __vdg: "blob-chunk", nonce: d.nonce, error: "Blob read failed." }, "*");
              } catch {
                /* ignore */
              }
            }
          })();
        }
      } catch {
        /* ignore */
      }
    });
  } catch {
    /* ignore */
  }

  // ---- MediaSource / SourceBuffer capture ----
  // Large players feed segments via MediaSource, so <video> shows only a
  // blob: URL. We copy the exact bytes appended per SourceBuffer (in order),
  // which reassemble into playable per-track files for CLEAR content only.
  // Any EME (Widevine/FairPlay/PlayReady-style) involvement marks the
  // session refused — captured DRM bytes are never offered for download.
  //
  // MEMORY BOUNDS (idle pages must not grow): per-track cap, a small max
  // session count with oldest-first eviction, prompt freeing of DRM-tainted
  // buffers, and pruning of sessions that never received data. Once a cap
  // hits, the wrapper degrades to pure passthrough (zero copy).
  try {
    const TRACK_CAP = 64_000_000; // per-track memory cap (was 250MB)
    const MAX_SESSIONS = 4; // oldest session evicted beyond this
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
      lastAppend: number;
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

    function freeSession(s: MsSession): void {
      for (const t of s.tracks) {
        t.parts = [];
        t.bytes = 0;
        t.overflow = true; // refused/complete: wrapper becomes passthrough
      }
    }

    function sessionBytes(s: MsSession): number {
      let n = 0;
      for (const t of s.tracks) n += t.bytes;
      return n;
    }

    function evictOldest(): void {
      let oldestId: string | undefined;
      let oldestTs = Infinity;
      sessions.forEach((s, id) => {
        if (s.created < oldestTs) {
          oldestTs = s.created;
          oldestId = id;
        }
      });
      if (oldestId !== undefined) sessions.delete(oldestId);
      // blobToMs entries are bounded separately below.
      while (blobToMs.size > 100) {
        const first = blobToMs.keys().next().value as string | undefined;
        if (!first) break;
        blobToMs.delete(first);
      }
    }

    function pruneEmptySessions(now: number): void {
      sessions.forEach((s, id) => {
        if (s.tracks.length === 0 && now - s.created > 60_000) sessions.delete(id);
        else if (sessionBytes(s) === 0 && now - s.created > 120_000) sessions.delete(id);
      });
    }

    function ensureMs(ms: object): string {
      let id = msByObj.get(ms);
      if (!id) {
        if (sessions.size >= MAX_SESSIONS) evictOldest();
        id = `ms-${++msSeq}`;
        msByObj.set(ms, id);
        sessions.set(id, {
          id,
          tracks: [],
          eme: false,
          created: Date.now(),
          lastAppend: Date.now(),
        });
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

    function byteLengthOf(data: unknown): number {
      try {
        if (data instanceof ArrayBuffer) return data.byteLength;
        if (ArrayBuffer.isView(data)) {
          return (data as ArrayBufferView).byteLength;
        }
      } catch {
        /* ignore */
      }
      return 0;
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
          if (isMediaSourceObj(obj)) {
            const id = ensureMs(obj as object);
            blobToMs.set(url, id);
            while (blobToMs.size > 100) {
              const first = blobToMs.keys().next().value as string | undefined;
              if (!first) break;
              blobToMs.delete(first);
            }
            const s = sessions.get(id);
            if (s) s.blobUrl = url;
          } else {
            // Whole-file Blob playback (fetch -> Blob -> video.src): retain
            // for exact-byte download if a <video> picks it up.
            recordBlobUrl(url, obj);
          }
        } catch {
          /* ignore */
        }
        return url;
      };
    } catch {
      /* ignore */
    }

    // -- addSourceBuffer: bind track. appendBuffer is wrapped on the
    // prototype below so players that call SourceBuffer.prototype.appendBuffer
    // (Instagram/Facebook, dash.js) still get captured.
    function captureAppend(sb: object, data: unknown): void {
      try {
        const info = sbInfo.get(sb);
        const sess = info ? sessions.get(info.msId) : undefined;
        const trk = sess?.tracks[info?.trackIdx ?? -1];
        if (trk && !trk.overflow && sess && !sess.eme && !pageEme) {
          const len = byteLengthOf(data);
          if (len > 0) {
            sess.lastAppend = Date.now();
            if (trk.bytes + len > TRACK_CAP) {
              trk.overflow = true;
            } else {
              const bytes = toBytes(data);
              if (bytes && bytes.byteLength > 0) {
                trk.parts.push(bytes);
                trk.bytes += bytes.byteLength;
              }
            }
          }
        }
      } catch {
        /* capture must never break playback */
      }
    }

    function wrapAddSourceBuffer(proto: { addSourceBuffer?: (mime: string) => SourceBuffer } | undefined): void {
      if (!proto?.addSourceBuffer) return;
      const origAdd = proto.addSourceBuffer;
      proto.addSourceBuffer = function (this: MediaSource, mime: string): SourceBuffer {
        const sb = origAdd.call(this, mime);
        try {
          const msId = ensureMs(this as object);
          const session = sessions.get(msId);
          const trackIdx = session ? session.tracks.length : 0;
          const track: MsTrack = {
            mime: String(mime ?? ""),
            kind: trackKind(String(mime ?? "")),
            parts: [],
            bytes: 0,
            overflow: false,
          };
          session?.tracks.push(track);
          sbInfo.set(sb as object, { msId, trackIdx });
        } catch {
          /* ignore */
        }
        return sb;
      };
    }

    try {
      wrapAddSourceBuffer(MS.MediaSource?.prototype);
      const MMS = (window as unknown as { ManagedMediaSource?: { prototype?: { addSourceBuffer?: (mime: string) => SourceBuffer } } })
        .ManagedMediaSource;
      wrapAddSourceBuffer(MMS?.prototype);
    } catch {
      /* ignore */
    }

    try {
      const SB = (window as unknown as { SourceBuffer?: { prototype?: { appendBuffer?: (data: BufferSource) => void } } }).SourceBuffer;
      if (SB?.prototype?.appendBuffer) {
        const origAppend = SB.prototype.appendBuffer;
        SB.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource): void {
          captureAppend(this as object, data);
          origAppend.call(this, data);
        };
      }
    } catch {
      /* ignore */
    }

    // -- EME detection: attribute to sessions, plus page-level flag --
    // Newly-tainted sessions release buffered bytes immediately.
    function markEme(el: unknown): void {
      try {
        pageEme = true;
        const s = sessionForElement(el);
        if (s && !s.eme) {
          s.eme = true;
          freeSession(s);
        }
      } catch {
        /* ignore */
      }
    }
    function markPageEme(): void {
      try {
        if (!pageEme) {
          pageEme = true;
          sessions.forEach((s) => {
            if (!s.eme) {
              s.eme = true;
              freeSession(s);
            }
          });
        }
      } catch {
        /* ignore */
      }
    }
    try {
      const nav = navigator as unknown as Record<string, unknown>;
      if (typeof nav.requestMediaKeySystemAccess === "function") {
        const origRMKSA = (navigator.requestMediaKeySystemAccess as Function).bind(navigator);
        (nav as Record<string, unknown>).requestMediaKeySystemAccess = function (...args: unknown[]): Promise<unknown> {
          markPageEme();
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
      try {
        pruneEmptySessions(Date.now());
      } catch {
        /* ignore */
      }
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
