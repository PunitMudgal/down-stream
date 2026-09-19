// Content-script enrichment: <video> signals + MSE capture sessions.
// Moved verbatim from background.ts — zero behavior change.
import { classify } from "../lib/classify";
import { cleanTitle, filenameForUrl, pickManifestForBlob, sanitizeStem } from "../lib/download";
import type { BlobFileInfo, MediaItem, MsSessionMeta, VideoSignal } from "../lib/types";
import { matchCluster } from "./clusters";
import { DIRECT_TYPES, applyTitle, describeSignal, enforceCaps, mbLabel, updateBadge } from "./media";
import { parseStreamingItem } from "./manifests";
import { getTabItems, persistTab } from "./store";

/** Extension for a page-held Blob's MIME (defaults to mp4). */
export function extForBlobMime(t: string): string {
  const m = t.toLowerCase().split(";")[0].trim();
  if (m === "video/webm") return "webm";
  if (m === "video/x-matroska") return "mkv";
  if (m === "video/quicktime") return "mov";
  if (m === "video/ogg" || m === "audio/ogg") return "ogv";
  if (m === "video/mp2t") return "ts";
  if (m === "audio/mpeg" || m === "audio/mp3") return "mp3";
  if (m === "audio/mp4" || m === "audio/x-m4a") return "m4a";
  return "mp4";
}

/**
 * Create or refresh the downloadable row for a page-held Blob behind a
 * <video> element. Returns whether anything changed.
 */
function upsertBlobFile(
  items: MediaItem[],
  tabId: number,
  url: string,
  backing: BlobFileInfo,
  v: VideoSignal,
  pageTitle?: string,
): boolean {
  const ext = extForBlobMime(backing.type);
  const elTitle = cleanTitle(v.title);
  const title = elTitle || cleanTitle(pageTitle);
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = title
    ? `${sanitizeStem(title)}.${ext}`
    : `video-${ts}.${ext}`;
  const meta = `${mbLabel(backing.size)} • direct file`;
  const existing = items.find((x) => x.url === url);
  if (!existing) {
    items.push({
      url,
      tabId,
      type: "blobfile",
      filename,
      title: title || undefined,
      titleFromPage: title ? !elTitle : undefined,
      autoNamed: !title,
      detectedAt: Date.now(),
      drmProtected: false,
      poster: v.poster,
      pageTitle,
      meta,
    });
    return true;
  }
  let dirty = false;
  if (v.poster && !existing.poster) {
    existing.poster = v.poster;
    dirty = true;
  }
  if (meta && existing.meta !== meta) {
    existing.meta = meta;
    dirty = true;
  }
  if (applyTitle(existing, v.title, true)) dirty = true;
  else if (applyTitle(existing, pageTitle, false)) dirty = true;
  return dirty;
}

