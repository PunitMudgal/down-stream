# Video Download Grabber (local-only MV3 extension)

Detect playable video on the current tab and download it locally — no backend, no third-party calls.

## What it does

- Background service worker watches `webRequest` for direct video (`mp4/webm/ogg/mov`), HLS (`.m3u8`), DASH (`.mpd`).
- Fetches + parses HLS/DASH manifests client-side (`m3u8-parser`, `mpd-parser`), lists quality variants.
- Refuses DRM cleanly (HLS `#EXT-X-KEY` METHOD != NONE, DASH `<ContentProtection>`) — never fetches/decrypts protected segments.
- Content script enriches items with `<video>` poster thumbnails.
- Popup downloads: direct files via `chrome.downloads`; HLS/DASH via ordered segment fetch + concat (`.ts` for HLS since no remux; DASH concat as `.mp4`).

## Load unpacked in Chrome

1. `npm install`
2. `npm run build`
3. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select `dist/` (after build).
4. Test:
   - Direct MP4: any page under `interactive-examples.mdn.mozilla.net` serving `flower.mp4`.
   - HLS: `https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8`.
   - DASH: `https://dash.akamaized.net/akamai/bbb_30fps/bbb_30fps.mpd`.
5. Click the extension icon → pick quality → Download. Keep the popup open while segments fetch (`Downloading… n/m segments`).

## Permissions

`activeTab, webRequest, downloads, storage, scripting` + 3 test-site `host_permissions`. Expand hosts only as needed; no `<all_urls>`, no YouTube-specific logic, no remote servers.

## Scripts

- `npm run dev` — Vite dev (limited for MV3; prefer `build` + reload).
- `npm run build` — `tsc --noEmit && vite build` → `dist/`.
