// Live HLS/DASH recording persistence.
//
// A recording is open-ended — its segment list grows while the broadcast
// runs — so it can't reuse the job resume cache (which pins a fixed segment
// count). Instead each track's bytes are appended to OPFS as they arrive:
//
//   down-stream/live/<jobId>/meta.json      cursors, poll interval, sizes
//   down-stream/live/<jobId>/init.bin       fMP4 init segment (prepended to
//                                           continuation part files)
//   down-stream/live/<jobId>/seq-<n>.part   nth fetched segment, main track
//   down-stream/live/<jobId>/a-seq-<n>.part nth fetched segment, audio track
//
// Every write is best-effort: persistence failure never breaks a recording,
// it only loses restart-recovery for the segments not yet written.

const ROOT_DIR = "down-stream";
const LIVE_DIR = "live";

export const LIVE_META_FILE = "meta.json";

export interface LiveMeta {
  /** Container init chunk present (fMP4) — init.bin holds it. */
  hasInit?: boolean;
  /** Seconds between manifest polls (HLS target duration / DASH minUpdate). */
  pollSec?: number;
  /** Absolute index of the next segment to fetch, per track. */
  cursor?: number;
  pairCursor?: number;
  /** Byte size of every written segment, in index order (recovery). */
  sizes?: number[];
  pairSizes?: number[];
}

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
export async function livePersistSupported(): Promise<boolean> {
  try {
    return !!nav();
  } catch {
    return false;
  }
}

function safeId(jobId: string): string {
  return jobId.replace(/[^a-z0-9-]/gi, "_");
}

async function liveDir(
  jobId: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | undefined> {
  const n = nav();
  if (!n) return undefined;
  try {
    const root = await n.storage.getDirectory();
    const rootDir = await root.getDirectoryHandle(ROOT_DIR, { create });
    const live = await rootDir.getDirectoryHandle(LIVE_DIR, { create });
    return await live.getDirectoryHandle(safeId(jobId), { create });
  } catch {
    return undefined;
  }
}

async function writeFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  data: ArrayBuffer | string,
): Promise<void> {
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data as FileSystemWriteChunkType);
  await w.close();
}

async function readFile(
  dir: FileSystemDirectoryHandle,
  name: string,
): Promise<ArrayBuffer | undefined> {
  try {
    const fh = await dir.getFileHandle(name);
    const buf = await (await fh.getFile()).arrayBuffer();
    return buf.byteLength > 0 ? buf : undefined;
  } catch {
    return undefined;
  }
}

/** Append one segment buffer (idempotent per index). */
export async function liveSaveSegment(
  jobId: string,
  track: 0 | 1,
  index: number,
  buf: ArrayBuffer,
): Promise<void> {
  const dir = await liveDir(jobId, true);
  if (!dir) return;
  try {
    await writeFile(dir, `${track === 1 ? "a-" : ""}seq-${index}.part`, buf);
  } catch {
    /* best-effort */
  }
}

/** Persist the track's init chunk once (fMP4 continuation parts need it). */
export async function liveSaveInit(jobId: string, buf: ArrayBuffer): Promise<void> {
  const dir = await liveDir(jobId, true);
  if (!dir) return;
  try {
    await writeFile(dir, "init.bin", buf);
  } catch {
    /* best-effort */
  }
}

export async function liveLoadInit(jobId: string): Promise<ArrayBuffer | undefined> {
  const dir = await liveDir(jobId, false);
  if (!dir) return undefined;
  return readFile(dir, "init.bin");
}

export async function liveSaveMeta(jobId: string, meta: LiveMeta): Promise<void> {
  const dir = await liveDir(jobId, true);
  if (!dir) return;
  try {
    await writeFile(dir, LIVE_META_FILE, JSON.stringify(meta));
  } catch {
    /* ignore */
  }
}

export async function liveLoadMeta(jobId: string): Promise<LiveMeta | undefined> {
  const dir = await liveDir(jobId, false);
  if (!dir) return undefined;
  try {
    const buf = await readFile(dir, LIVE_META_FILE);
    if (!buf) return undefined;
    return JSON.parse(new TextDecoder().decode(buf)) as LiveMeta;
  } catch {
    return undefined;
  }
}

/** Read one persisted segment back (assembly / recovery). */
export async function liveLoadSegment(
  jobId: string,
  track: 0 | 1,
  index: number,
): Promise<ArrayBuffer | undefined> {
  const dir = await liveDir(jobId, false);
  if (!dir) return undefined;
  return readFile(dir, `${track === 1 ? "a-" : ""}seq-${index}.part`);
}

/** Read a contiguous run of persisted segments [from, to). Holes yield undefined. */
export async function liveLoadRange(
  jobId: string,
  track: 0 | 1,
  from: number,
  to: number,
): Promise<Array<ArrayBuffer | undefined>> {
  const out: Array<ArrayBuffer | undefined> = [];
  for (let i = from; i < to; i++) out.push(await liveLoadSegment(jobId, track, i));
  return out;
}

/** Count persisted segments of one track (recovery of pending bytes). */
export async function liveCount(jobId: string, track: 0 | 1): Promise<number> {
  let n = 0;
  for (;;) {
    const buf = await liveLoadSegment(jobId, track, n);
    if (!buf) return n;
    n++;
  }
}

/** Delete everything a recording persisted (after a successful save or cancel). */
export async function liveClear(jobId: string): Promise<void> {
  const n = nav();
  if (!n) return;
  try {
    const root = await n.storage.getDirectory();
    const rootDir = await root.getDirectoryHandle(ROOT_DIR);
    const live = await rootDir.getDirectoryHandle(LIVE_DIR);
    await live.removeEntry(safeId(jobId), { recursive: true });
  } catch {
    /* nothing to clear */
  }
}

/**
 * Evict live-recording directories not in `keepIds`. Called on startup so
 * interrupted recordings from abandoned sessions don't grow unboundedly.
 */
export async function livePruneOrphans(keepIds: Set<string>): Promise<void> {
  const n = nav();
  if (!n) return;
  try {
    const root = await n.storage.getDirectory();
    const rootDir = await root.getDirectoryHandle(ROOT_DIR);
    const live = await rootDir.getDirectoryHandle(LIVE_DIR);
    for await (const entry of (
      live as unknown as { values(): AsyncIterable<FileSystemDirectoryHandle> }
    ).values()) {
      if (entry.kind === "directory" && !keepIds.has(entry.name)) {
        try {
          await live.removeEntry(entry.name, { recursive: true });
        } catch {
          /* ignore */
        }
      }
    }
  } catch {
    /* ignore */
  }
}