// Enrichment from content script: attach posters, surface blob: videos,
// and create items for direct URLs webRequest missed (e.g. cached media).
export async function handleVideoSignals(
  tabId: number,
  videos: VideoSignal[],
  pageTitle?: string,
  frameId?: number,
  blobs?: BlobFileInfo[],
  adapterItems?: MediaItem[],
): Promise<void> {
  const items = await getTabItems(tabId);
  const blobMap = new Map<string, BlobFileInfo>();
  for (const b of blobs ?? []) {
    if (b && typeof b.url === "string" && typeof b.size === "number" && b.size > 0) {
      blobMap.set(b.url, b);
    }
  }
  let changed = false;
  const touch = (url: string, v: VideoSignal) => {
    const match = items.find(
      (x) => x.url === url || x.url.split("?")[0] === url.split("?")[0],
    );
    if (!match) return;
    if (v.poster && !match.poster) {
      match.poster = v.poster;
      changed = true;
    }
    const meta = describeSignal(v);
    if (meta && !match.meta) {
      match.meta = meta;
      changed = true;
    }
    if (applyTitle(match, v.title, true)) changed = true;
    else if (applyTitle(match, pageTitle, false)) changed = true;
  };

  for (const v of videos) {
    const meta = describeSignal(v);
    const candidates = [v.currentSrc, ...(v.candidates ?? [])].filter(Boolean);
    for (const src of candidates) {
      if (!src || src.startsWith("data:")) continue;
      if (src.startsWith("blob:")) {
        // Whole-file Blob backing this player? Exact bytes, direct save.
        const backing = blobMap.get(src);
        if (backing) {
          if (upsertBlobFile(items, tabId, src, backing, v, pageTitle)) changed = true;
          continue;
        }
        // If the player feeding this blob: URL has visible chunk traffic in
        // the same frame, link the poster/meta to the grouped item instead
        // of adding a dead placeholder row.
        const cluster = matchCluster(tabId, frameId);
        if (cluster) {
          const linked = items.find((x) => x.type === "segments" && x.url === cluster.urls[0]);
          if (linked) {
            if (v.poster && !linked.poster) {
              linked.poster = v.poster;
              changed = true;
            }
            const m = describeSignal(v);
            if (m && !linked.meta?.includes("×")) {
              linked.meta = `${linked.meta ?? ""} • ${m}`;
              changed = true;
            }
            if (applyTitle(linked, v.title, true)) changed = true;
            else if (applyTitle(linked, pageTitle, false)) changed = true;
            continue;
          }
        }
        // MSE players expose only a blob: URL while the real stream is an
        // HLS/DASH manifest row — forward this player's poster/title/meta
        // there so rows show thumbnails and names, not hash URLs.
        const manifest = pickManifestForBlob(items);
        if (manifest && (v.poster || v.title || meta)) {
          if (v.poster && !manifest.poster) {
            manifest.poster = v.poster;
            changed = true;
          }
          if (meta && !manifest.meta) {
            manifest.meta = meta;
            changed = true;
          }
          if (applyTitle(manifest, v.title, true)) changed = true;
          else if (applyTitle(manifest, pageTitle, false)) changed = true;
        }
        const existing = items.find((x) => x.url === src);
        if (!existing) {
          const title = cleanTitle(v.title) || cleanTitle(pageTitle);
          items.push({
            url: src,
            tabId,
            type: "blob",
            filename: "",
            title: title || undefined,
            titleFromPage: title ? !cleanTitle(v.title) : undefined,
            detectedAt: Date.now(),
            drmProtected: false,
            poster: v.poster,
            pageTitle,
            meta,
            error: "Blob/MSE stream (in-player buffer) — the downloadable file is captured from the network when it loads. Try playing, then Rescan.",
          });
          changed = true;
        } else {
          if (v.poster && !existing.poster) {
            existing.poster = v.poster;
            changed = true;
          }
          if (meta && !existing.meta) {
            existing.meta = meta;
            changed = true;
          }
        }
        continue;
      }
      if (!src.startsWith("http://") && !src.startsWith("https://")) continue;
      const type = classify(src, "");
      if (type === "hls" || type === "dash") {
        if (!items.some((x) => x.url === src)) {
          const title = cleanTitle(v.title) || cleanTitle(pageTitle);
          const item: MediaItem = {
            url: src,
            tabId,
            type,
            filename: filenameForUrl(src, type, title || undefined),
            title: title || undefined,
            titleFromPage: title ? !cleanTitle(v.title) : undefined,
            autoNamed: !title,
            detectedAt: Date.now(),
            drmProtected: false,
            variants: [],
            poster: v.poster,
            pageTitle,
            meta,
          };
          items.push(item);
          changed = true;
          void parseStreamingItem(tabId, item);
        } else {
          touch(src, v);
        }
      } else if (type && DIRECT_TYPES.has(type)) {
        // Direct file the network listener missed (cached before install etc.)
        if (!items.some((x) => x.url === src || x.url.split("?")[0] === src.split("?")[0])) {
          const title = cleanTitle(v.title) || cleanTitle(pageTitle);
          items.push({
            url: src,
            tabId,
            type,
            filename: filenameForUrl(src, type, title || undefined),
            title: title || undefined,
            titleFromPage: title ? !cleanTitle(v.title) : undefined,
            autoNamed: !title,
            detectedAt: Date.now(),
            drmProtected: false,
            poster: v.poster,
            pageTitle,
            meta,
          });
          changed = true;
        } else {
          touch(src, v);
        }
      } else {
        touch(src, v);
      }
    }
  }
  changed = (await mergeAdapterItems(tabId, items, adapterItems, pageTitle)) || changed;
  if (changed) {
    await persistTab(tabId, enforceCaps(items));
    await updateBadge(tabId);
  }
}

/**
 * Merge fully formed site-adapter items into the tab's item list, then
 * normalize them through the same pipeline as generic detections:
 * - unknown media types are classified from the URL;
 * - non-video URLs are rejected;
 * - manifests are parsed asynchronously before the card renders qualities;
 * - duplicates are keyed on the exact URL.
 */
async function mergeAdapterItems(
  tabId: number,
  items: MediaItem[],
  adapterItems: MediaItem[] | undefined,
  pageTitle?: string,
): Promise<boolean> {
  if (!Array.isArray(adapterItems) || adapterItems.length === 0) return false;
  let changed = false;
  for (const raw of adapterItems) {
    const url = raw?.url;
    if (typeof url !== "string" || url.length === 0) continue;
    if (items.some((existing) => existing.url === url)) continue;
    let type = raw.type;
    if (type === "unknown" || type === undefined) type = classify(url, "") ?? "unknown";
    if (type === "unknown") continue;
    const title = cleanTitle(raw.title) || cleanTitle(pageTitle);
    const item: MediaItem = {
      ...raw,
      tabId,
      type,
      filename: raw.filename?.length ? raw.filename : filenameForUrl(url, type, title || undefined),
      title: title || undefined,
      titleFromPage: title ? !cleanTitle(raw.title) : undefined,
      autoNamed: !title,
      detectedAt: typeof raw.detectedAt === "number" && raw.detectedAt > 0 ? raw.detectedAt : Date.now(),
      drmProtected: raw.drmProtected ?? false,
      pageTitle: raw.pageTitle ?? pageTitle,
    };
    items.push(item);
    changed = true;
    if (type === "hls" || type === "dash") {
      // Adapter-supplied manifests need variants before the popup renders a
      // quality menu. The row appears immediately; qualities stream in.
      void parseStreamingItem(tabId, item);
    }
  }
  return changed;
}

