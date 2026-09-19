/**
 * Per-job rolling rate meters (worker memory only).
 *
 * The worker is the one place every progress tick flows through, so it is the
 * right owner of the speed calculation: the popup just renders `job.rateBps`,
 * and the value survives a popup reopen because it is part of the job state.
 */
import { RateMeter } from "../lib/rate";

const meters = new Map<string, RateMeter>();

/** Record a cumulative byte reading and return the current rate (bytes/s). */
export function noteProgress(jobId: string, bytes: number, now = Date.now()): number | undefined {
  let meter = meters.get(jobId);
  if (!meter) {
    meter = new RateMeter();
    meters.set(jobId, meter);
  }
  return meter.add(bytes, now);
}

/** Forget a job's meter (job settled) — bounded memory. */
export function dropRate(jobId: string): void {
  meters.delete(jobId);
}

/** Clear samples for a resumed/reused job id so stale speed isn't reported. */
export function resetRate(jobId: string): void {
  meters.get(jobId)?.reset();
}
