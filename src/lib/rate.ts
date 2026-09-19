/**
 * Rolling transfer-rate meter.
 *
 * A cumulative average ("bytes so far / wall clock") is a poor speed readout:
 * it lags badly and never recovers after a stall. This keeps a short sliding
 * window of (time, bytes) samples and reports the rate across it, so the UI
 * shows the speed the transfer is actually achieving right now.
 *
 * Pure and dependency-free — the worker owns the meters, and the popup simply
 * renders the `rateBps` the worker publishes on each job tick.
 */

/** How much history the window keeps. Long enough to smooth per-segment
 * bursts, short enough to react to a real slowdown. */
export const RATE_WINDOW_MS = 8_000;
/** Below this span an instantaneous delta is too noisy to trust. */
const MIN_SPAN_MS = 750;

export class RateMeter {
  private samples: Array<{ t: number; b: number }> = [];

  /** Record a cumulative byte counter reading. Returns the current rate. */
  add(bytes: number, now = Date.now()): number | undefined {
    if (!Number.isFinite(bytes) || bytes < 0) return this.bps;
    const last = this.samples[this.samples.length - 1];
    // Ignore duplicate/older readings (progress ticks can arrive out of order).
    if (last && (now < last.t || bytes < last.b)) return this.bps;
    this.samples.push({ t: now, b: bytes });
    const cutoff = now - RATE_WINDOW_MS;
    while (this.samples.length > 2 && this.samples[0].t < cutoff) this.samples.shift();
    return this.bps;
  }

  /** Bytes/second across the retained window, or undefined when unknown. */
  get bps(): number | undefined {
    if (this.samples.length < 2) return undefined;
    const first = this.samples[0];
    const last = this.samples[this.samples.length - 1];
    const dt = last.t - first.t;
    const db = last.b - first.b;
    if (dt < MIN_SPAN_MS || db <= 0) return undefined;
    return (db / dt) * 1000;
  }

  reset(): void {
    this.samples = [];
  }
}