// Last-seen timestamps for capture keys (prune player teardowns).
const captureSeen = new Map<string, number>();

/**
 * MSE capture sessions -> downloadable `capture` items (one per track).
 * Refusal rules (never bypassed):
 * - session.eme (setMediaKeys/encrypted on its element) -> DRM row, refused.
 * - session clean BUT page requested EME keys -> refused as unverified: on a
 *   mixed page we cannot prove this buffer isn't DRM-adjacent.
 * - clean session, clean page, bytes>0 -> downloadable capture item.
 */
export async function handleCaptureSessions(
  tabId: number,
  sessions: MsSessionMeta[] | undefined,
  posterByBlob: Map<string, string>,
  titleByBlob: Map<string, string>,
  pageTitle?: string,
): Promise<void> {
  if (!sessions) return;
  const now = Date.now();
  const items = await getTabItems(tabId);
  let changed = false;

  for (const s of sessions) {
    if (!s || typeof s.id !== "string") continue;
    const keyBase = `capture:${s.id}:`;
    captureSeen.set(keyBase, now);
    const elTitle = s.blobUrl ? cleanTitle(titleByBlob.get(s.blobUrl)) : "";
    const pageFallback = cleanTitle(pageTitle);
    const title = elTitle || pageFallback;
    for (const t of s.tracks ?? []) {
      const url = `${keyBase}${t.idx}`;
      captureSeen.set(url, now);
      const kindLabel = t.kind === "video" ? "video" : t.kind === "audio" ? "audio" : "track";
      const sizeLabel = t.bytes > 0 ? ` • ${mbLabel(t.bytes)}` : "";
      const existing = items.find((x) => x.url === url);

      if (s.eme) {
        if (!existing) {
          items.push({
            url,
            tabId,
            type: "capture",
            captureRef: `${s.id}:${t.idx}`,
            captureKind: t.kind,
            filename: "",
            title: title || undefined,
            titleFromPage: title ? !elTitle : undefined,
            detectedAt: now,
            drmProtected: true,
            drmReason: "Protected content — this player uses an encrypted media path (DRM). Cannot download.",
            meta: `${kindLabel}${sizeLabel} • captured buffer`,
            pageTitle,
          });
          changed = true;
        }
        continue;
      }
      if (s.pageEme) {
        if (!existing) {
          items.push({
            url,
            tabId,
            type: "capture",
            captureRef: `${s.id}:${t.idx}`,
            captureKind: t.kind,
            filename: "",
            title: title || undefined,
            titleFromPage: title ? !elTitle : undefined,
            detectedAt: now,
            drmProtected: true,
            drmReason: "This page uses DRM playback, so buffered captures are disabled here to stay safe.",
            meta: `${kindLabel}${sizeLabel} • captured buffer`,
            pageTitle,
          });
          changed = true;
        }
        continue;
      }
      if (t.bytes <= 0) continue; // nothing captured yet — wait for buffer
      const meta = `${kindLabel}${sizeLabel} • captured buffer${s.complete === false ? " • partial" : ""}`;
      const poster = s.blobUrl ? posterByBlob.get(s.blobUrl) : undefined;
      if (!existing) {
        const ts = new Date(now).toISOString().replace(/[:.]/g, "-").slice(0, 19);
        items.push({
          url,
          tabId,
          type: "capture",
          captureRef: `${s.id}:${t.idx}`,
            captureKind: t.kind,
          filename: title ? `${sanitizeStem(title)}-${kindLabel}-${ts}.mp4` : `capture-${kindLabel}-${ts}.mp4`,
          title: title || undefined,
          titleFromPage: title ? !elTitle : undefined,
          autoNamed: !title,
          detectedAt: now,
          drmProtected: false,
          poster,
          pageTitle,
          meta,
        });
        changed = true;
      } else if (!existing.drmProtected) {
        if (existing.meta !== meta) {
          existing.meta = meta;
          changed = true;
        }
        if (poster && !existing.poster) {
          existing.poster = poster;
          changed = true;
        }
        if (applyTitle(existing, elTitle || undefined, true)) changed = true;
        else if (applyTitle(existing, pageFallback || undefined, false)) changed = true;
      }
    }
  }

  // Prune captures whose sessions vanished >120s ago (player teardown).
  const staleCutoff = now - 120_000;
  let pruned = false;
  for (let i = items.length - 1; i >= 0; i--) {
    const x = items[i];
    if (x.type !== "capture") continue;
    const seen = captureSeen.get(x.url) ?? captureSeen.get(x.url.split(":").slice(0, 2).join(":") + ":") ?? 0;
    if (seen < staleCutoff) {
      items.splice(i, 1);
      captureSeen.delete(x.url);
      pruned = true;
    }
  }
  if (pruned) changed = true;

  if (changed) {
    await persistTab(tabId, enforceCaps(items));
    await updateBadge(tabId);
  }
}
