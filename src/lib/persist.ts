/**
 * Resumable-download persistence layer.
 *
 * Fetched segment buffers are written to OPFS (origin-private file system,
 * per extension origin, survives browser restarts) under
 *   down-stream/jobs/<jobId>/seg-<index>.part
 * so a crashed/restarted download resumes from its last completed segment
 * instead of starting over. A meta.json pins the segment count so a stale
 * cache from a different segment list is never trusted.
 *
 * Every operation is best-effort: persistence failure never breaks a
 * download, it just loses resumability.
 */

const ROOT_DIR = "down-stream";
const JOBS_DIR = "jobs";

interface StorageRoot {
  getDirectoryHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<FileSystemDirectoryHandle>;
}

function nav(): (Navigator & { storage: { getDirectory(): Promise<StorageRoot> } }) | undefined {
  const n = globalThis.navigator as
    | (Navigator & { storage?: { getDirectory?: () => Promise<StorageRoot> } })
    | undefined;
  return n?.storage?.getDirectory
    ? (n as Navigator & { storage: { getDirectory(): Promise<StorageRoot> } })
    : undefined;
}

/** True when OPFS is usable in this context. */
export async function persistSupported(): Promise<boolean> {
  try {
    return !!nav();
  } catch {
    return false;
  }
}

function safeId(jobId: string): string {
  // jobIds are `job-<base36>-<base36>` already, but never trust input at a
  // filesystem boundary.
  return jobId.replace(/[^a-z0-9-]/gi, "_");
}

async function jobDir(
  jobId: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | undefined> {
  const n = nav();
  if (!n) return undefined;
  try {
    const root = await n.storage.getDirectory();
    const rootDir = await root.getDirectoryHandle(ROOT_DIR, { create });
    const jobs = await rootDir.getDirectoryHandle(JOBS_DIR, { create });
    return await jobs.getDirectoryHandle(safeId(jobId), { create });
  } catch {
    return undefined;
  }
}

/** Persist one segment buffer (idempotent per index). */
export async function saveSegment(jobId: string, index: number, buf: ArrayBuffer): Promise<void> {
  const dir = await jobDir(jobId, true);
  if (!dir) return;
  try {
    const fh = await dir.getFileHandle(`seg-${index}.part`, { create: true });
    const w = await fh.createWritable();
    await w.write(buf);
    await w.close();
  } catch {
    /* best-effort — resumability is a bonus, never a download blocker */
  }
}

/** Record the segment count so stale caches can't masquerade as this job. */
export async function saveMeta(jobId: string, count: number): Promise<void> {
  const dir = await jobDir(jobId, true);
  if (!dir) return;
  try {
    const fh = await dir.getFileHandle("meta.json", { create: true });
    const w = await fh.createWritable();
    await w.write(JSON.stringify({ count }));
    await w.close();
  } catch {
    /* ignore */
  }
}

/**
 * Load all persisted segments for a job. Returns undefined when nothing valid
 * is cached (or the cached count doesn't match `expectedCount`), so callers
 * fall back to a fresh fetch.
 */
export async function loadSegments(
  jobId: string,
  expectedCount: number,
): Promise<Array<ArrayBuffer | undefined> | undefined> {
  const dir = await jobDir(jobId, false);
  if (!dir) return undefined;
  try {
    const metaFh = await dir.getFileHandle("meta.json");
    const metaText = await (await metaFh.getFile()).text();
    const meta = JSON.parse(metaText) as { count?: number };
    if (meta.count !== expectedCount) return undefined;
  } catch {
    return undefined;
  }
  const out: Array<ArrayBuffer | undefined> = new Array(expectedCount);
  let any = false;
  for (let i = 0; i < expectedCount; i++) {
    try {
      const fh = await dir.getFileHandle(`seg-${i}.part`);
      const file = await fh.getFile();
      const buf = await file.arrayBuffer();
      if (buf.byteLength > 0) {
        out[i] = buf;
        any = true;
      }
    } catch {
      out[i] = undefined; // hole — will be refetched
    }
  }
  return any ? out : undefined;
}

/** How many bytes a job currently has cached (for UI "X% cached" hints). */
export async function persistedBytes(jobId: string): Promise<number> {
  const dir = await jobDir(jobId, false);
  if (!dir) return 0;
  let total = 0;
  try {
    for await (const entry of (
      dir as unknown as { values(): AsyncIterable<FileSystemFileHandle> }
    ).values()) {
      try {
        if (entry.kind !== "file" || !entry.name.startsWith("seg-")) continue;
        total += (await entry.getFile()).size;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return total;
}

/** Delete all persisted data for a job. */
export async function clearJob(jobId: string): Promise<void> {
  const n = nav();
  if (!n) return;
  try {
    const root = await n.storage.getDirectory();
    const rootDir = await root.getDirectoryHandle(ROOT_DIR);
    const jobs = await rootDir.getDirectoryHandle(JOBS_DIR);
    await jobs.removeEntry(safeId(jobId), { recursive: true });
  } catch {
    /* nothing to clear */
  }
}

/**
 * Evict persisted job data not in `keepIds`. Called on startup so abandoned
 * caches don't grow unboundedly.
 */
export async function pruneOrphans(keepIds: Set<string>): Promise<void> {
  const n = nav();
  if (!n) return;
  try {
    const root = await n.storage.getDirectory();
    const rootDir = await root.getDirectoryHandle(ROOT_DIR);
    const jobs = await rootDir.getDirectoryHandle(JOBS_DIR);
    for await (const entry of (
      jobs as unknown as { values(): AsyncIterable<FileSystemDirectoryHandle> }
    ).values()) {
      if (entry.kind === "directory" && !keepIds.has(entry.name)) {
        try {
          await jobs.removeEntry(entry.name, { recursive: true });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}
