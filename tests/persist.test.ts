import { beforeEach, describe, expect, it } from "vitest";
import {
  clearJob,
  loadSegments,
  persistedBytes,
  persistSupported,
  pruneOrphans,
  saveMeta,
  saveSegment,
} from "../src/lib/persist";

/**
 * In-memory OPFS stand-in. Mirrors the FileSystemDirectoryHandle shape the
 * persistence layer uses (getDirectoryHandle / getFileHandle / removeEntry /
 * values) so the logic is testable without a real browser file system.
 */
class FakeFile {
  constructor(public data: ArrayBuffer) {}
  async text(): Promise<string> {
    return new TextDecoder().decode(this.data);
  }
  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.data;
  }
  get size(): number {
    return this.data.byteLength;
  }
}
class FakeFileHandle {
  kind = "file" as const;
  file = new FakeFile(new ArrayBuffer(0));
  constructor(public name: string) {}
  async getFile(): Promise<FakeFile> {
    return this.file;
  }
  async createWritable(): Promise<{ write(d: ArrayBuffer | string): Promise<void>; close(): Promise<void> }> {
    return {
      write: async (d) => {
        this.file = new FakeFile(
          typeof d === "string" ? (new TextEncoder().encode(d).buffer as ArrayBuffer) : d,
        );
      },
      close: async () => {},
    };
  }
}
class FakeDir {
  kind = "directory" as const;
  dirs = new Map<string, FakeDir>();
  files = new Map<string, FakeFileHandle>();
  constructor(public name: string) {}
  async getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FakeDir> {
    let d = this.dirs.get(name);
    if (!d) {
      if (!opts?.create) throw new Error(`no dir ${name}`);
      d = new FakeDir(name);
      this.dirs.set(name, d);
    }
    return d;
  }
  async getFileHandle(name: string, opts?: { create?: boolean }): Promise<FakeFileHandle> {
    let f = this.files.get(name);
    if (!f) {
      if (!opts?.create) throw new Error(`no file ${name}`);
      f = new FakeFileHandle(name);
      this.files.set(name, f);
    }
    return f;
  }
  async removeEntry(name: string, _opts?: { recursive?: boolean }): Promise<void> {
    this.dirs.delete(name);
    this.files.delete(name);
  }
  async *values(): AsyncIterable<FakeDir | FakeFileHandle> {
    yield* this.dirs.values();
    yield* this.files.values();
  }
}

let root: FakeDir;

function setNavigator(value: unknown): void {
  // jsdom exposes `navigator` as a getter-only accessor — redefine it.
  Object.defineProperty(globalThis, "navigator", {
    value,
    configurable: true,
    writable: true,
  });
}

function buf(n: number, fill = 0x41): ArrayBuffer {
  return new Uint8Array(n).fill(fill).buffer as ArrayBuffer;
}

beforeEach(() => {
  root = new FakeDir("root");
  setNavigator({ storage: { getDirectory: async () => root } });
});

describe("persist layer", () => {
  it("reports support when OPFS is available", async () => {
    await expect(persistSupported()).resolves.toBe(true);
    setNavigator({});
    await expect(persistSupported()).resolves.toBe(false);
  });

  it("round-trips segments with holes", async () => {
    await saveMeta("job-1", 4);
    await saveSegment("job-1", 0, buf(10));
    await saveSegment("job-1", 2, buf(20));
    const got = await loadSegments("job-1", 4);
    expect(got).toHaveLength(4);
    expect(got?.[0]?.byteLength).toBe(10);
    expect(got?.[1]).toBeUndefined(); // hole
    expect(got?.[2]?.byteLength).toBe(20);
    expect(got?.[3]).toBeUndefined();
  });

  it("rejects a cache whose segment count doesn't match (stale)", async () => {
    await saveMeta("job-2", 3);
    await saveSegment("job-2", 0, buf(10));
    // A different segment list (length 5) must NOT trust the 3-segment cache.
    await expect(loadSegments("job-2", 5)).resolves.toBeUndefined();
    await expect(loadSegments("job-2", 3)).resolves.toBeDefined();
  });

  it("returns undefined when nothing is cached", async () => {
    await expect(loadSegments("job-nope", 3)).resolves.toBeUndefined();
  });

  it("counts persisted bytes", async () => {
    await saveMeta("job-3", 2);
    await saveSegment("job-3", 0, buf(100));
    await saveSegment("job-3", 1, buf(50));
    await expect(persistedBytes("job-3")).resolves.toBe(150);
  });

  it("clearJob removes a job's data", async () => {
    await saveMeta("job-4", 1);
    await saveSegment("job-4", 0, buf(10));
    await clearJob("job-4");
    await expect(loadSegments("job-4", 1)).resolves.toBeUndefined();
    await expect(persistedBytes("job-4")).resolves.toBe(0);
  });

  it("pruneOrphans evicts jobs not in the keep set", async () => {
    await saveMeta("keep", 1);
    await saveSegment("keep", 0, buf(10));
    await saveMeta("orphan", 1);
    await saveSegment("orphan", 0, buf(10));
    await pruneOrphans(new Set(["keep"]));
    await expect(loadSegments("keep", 1)).resolves.toBeDefined();
    await expect(loadSegments("orphan", 1)).resolves.toBeUndefined();
  });

  it("sanitizes job ids at the filesystem boundary", async () => {
    await saveMeta("job/../../evil", 1);
    await saveSegment("job/../../evil", 0, buf(5));
    // Slashes are replaced, so it lands in a safe directory and round-trips.
    const got = await loadSegments("job/../../evil", 1);
    expect(got?.[0]?.byteLength).toBe(5);
  });
});
