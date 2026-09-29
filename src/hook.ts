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
  // The untouched fetch, kept for our own reads (blob: URLs must not be run
  // through the instrumented wrapper below — it would peek at page blobs).
  let nativeFetch: typeof fetch | undefined;

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
            const res = await window.fetch(url, {
              credentials: "include",
              cache: "no-store",
              signal: ctrl.signal,
            });
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
          .fetch(url, { credentials: "include", cache: "no-store", signal: ctrl.signal })
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
    nativeFetch = origFetch;
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

  /** Bounded retention of a page Blob keyed by its object URL. */
  function storeBlob(url: string, blob: Blob): void {
    try {
      if (blobStore.size >= BLOB_MAX_ENTRIES && !blobStore.has(url)) {
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
        blob,
        size: blob.size,
        type: typeof blob.type === "string" ? blob.type : "",
        at: Date.now(),
      });
    } catch {
      /* ignore */
    }
  }

  function recordBlobUrl(url: string, obj: unknown): void {
    try {
      if (isMediaSourceObj(obj)) return;
      const b = obj as Partial<Blob>;
      if (!b || typeof b.size !== "number" || typeof b.slice !== "function") return;
      if (b.size < BLOB_MIN_SIZE) return;
      storeBlob(url, obj as Blob);
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
        } else if (d.__vdg === "blob-resolve" && typeof d.url === "string") {
          // Registry hit answers here (the MSE-half resolver below owns the
          // session/live-fetch cases), so a held Blob resolves even if the
          // capture half of this hook failed to initialize.
          pruneBlobs(Date.now());
          const held = blobStore.get(d.url);
          if (held) {
            window.postMessage(
              {
                __vdg: "blob-resolve-result",
                nonce: d.nonce,
                kind: "blob",
                size: held.size,
                type: held.type,
              },
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
    // Per-track memory cap. 64 MB used to cut long videos off mid-way without
    // saying so; 256 MB covers ~6 minutes of 1080p while staying well inside a
    // tab's heap. Past the cap the wrapper degrades to pure passthrough and the
    // download reports the truncation.
    const TRACK_CAP = 256_000_000;
    /** A session being read by the extension is never evicted for this long. */
    const SESSION_PIN_MS = 120_000;
    const MAX_SESSIONS = 4; // oldest session evicted beyond this
    const XFER = 4_000_000; // bytes per postMessage chunk
    const BLOB_RESOLVE_MS = 8000; // budget for reading a blob: URL in-page

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
      /**
       * Wall-clock deadline until which this session must not be evicted or
       * pruned. Set while the extension is streaming it out, so a busy page
       * (several players, e.g. a feed) cannot drop a buffer mid-download and
       * fail the job with "Capture session expired".
       */
      pinnedUntil: number;
    }

    const MS = window as unknown as {
      MediaSource?: typeof MediaSource;
    };
    let msSeq = 0;
    let pageEme = false;
    let emeProbed = false;
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
      // Sessions the extension is actively reading are evicted last: dropping
      // one mid-transfer fails a download the user already started, while an
      // idle player can simply be re-detected on the next scan.
      const now = Date.now();
      let victimId: string | undefined;
      let victimTs = Infinity;
      let fallbackId: string | undefined;
      let fallbackTs = Infinity;
      sessions.forEach((s, id) => {
        if (s.pinnedUntil > now) {
          if (s.created < fallbackTs) {
            fallbackTs = s.created;
            fallbackId = id;
          }
          return;
        }
        if (s.created < victimTs) {
          victimTs = s.created;
          victimId = id;
        }
      });
      const chosen = victimId ?? fallbackId;
      if (chosen !== undefined) sessions.delete(chosen);
      // blobToMs entries are bounded separately below.
      while (blobToMs.size > 100) {
        const first = blobToMs.keys().next().value as string | undefined;
        if (!first) break;
        blobToMs.delete(first);
      }
    }

    function pruneEmptySessions(now: number): void {
      sessions.forEach((s, id) => {
        if (s.pinnedUntil > now) return; // being downloaded right now
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
          pinnedUntil: 0,
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
        let info = sbInfo.get(sb);
        // The player called addSourceBuffer before this hook wrapped the
        // prototype (tab open before install/reload, early iframe): there is
        // no binding, but the bytes are still the video. Attribute them to
        // the most recently active clear session, or an orphan session as a
        // last resort — dropping them is exactly the "play for minutes, still
        // empty buffer" failure.
        if (!info) {
          let best: MsSession | undefined;
          sessions.forEach((s) => {
            if (s.eme) return;
            if (!best || s.lastAppend >= best.lastAppend) best = s;
          });
          if (!best) {
            if (sessions.size >= MAX_SESSIONS) evictOldest();
            const id = `ms-${++msSeq}`;
            best = {
              id,
              tracks: [],
              eme: false,
              created: Date.now(),
              lastAppend: Date.now(),
              pinnedUntil: 0,
            };
            sessions.set(id, best);
          }
          const trackIdx = best.tracks.length;
          best.tracks.push({ mime: "", kind: "other", parts: [], bytes: 0, overflow: false });
          info = { msId: best.id, trackIdx };
          sbInfo.set(sb, info);
        }
        const sess = info ? sessions.get(info.msId) : undefined;
        const trk = sess?.tracks[info?.trackIdx ?? -1];
        // Only this session's own DRM taint blocks capture; a DRM player
        // elsewhere on the page must not silence a clear one.
        if (trk && !trk.overflow && sess && !sess.eme) {
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
      const SB = (window as unknown as { SourceBuffer?: { prototype?: { appendBuffer?: (data: BufferSource) => void; changeType?: (mime: string) => void } } }).SourceBuffer;
      if (SB?.prototype?.appendBuffer) {
        const origAppend = SB.prototype.appendBuffer;
        SB.prototype.appendBuffer = function (this: SourceBuffer, data: BufferSource): void {
          captureAppend(this as object, data);
          origAppend.call(this, data);
        };
      }
      // A quality switch reuses the SAME SourceBuffer with a new codec/mime.
      // Without a split, one track mixes two inits and the saver must cut the
      // file where the new quality begins. Start a fresh track instead so each
      // quality stays a clean, downloadable stream (biggest wins at pick).
      if (SB?.prototype && typeof SB.prototype.changeType === "function") {
        const origChange = SB.prototype.changeType;
        SB.prototype.changeType = function (this: SourceBuffer, mime: string): void {
          try {
            const info = sbInfo.get(this as object);
            const sess = info ? sessions.get(info.msId) : undefined;
            if (sess && !sess.eme) {
              const trackIdx = sess.tracks.length;
              sess.tracks.push({
                mime: String(mime ?? ""),
                kind: trackKind(String(mime ?? "")),
                parts: [],
                bytes: 0,
                overflow: false,
              });
              sbInfo.set(this as object, { msId: sess.id, trackIdx });
            }
          } catch {
            /* ignore */
          }
          origChange.call(this, mime);
        };
      }
    } catch {
      /* ignore */
    }

    // -- EME detection --------------------------------------------------
    // DRM is tainted per SESSION, never page-wide. Meta (Instagram/Facebook)
    // and many other players call requestMediaKeySystemAccess just to probe
    // capability and then play clear content; treating that probe as "this
    // page is DRM" used to free every buffer and refuse every row, which is
    // exactly why clear reels showed nothing but a dead placeholder. Only a
    // real encrypted-media signal — keys attached to an element, or an
    // `encrypted` event on it — refuses (and releases) that player's session.
    function markEme(el: unknown): void {
      try {
        pageEme = true; // informational: some player on this page really uses DRM
        const s = sessionForElement(el);
        if (s && !s.eme) {
          s.eme = true;
          freeSession(s);
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
          emeProbed = true; // a capability probe, not DRM playback
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
          emeProbed,
        });
      });
      return out;
    }

    // -- blob: URL -> bytes -------------------------------------------------
    // A `<video src="blob:...">` is either a whole file wrapped in a Blob or a
    // live MediaSource buffer. Resolve which, so a Download click on a blob
    // row either streams the page's own bytes or pulls the captured appends.
    function sessionForBlobUrl(url: string): MsSession | undefined {
      const mapped = blobToMs.get(url);
      if (mapped) {
        const s = sessions.get(mapped);
        if (s) return s;
      }
      let hit: MsSession | undefined;
      sessions.forEach((s) => {
        if (!hit && s.blobUrl === url) hit = s;
      });
      if (hit) return hit;
      // Object URL created before this hook ran (map empty): find the element
      // playing it and read the session off the element instead. Only ever
      // reached on a Download click, so the element scan is not steady-state.
      try {
        const els = document.querySelectorAll("video,audio");
        for (const el of Array.from(els)) {
          const src = (el as HTMLMediaElement).currentSrc || el.getAttribute("src") || "";
          if (src !== url) continue;
          const s = sessionForElement(el);
          if (s) {
            s.blobUrl = s.blobUrl ?? url;
            return s;
          }
        }
      } catch {
        /* ignore */
      }
      return undefined;
    }

    function trackInfo(s: MsSession): unknown[] {
      return s.tracks.map((t, idx) => ({ idx, kind: t.kind, bytes: t.bytes }));
    }

    /**
     * Is a `<video>` playing this URL straight from a MediaSource object? Such
     * a URL is a live stream, not a file: reading it can consume the player's
     * own buffer, so it must be refused rather than fetched.
     */
    function isMediaSourceUrl(url: string): boolean {
      try {
        for (const el of Array.from(document.querySelectorAll("video,audio"))) {
          const src = (el as HTMLMediaElement).currentSrc || el.getAttribute("src") || "";
          if (src !== url) continue;
          const so = (el as { srcObject?: unknown }).srcObject;
          if (so && typeof so === "object" && isMediaSourceObj(so)) return true;
        }
      } catch {
        /* ignore */
      }
      return false;
    }

    /**
     * `allowFetch:false` answers from what the page already handed us (cheap
     * enough for a frame-ownership probe). `allowFetch:true` additionally
     * reads the object URL itself — any Blob-backed URL yields its bytes, even
     * one created before this hook was injected or evicted from the registry;
     * a MediaSource URL cannot be fetched, and is reported as such.
     */
    async function resolveBlob(url: string, allowFetch: boolean): Promise<Record<string, unknown>> {
      pruneBlobs(Date.now());
      const cached = blobStore.get(url);
      if (cached) {
        return { __vdg: "blob-resolve-result", kind: "blob", size: cached.size, type: cached.type };
      }
      const sess = sessionForBlobUrl(url);
      if (sess) {
        return {
          __vdg: "blob-resolve-result",
          kind: "mse",
          sessionId: sess.id,
          eme: sess.eme,
          tracks: trackInfo(sess),
        };
      }
      if (!allowFetch) return { __vdg: "blob-resolve-result", error: "not-held" };
      // Live stream, no captured bytes to fall back on: say so instead of
      // reading a buffer the player is still writing.
      if (isMediaSourceUrl(url)) return { __vdg: "blob-resolve-result", error: "not-fetchable" };
      const fetchImpl = nativeFetch ?? window.fetch.bind(window);
      const ctrl = new AbortController();
      const timer = setTimeout(() => {
        try {
          ctrl.abort();
        } catch {
          /* ignore */
        }
      }, BLOB_RESOLVE_MS);
      try {
        const res = await fetchImpl(url, { signal: ctrl.signal });
        if (!res.ok) return { __vdg: "blob-resolve-result", error: `not-fetchable:${res.status}` };
        const blob = await res.blob();
        if (blob.size <= 0) return { __vdg: "blob-resolve-result", error: "empty" };
        storeBlob(url, blob);
        return {
          __vdg: "blob-resolve-result",
          kind: "blob",
          size: blob.size,
          type: typeof blob.type === "string" ? blob.type : "",
        };
      } catch {
        // Chrome rejects a MediaSource object URL outright; a revoked blob
        // fails the same way. Either way there is nothing to read here.
        return { __vdg: "blob-resolve-result", error: "not-fetchable" };
      } finally {
        clearTimeout(timer);
      }
    }

    function serveSlice(id: string, trackIdx: number, cursor: number): unknown {
      const s = sessions.get(id);
      const t = s?.tracks[trackIdx];
      if (!s || !t) return { __vdg: "ms-chunk", error: "Capture session expired (page navigated or video reloaded)." };
      // Reading counts as "in use": keep this buffer alive for the rest of the
      // transfer even if the page opens more players meanwhile.
      s.pinnedUntil = Date.now() + SESSION_PIN_MS;
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
        } else if (d.__vdg === "blob-resolve" && d.nonce && typeof d.url === "string") {
          void resolveBlob(d.url, d.allowFetch === true).then((res) => {
            try {
              window.postMessage({ ...res, nonce: d.nonce }, "*");
            } catch {
              /* ignore */
            }
          });
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
