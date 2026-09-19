/**
 * Human-readable formatting shared by every UI surface (popup, options,
 * history). One implementation means "12.3 MB" and "~2 min left" never drift
 * between views — the popup used to carry its own copies of these.
 */

/** "512 KB" / "12.3 MB" / "1.50 GB". Never negative, never "0 B" noise. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1_000_000) return `${Math.max(1, Math.round(bytes / 1000))} KB`;
  if (bytes < 1_000_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

/** "860 KB/s" / "12.0 MB/s". Empty string for an unusable rate. */
export function formatSpeed(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return "";
  if (bps < 1_000_000) return `${Math.max(1, Math.round(bps / 1000))} KB/s`;
  if (bps < 1_000_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  return `${(bps / 1_000_000_000).toFixed(2)} GB/s`;
}

/** "~45s left" / "~2m 10s left" / "~1h 5m left". Empty for invalid input. */
export function formatEta(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  if (s < 5) return "~a few sec left";
  if (s < 60) return `~${s}s left`;
  const m = Math.floor(s / 60);
  if (m < 60) return `~${m}m ${s % 60}s left`;
  return `~${Math.floor(m / 60)}h ${m % 60}m left`;
}

/** "0:34" / "1:02:03" (media length, not ETA). Empty for invalid input. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "";
  const s = Math.floor(seconds);
  if (s >= 3600) {
    return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  }
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "Sep 19, 14:03" style local timestamp for history rows. */
export function formatWhen(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return "";
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
  }
}

/** "12.3 MB / 45.6 MB" (or just the first when the total is unknown). */
export function formatProgressPair(done: number, total: number): string {
  return total > 0 ? `${formatBytes(done)}/${formatBytes(total)}` : formatBytes(done);
}
