/**
 * Choose which <video> a keyboard shortcut should act on. There is no cursor
 * position for a keypress, so pick the most likely intent, deterministically:
 *   1. a currently-playing video (most likely what the user is watching),
 *   2. the largest by rendered area (main player beats thumbnails/ads),
 *   3. anything with a real media source,
 *   4. the first one.
 * Pure: callers pass a light snapshot, so this stays trivially testable and
 * identical between the content script and tests.
 */

export interface ShortcutVideoSnapshot {
  /** Not paused and not ended. */
  playing: boolean;
  /** Rendered area in CSS px (0 when not laid out). */
  area: number;
  /** Has a currentSrc or a src attribute. */
  hasSource: boolean;
}

/** Index of the best candidate, or -1 for an empty list. */
export function pickShortcutVideo(videos: ShortcutVideoSnapshot[]): number {
  if (videos.length === 0) return -1;
  let bestIdx = -1;
  let bestScore = -1;
  let bestArea = -1;
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    const score = (v.playing ? 4 : 0) + (v.hasSource ? 1 : 0);
    if (score > bestScore || (score === bestScore && v.area > bestArea)) {
      bestScore = score;
      bestArea = v.area;
      bestIdx = i;
    }
  }
  return bestIdx;
}