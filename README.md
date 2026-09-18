# Video Download Grabber (local-only MV3 extension)

Detect playable video on any tab and download it locally — no backend, no third-party calls.

## What it does

- **Works anywhere**: `<all_urls>` host + content-script coverage (all frames), so feeds, embeds, and players on any site are detected. (Chrome will show a broad-access warning at install — that access is what lets it see video traffic; everything stays local.)
- **Many video types**: direct `mp4/m4v/webm/ogv/mov/mkv/avi/flv/wmv/mpg/3gp` (by URL and by `content-type`), HLS (`.m3u8`, incl. fMP4 with `#EXT-X-MAP` init segments), DASH (`.mpd`, incl. init segments). A conservative chunk-score keeps raw stream fragments (`.m4s`, init segments, `/avc1/0/0/…` paths) out of the list — the playlist item covers them — while real dated/numbered file URLs are never demoted.
- **Refuses DRM cleanly** (HLS `#EXT-X-KEY` METHOD != NONE, DASH `<ContentProtection>`, any EME/Widevine-style path in captured players) — never fetches/decrypts protected segments. AES-128 key fetching is deliberately not implemented. Blob/MSE player buffers without another source are shown with an explanation, not a dead button.
- **MSE/blob capture**: when a player feeds segments via MediaSource (only a `blob:` URL is visible), a page hook copies the exact appended bytes per audio/video track, in order. Downloading a capture reassembles the lossless buffered track (`.mp4` for fMP4) — no re-download, no re-encode, works even for one-time signed URLs. 250 MB/track cap (partials labeled), 500 MB transfer cap, cancellable. EME-tainted sessions, or any session on a page using DRM, are refused rows — never downloadable.
- **Resilient detection**: network layer (`webRequest`) + continuous page scan (MutationObserver, shadow DOM, same-origin iframes, report-on-play). Auth-walled manifests fall back to a page-context fetch (page cookie jar) when the worker gets 401/403.
- **MSE/blob correlation**: `.ts`/`.m4s`/chunk traffic is tracked per tab and grouped by URL pattern — 4+ sequential chunks promote to a downloadable grouped item, linked to the player that triggered them. A parsed manifest automatically supersedes raw groups from the same directory.
- **Header replay**: the exact `Authorization` / custom `X-*` headers and referrer the page used are recorded per request and replayed on re-fetch (auth only to the same origin it came from; cookies are never stored and can't be replayed via fetch — page-context fetch covers manifests instead). This fixes most "found but 403 on download" cases.
- **API-wrapped manifests**: a MAIN-world hook transparently watches the page's own fetch/XHR for JSON responses embedding `.m3u8`/`.mpd` URLs (size-capped, media traffic skipped, bodies never leave the page — only extracted URLs). No YouTube-specific handling.
- **Background downloads**: an offscreen document fetches segments (**5 parallel**, per-segment **retries**, 2000-segment / 1.5 GB safety caps) and assembles the file; the service worker saves it. Split A/V streams (video-only + audio-only variants, MSE capture tracks) are **merged into one playable `.mp4` with sound** by a built-in fMP4 muxer — no ffmpeg, no re-encode, no backend. Non-fMP4 pairs fall back to two files with a clear note. Popup can close — progress (`Fetching… n/m` → `Assembling…` → `Saving…`) persists and live-updates on reopen. Jobs are **cancellable**. Output extension is sniffed from bytes (`.ts` vs `.mp4`), not guessed.
- **Popup extras**: parsed manifests dominate the list (raw chunk groups and blob placeholders auto-hide when qualities exist), quality dropdowns sorted best-first with best preselected (single quality = one button, audio-only tracks labeled), split A/V masters download as `*-video.ts` + `*-audio.m4a` with a clear note, per-card **Copy link** (works even with the worker down; direct files can also download worker-free), real thumbnails (video poster → nearby page image → API-bundled poster), per-video **titles** (post text/aria-label near the player, page title as fallback) shown on cards and used for file names, resolution/duration/playing metadata, newest-first list, and a worker-independent page scan so an empty worker never means an empty popup.

## Load unpacked in Chrome/Brave

1. `npm install`
2. `npm run build`
3. Open `chrome://extensions` (or `brave://extensions`) → enable **Developer mode** → **Load unpacked** → select `dist/` (after build). Confirm version **0.6.0**.
4. **Reload the web page's tab** after installing/updating (content scripts only inject into fresh loads).
5. Test: MDN `flower.mp4` (direct), `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8` (HLS master), `https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd` (DASH), any X/Twitter feed video.
6. Click the extension icon → pick quality → Download. You can close the popup.

If the popup ever reports the worker unreachable: use **Reload extension now**, reopen — and if it persists, `chrome://extensions` → Developer mode → this extension → **Service worker** shows its log.

## Permissions

`activeTab, webRequest, downloads, storage, scripting, offscreen, clipboardWrite` + `<all_urls>` hosts. No YouTube-specific logic, no remote servers.

## Scripts

- `npm run dev` — Vite dev (limited for MV3; prefer `build` + reload).
- `npm run build` — `tsc --noEmit && vite build` → `dist/`.
