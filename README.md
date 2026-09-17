# Video Download Grabber (local-only MV3 extension)

Detect playable video on the current tab and download it locally — no backend, no third-party calls.

## What it does

- Background service worker watches `webRequest` for direct video (`mp4/webm/ogg/mov`), HLS (`.m3u8`), DASH (`.mpd`).
- Fetches + parses HLS/DASH manifests client-side (`m3u8-parser`, `mpd-parser`), lists quality variants.
- Refuses DRM cleanly (HLS `#EXT-X-KEY` METHOD != NONE, DASH `<ContentProtection>`) — never fetches/decrypts protected segments.
- Content script watches the page continuously (MutationObserver, so SPA feeds like X/Twitter are covered), reports `<video>` elements, posters, and direct URLs the network layer may have missed (cached media).
- Downloads run through an **offscreen document**: HLS/DASH segment fetch + concat (`.ts` for HLS since no remux; DASH concat as `.mp4`) keeps going **after the popup closes**. Reopen the popup anytime to see live progress (`Downloading… n/m segments`), Done, or error state. Direct files go straight through `chrome.downloads`.

## Load unpacked in Chrome

1. `npm install`
2. `npm run build`
3. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/` (after build).
4. Test:
   - Direct MP4: any page under `interactive-examples.mdn.mozilla.net` serving `flower.mp4`.
   - HLS: `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`.
   - DASH: `https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd`.
   - X/Twitter feed (`x.com`): scroll until a video plays, open the popup, hit **Rescan** if needed. Note: feed players often use blob/MSE buffers — the extension surfaces the underlying network file (e.g. `video.twimg.com` MP4/HLS) once it loads; pure blob entries are shown with an explanation, not a dead button.
5. Click the extension icon → pick quality → Download. You can close the popup — the download continues in the background.

## Permissions

`activeTab, webRequest, downloads, storage, scripting, offscreen` + `host_permissions` for the test sites plus `x.com`, `*.x.com`, `twitter.com`, `*.twitter.com`, `*.twimg.com`. No `<all_urls>`, no YouTube-specific logic, no remote servers.

## Scripts

- `npm run dev` — Vite dev (limited for MV3; prefer `build` + reload).
- `npm run build` — `tsc --noEmit && vite build` → `dist/`.
