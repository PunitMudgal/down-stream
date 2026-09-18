/**
 * Hand-assembled minimal fMP4 fixtures.
 *
 * These builders lay out ISO-BMFF boxes by hand (sizes, fullbox headers,
 * trak/tkhd/mdia/minf/stbl trees, moof/tfhd/tfdt/trun) independently of
 * src/lib/mp4mux.ts — deliberately NOT generated via muxFmp4 — so muxer
 * bugs cannot cancel out in a round-trip test. The streams are spec-shaped
 * enough for the muxer's parser: single trak per init, fragmented layout,
 * explicit trun entries.
 *
 * Layout references: ISO/IEC 14496-12 (ISOBMFF) and 14496-14 (fMP4).
 */

// ---- primitive writers -------------------------------------------------

export function u8(...bytes: number[]): Uint8Array {
  return Uint8Array.from(bytes);
}

export function u16(n: number): Uint8Array {
  return Uint8Array.from([(n >> 8) & 0xff, n & 0xff]);
}

export function u32(n: number): Uint8Array {
  return Uint8Array.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

export function i32(n: number): Uint8Array {
  return u32(n >>> 0);
}

export function u64(n: number): Uint8Array {
  const hi = Math.floor(n / 0x100000000);
  const lo = n >>> 0;
  return Uint8Array.from([
    (hi >>> 24) & 0xff,
    (hi >>> 16) & 0xff,
    (hi >>> 8) & 0xff,
    hi & 0xff,
    (lo >>> 24) & 0xff,
    (lo >>> 16) & 0xff,
    (lo >>> 8) & 0xff,
    lo & 0xff,
  ]);
}

export function fourcc(s: string): Uint8Array {
  return Uint8Array.from([...s].map((c) => c.charCodeAt(0)));
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

/** FullBox header: version byte + 24-bit flags. */
function fullbox(version: number, flags: number): Uint8Array {
  return Uint8Array.from([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff]);
}

/** Box with 32-bit size prefix. */
export function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(8 + body.byteLength), fourcc(type), body]);
}

// ---- trak tree ---------------------------------------------------------

/** Minimal clean stsd entry: size+type+6 reserved+data_reference_index+payload. */
function stsdEntry(type: string, payload: Uint8Array): Uint8Array {
  return concat([u32(8 + 6 + 2 + payload.byteLength), fourcc(type), new Uint8Array(6), u16(1), payload]);
}

/**
 * stbl/stsd with a single sample entry. `sampleEntryPayload` is
 * intentionally tiny (a bare SampleEntry); the muxer only reads the
 * 4cc codec at stsd.data[12..16].
 */
function buildStbl(codec4cc: string): Uint8Array {
  const stsd = box("stsd", fullbox(0, 0), u32(1), stsdEntry(codec4cc, new Uint8Array(8)));
  const stts = box("stts", fullbox(0, 0), u32(0));
  const stsc = box("stsc", fullbox(0, 0), u32(0));
  const stsz = box("stsz", fullbox(0, 0), u32(0), u32(0));
  const stco = box("stco", fullbox(0, 0), u32(0));
  return box("stbl", stsd, stts, stsc, stsz, stco);
}

export interface TrakSpec {
  trackId: number;
  handler: "vide" | "soun";
  codec4cc: string;
  timescale: number;
  width?: number;
  height?: number;
}

function buildTrak(spec: TrakSpec): Uint8Array {
  // tkhd v0: id at payload offset 12 (after ver/flags + ctime + mtime)
  const tkhd = box(
    "tkhd",
    concat([
      fullbox(0, 3),
      u32(0), u32(0), // creation/modification
      u32(spec.trackId), u32(0), // track_ID + reserved
      new Uint8Array(8), // reserved
      u16(0), u32(0), // layer + alternate_group
      u16(0), u16(0), // volume + reserved
      u32(0x00010000), u32(0), u32(0),
      u32(0), u32(0x00010000), u32(0),
      u32(0), u32(0), u32(0x40000000),
      u32(spec.width ?? 0), u32(spec.height ?? 0),
    ]),
  );
  const mdhd = box("mdhd", concat([fullbox(0, 0), u32(0), u32(0), u32(spec.timescale), u32(0)]), u16(0x55c4), u16(0));
  const hdlr = box("hdlr", fullbox(0, 0), u32(0), fourcc(spec.handler), new Uint8Array(12), u8(0));
  const mediaHeader =
    spec.handler === "soun"
      ? box("smhd", fullbox(0, 0), u16(0), u16(0))
      : box("vmhd", fullbox(0, 1), u16(0), u16(0), u16(0), u16(0));
  const dinf = box("dinf", box("dref", fullbox(0, 0), u32(1), box("url ", fullbox(0, 1))));
  const minf = box("minf", mediaHeader, dinf, buildStbl(spec.codec4cc));
  const mdia = box("mdia", mdhd, hdlr, minf);
  return box("trak", tkhd, mdia);
}

