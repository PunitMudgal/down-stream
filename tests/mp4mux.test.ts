import { describe, expect, it } from "vitest";
import { muxFmp4, splitFmp4 } from "../src/lib/mp4mux";
import {
  audioStream,
  buildFragment,
  buildInit,
  box,
  concat,
  fourcc,
  initOnlyStream,
  multiVideoTrakStream,
  u32,
  videoStream,
} from "./helpers/fmp4";

// ---- minimal box-walking helpers (independent of the fixture builder) ----

interface BoxInfo {
  type: string;
  start: number;
  size: number;
  header: number;
}

function walk(u8: Uint8Array, limit = u8.byteLength): BoxInfo[] {
  const out: BoxInfo[] = [];
  let off = 0;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  while (off + 8 <= limit) {
    let size = dv.getUint32(off);
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    let header = 8;
    if (size === 1) {
      size = Number(dv.getBigUint64(off + 8));
      header = 16;
    } else if (size === 0) {
      size = limit - off;
    }
    if (size < header || off + size > limit) break;
    out.push({ type, start: off, size, header });
    off += size;
  }
  return out;
}

function payload(u8: Uint8Array, b: BoxInfo): Uint8Array {
  return u8.subarray(b.start + b.header, b.start + b.size);
}

function find(u8: Uint8Array, type: string): BoxInfo | undefined {
  return walk(u8).find((b) => b.type === type);
}

/** Walk the children of a container box payload (absolute offsets). */
function childrenOf(u8: Uint8Array, b: BoxInfo): BoxInfo[] {
  const base = b.start + b.header;
  const end = b.start + b.size;
  return walk(u8.subarray(base, end)).map((c) => ({ ...c, start: c.start + base }));
}

describe("splitFmp4", () => {
  it("separates init (ftyp+moov) from fragments", () => {
    const stream = videoStream(1);
    const { init, frags } = splitFmp4(stream);
    const initBoxes = walk(init).map((b) => b.type);
    expect(initBoxes).toEqual(["ftyp", "moov"]);
    expect(frags).toHaveLength(2);
    for (const f of frags) {
      expect(walk(f)[0].type).toBe("moof");
    }
  });

  it("throws when there is no moov", () => {
    const frag = buildFragment({ trackId: 1, baseTime: 0, sequence: 1, samples: [{ dur: 2560, size: 10 }] });
    expect(() => splitFmp4(frag)).toThrow(/ftyp\/moov/);
  });

  it("throws when there are no fragments", () => {
    expect(() => splitFmp4(initOnlyStream(1))).toThrow(/no media fragments/);
  });
});

describe("muxFmp4 — structure of merged output", () => {
  const video = videoStream(1);
  const audio = audioStream(2);
  const out = muxFmp4(video, audio);

  it("produces ftyp + moov + interleaved moof/mdat fragments", () => {
    const top = walk(out).map((b) => b.type);
    expect(top[0]).toBe("ftyp");
    expect(top[1]).toBe("moov");
    // Every remaining top-level box pair must be moof then mdat.
    for (let i = 2; i < top.length; i += 2) {
      expect(top[i]).toBe("moof");
      expect(top[i + 1]).toBe("mdat");
    }
    expect(top.length).toBeGreaterThan(4);
  });

  it("keeps both traks with renumbered ids 1 (video) and 2 (audio)", () => {
    const moov = find(out, "moov")!;
    const traks = childrenOf(out, moov).filter((b) => b.type === "trak");
    expect(traks).toHaveLength(2);
    const ids = traks.map((t) => {
      const tkhd = childrenOf(out, t).find((b) => b.type === "tkhd")!;
      const version = out[tkhd.start + tkhd.header];
      // v0: id after ver/flags(4) + creation(4) + modification(4).
      const idOff = tkhd.start + tkhd.header + 4 + (version === 1 ? 16 : 8);
      return new DataView(out.buffer, out.byteOffset).getUint32(idOff);
    });
    expect(ids).toEqual([1, 2]);
  });

  it("writes mvex with trex entries for both tracks", () => {
    const moov = find(out, "moov")!;
    const mvex = childrenOf(out, moov).find((b) => b.type === "mvex");
    expect(mvex).toBeDefined();
    const trexIds = childrenOf(out, mvex!)
      .filter((b) => b.type === "trex")
      .map((b) => new DataView(out.buffer, out.byteOffset).getUint32(b.start + b.header + 4));
    expect(trexIds).toEqual([1, 2]);
  });

  it("assigns sequential mfhd sequence numbers starting at 1", () => {
    const seqs: number[] = [];
    for (const b of walk(out)) {
      if (b.type !== "moof") continue;
      const mfhd = childrenOf(out, b).find((c) => c.type === "mfhd")!;
      seqs.push(new DataView(out.buffer, out.byteOffset).getUint32(mfhd.start + mfhd.header + 4));
    }
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  });

  it("has trun data_offset pointing at the first mdat byte", () => {
    const dv = new DataView(out.buffer, out.byteOffset);
    const top = walk(out);
    for (let i = 0; i < top.length; i++) {
      if (top[i].type !== "moof") continue;
      const moof = top[i];
      const traf = childrenOf(out, moof).find((c) => c.type === "traf")!;
      const trun = childrenOf(out, traf).find((c) => c.type === "trun")!;
      const declared = dv.getUint32(trun.start + trun.header + 8);
      const mdat = top[i + 1];
      // data_offset is relative to the moof box start (default-base-is-moof).
      expect(declared).toBe(mdat.start - moof.start + mdat.header);
    }
  });

  it("reports a sane mvhd duration for the 5120+3072 sample streams", () => {
    // video: 4 samples x 2560/12800 = 0.8s; audio: 5 x 1024/48000 ≈ 0.107s.
    const moov = find(out, "moov")!;
    const mvhd = childrenOf(out, moov).find((b) => b.type === "mvhd")!;
    const dv = new DataView(out.buffer, out.byteOffset);
    const base = mvhd.start + mvhd.header;
    const timescale = dv.getUint32(base + 12);
    const duration = dv.getUint32(base + 16);
    expect(timescale).toBe(1000);
    expect(Math.abs(duration - 800)).toBeLessThanOrEqual(20);
  });
});