function buildTrex(trackId: number): Uint8Array {
  // default_sample_duration/size/flags = 0 (all explicit in trun anyway)
  return box("trex", fullbox(0, 0), u32(trackId), u32(1), u32(0), u32(0), u32(0));
}

export interface InitSpec extends TrakSpec {
  /** Add a pssh box to moov (DRM-tainted fixture). */
  pssh?: Uint8Array;
}

/** ftyp + moov (single trak + optional mvex) — the init segment. */
export function buildInit(spec: InitSpec): Uint8Array {
  const ftyp = box("ftyp", fourcc("isom"), u32(0x200), fourcc("isom"), fourcc("iso2"), fourcc("avc1"), fourcc("mp41"));
  const mvex = box("mvex", box("mehd", fullbox(0, 0), u32(0)), buildTrex(spec.trackId));
  const moovChildren: Uint8Array[] = [
    box("mvhd", fullbox(0, 0), u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), new Uint8Array(10), u32(0x00010000), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0x40000000), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0x40000000), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(2)),
    buildTrak(spec),
    mvex,
  ];
  if (spec.pssh) moovChildren.push(spec.pssh);
  return concat([ftyp, box("moov", ...moovChildren)]);
}

// ---- fragments ---------------------------------------------------------

export interface SampleSpec {
  dur: number;
  size: number;
  flags?: number;
  cts?: number;
}

/** One moof+mdat fragment for a single track, explicit trun entries. */
export function buildFragment(opts: {
  trackId: number;
  baseTime: number;
  samples: SampleSpec[];
  /** Byte pattern for the mdat payload (repeated to each sample's size). */
  fill?: number;
  /** Embed a senc box in traf (sample encryption — DRM-tainted). */
  senc?: Uint8Array;
  sequence: number;
}): Uint8Array {
  // Version 1 trun is required for negative composition offsets (signed
  // cts); version 0 stores cts unsigned per ISO 14496-12 §8.8.8.
  const useV1 = opts.samples.some((s) => (s.cts ?? 0) < 0);
  const entries = opts.samples.map((s) => concat([u32(s.dur), u32(s.size), u32(s.flags ?? 0x02000000), i32(s.cts ?? 0)]));
  const trun = box(
    "trun",
    concat([fullbox(useV1 ? 1 : 0, 0x000f01), u32(opts.samples.length), u32(0), ...entries]),
  );
  // tfhd: default-base-is-moof + track_ID only.
  const tfhd = box("tfhd", concat([fullbox(0, 0x020000), u32(opts.trackId)]));
  const tfdt = box("tfdt", concat([fullbox(1, 0), u64(opts.baseTime)]));
  const trafChildren: Uint8Array[] = [tfhd, tfdt];
  if (opts.senc) trafChildren.push(opts.senc);
  trafChildren.push(trun);
  const traf = box("traf", ...trafChildren);
  const moof = box("moof", box("mfhd", fullbox(0, 0), u32(opts.sequence)), traf);
  const payload = new Uint8Array(opts.samples.reduce((n, s) => n + s.size, 0)).fill(opts.fill ?? 0xab);
  // data_offset (trun payload offset 8): first mdat byte after moof start.
  const dataOffset = moof.byteLength + 8;
  trun.set(u32(dataOffset), 8);
  return concat([moof, box("mdat", payload)]);
}

// ---- convenience stream builders ---------------------------------------

export function videoStream(trackId = 1, opts: { baseTime?: number; pssh?: Uint8Array } = {}): Uint8Array {
  const init = buildInit({ trackId, handler: "vide", codec4cc: "avc1", timescale: 12800, width: 64, height: 64, pssh: opts.pssh });
  const f1 = buildFragment({ trackId, baseTime: opts.baseTime ?? 0, sequence: 1, samples: [{ dur: 2560, size: 100 }, { dur: 2560, size: 120 }] });
  const f2 = buildFragment({ trackId, baseTime: (opts.baseTime ?? 0) + 5120, sequence: 2, samples: [{ dur: 2560, size: 80 }, { dur: 2560, size: 90 }] });
  return concat([init, f1, f2]);
}

export function audioStream(trackId = 2, opts: { baseTime?: number; senc?: boolean; pssh?: Uint8Array } = {}): Uint8Array {
  const init = buildInit({ trackId, handler: "soun", codec4cc: "mp4a", timescale: 48000, pssh: opts.pssh });
  const senc = opts.senc
    ? box("senc", fullbox(0, 2), u32(2), u32(0), u32(0), u8(0), u8(0), u8(0), u8(0), u8(0), u8(0))
    : undefined;
  const f1 = buildFragment({ trackId, baseTime: opts.baseTime ?? 0, sequence: 1, samples: [{ dur: 1024, size: 60 }, { dur: 1024, size: 64 }, { dur: 1024, size: 58 }], senc });
  const f2 = buildFragment({ trackId, baseTime: (opts.baseTime ?? 0) + 3072, sequence: 2, samples: [{ dur: 1024, size: 62 }, { dur: 1024, size: 66 }] });
  return concat([init, f1, f2]);
}

/** Init-only stream (no moof) — used for missing-fragment refusals. */
export function initOnlyStream(trackId = 1): Uint8Array {
  return buildInit({ trackId, handler: "vide", codec4cc: "avc1", timescale: 12800, width: 64, height: 64 });
}

/** Two VIDEO traks in one moov — multi-track refusal fixture. */
export function multiVideoTrakStream(): Uint8Array {
  const ftyp = box("ftyp", fourcc("isom"), u32(0x200), fourcc("isom"));
  const trakV1 = buildTrak({ trackId: 1, handler: "vide", codec4cc: "avc1", timescale: 12800, width: 64, height: 64 });
  const trakV2 = buildTrak({ trackId: 2, handler: "vide", codec4cc: "avc1", timescale: 12800, width: 64, height: 64 });
  const mvex = box("mvex", buildTrex(1), buildTrex(2));
  return concat([ftyp, box("moov", trakV1, trakV2, mvex)]);
}

/** Bare pssh box of the given payload size (DRM marker). */
export function psshBox(payloadSize = 32): Uint8Array {
  return box("pssh", new Uint8Array(payloadSize));
}

/**
 * One moov carrying BOTH a video and an audio trak and no mvex — a muxed
 * (player-style) MP4, exactly what orderAndValidateSegmentParts and the
 * muxer must refuse. Doubles as the no-mvex (non-fragmented) fixture.
 */
export function muxedStream(): Uint8Array {
  const ftyp = box("ftyp", fourcc("isom"), u32(0x200), fourcc("isom"));
  const trakV = buildTrak({ trackId: 1, handler: "vide", codec4cc: "avc1", timescale: 12800, width: 64, height: 64 });
  const trakA = buildTrak({ trackId: 2, handler: "soun", codec4cc: "mp4a", timescale: 48000 });
  return concat([ftyp, box("moov", trakV, trakA)]);
}

/** vide+soun traks WITH mvex — fragmented layout but a muxed stream. */
export function muxedFragmentedStream(): Uint8Array {
  const ftyp = box("ftyp", fourcc("isom"), u32(0x200), fourcc("isom"));
  const trakV = buildTrak({ trackId: 1, handler: "vide", codec4cc: "avc1", timescale: 12800, width: 64, height: 64 });
  const trakA = buildTrak({ trackId: 2, handler: "soun", codec4cc: "mp4a", timescale: 48000 });
  const mvex = box("mvex", buildTrex(1), buildTrex(2));
  return concat([ftyp, box("moov", trakV, trakA, mvex)]);
}

/** pssh hidden inside moov > udta (common packager layout, any depth). */
export function psshInUdtaStream(): Uint8Array {
  const init = buildInit({ trackId: 1, handler: "vide", codec4cc: "avc1", timescale: 12800, width: 64, height: 64 });
  const boxes = [...walkBoxes(init)];
  const moov = boxes.find((b) => b.type === "moov")!;
  const withUdta = concat([
    init.subarray(moov.start, moov.start + moov.header),
    init.subarray(moov.start + moov.header, moov.start + moov.size),
    box("udta", psshBox(24)),
  ]);
  const moovSize = withUdta.byteLength;
  withUdta.set(u32(moovSize), 0);
  const ftyp = init.subarray(0, boxes.find((b) => b.type === "ftyp")!.size);
  const f1 = buildFragment({ trackId: 1, baseTime: 0, sequence: 1, samples: [{ dur: 2560, size: 100 }] });
  const f2 = buildFragment({ trackId: 1, baseTime: 2560, sequence: 2, samples: [{ dur: 2560, size: 80 }] });
  return concat([ftyp, withUdta, f1, f2]);
}

// ---- internal box walker for fixture post-processing --------------------

interface RawBox {
  type: string;
  start: number;
  size: number;
  header: number;
}

function walkBoxes(u8: Uint8Array): RawBox[] {
  const out: RawBox[] = [];
  let off = 0;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  while (off + 8 <= u8.byteLength) {
    const size = dv.getUint32(off);
    const type = String.fromCharCode(u8[off + 4], u8[off + 5], u8[off + 6], u8[off + 7]);
    if (size < 8 || off + size > u8.byteLength) break;
    out.push({ type, start: off, size, header: 8 });
    off += size;
  }
  return out;
}