describe("muxFmp4 — fragment ordering", () => {
  it("interleaves fragments chronologically across tracks", () => {
    // Audio starts late (baseTime 24000/48000 = 0.5s), so the first two
    // fragments must be video, then audio, then video (0.4s start).
    const video = videoStream(1); // frags at 0s and 0.4s
    const audio = audioStream(2, { baseTime: 24000 }); // frags at 0.5s and ~0.56s
    const out = muxFmp4(video, audio);
    const kinds: string[] = [];
    for (const b of walk(out)) {
      if (b.type !== "moof") continue;
      const traf = childrenOf(out, b).find((c) => c.type === "traf")!;
      const tfhd = childrenOf(out, traf).find((c) => c.type === "tfhd")!;
      kinds.push(String(new DataView(out.buffer, out.byteOffset).getUint32(tfhd.start + tfhd.header + 4)));
    }
    expect(kinds.map(Number)).toEqual([1, 1, 2, 2]);
  });
});

describe("muxFmp4 — refusals", () => {
  it("refuses pssh in the video init", () => {
    const pssh = box("pssh", new Uint8Array(32));
    const video = videoStream(1, { pssh });
    const audio = audioStream(2);
    expect(() => muxFmp4(video, audio)).toThrow(/Encrypted|protection/i);
  });

  it("refuses senc (sample encryption) in a fragment", () => {
    const video = videoStream(1);
    const audio = audioStream(2, { senc: true });
    expect(() => muxFmp4(video, audio)).toThrow(/Encrypted/);
  });

  it("refuses init without any media fragments", () => {
    const video = initOnlyStream(1);
    const audio = audioStream(2);
    expect(() => muxFmp4(video, audio)).toThrow(/no media fragments/);
  });

  it("refuses a video input that only carries an audio handler", () => {
    const audio = audioStream(2);
    const { init } = splitFmp4(audio);
    const audioInitOnly = concat([init, buildFragment({ trackId: 2, baseTime: 0, sequence: 1, samples: [{ dur: 1024, size: 60 }] })]);
    expect(() => muxFmp4(audioInitOnly, audio)).toThrow(/No video track/);
  });

  it("refuses multi-track init segments", () => {
    const multi = multiVideoTrakStream();
    const frag = buildFragment({ trackId: 1, baseTime: 0, sequence: 1, samples: [{ dur: 2560, size: 10 }] });
    const stream = concat([multi, frag]);
    const audio = audioStream(2);
    expect(() => muxFmp4(stream, audio)).toThrow(/Multi-track/);
  });
});

describe("muxFmp4 — v1 (negative cts) path", () => {
  it("uses version-1 trun and preserves composition offsets", () => {
    const videoInit = buildInit({ trackId: 1, handler: "vide", codec4cc: "avc1", timescale: 12800, width: 64, height: 64 });
    const v1Frag = buildFragment({
      trackId: 1,
      baseTime: 0,
      sequence: 1,
      samples: [
        { dur: 2560, size: 100, cts: -1280 },
        { dur: 2560, size: 100, cts: -1280 },
      ],
    });
    const video = concat([videoInit, v1Frag]);
    const audio = audioStream(2);
    const out = muxFmp4(video, audio);
    // The video fragment sorts FIRST (baseTime 0 < audio 0) only when tied;
    // both tracks start at 0s so video (track order 0) leads. Find the first
    // moof, read its tfhd track id, then locate that track's trun.
    const dv = new DataView(out.buffer, out.byteOffset);
    const firstMoof = walk(out).find((b) => b.type === "moof")!;
    const traf = childrenOf(out, firstMoof).find((c) => c.type === "traf")!;
    const tfhd = childrenOf(out, traf).find((c) => c.type === "tfhd")!;
    const trackId = dv.getUint32(tfhd.start + tfhd.header + 4);
    expect(trackId).toBe(1); // video fragment leads
    const trun = childrenOf(out, traf).find((c) => c.type === "trun")!;
    expect(out[trun.start + trun.header]).toBe(1); // version 1 (negative cts)
    // First sample entry: dur(4), size(4), flags(4), then signed cts = -1280.
    const entry = trun.start + trun.header + 12; // ver/flags+count+offset
    expect(dv.getInt32(entry + 12)).toBe(-1280);
  });
});

describe("muxFmp4 — box writer sanity", () => {
  it("fourcc and u32 round-trip via walk", () => {
    const b = box("abcd", u32(0xdeadbeef));
    const boxes = walk(b);
    expect(boxes[0].type).toBe("abcd");
    expect(boxes[0].size).toBe(12);
    expect(new DataView(b.buffer).getUint32(8)).toBe(0xdeadbeef);
    expect(Array.from(fourcc("abcd"))).toEqual([97, 98, 99, 100]);
  });
});
