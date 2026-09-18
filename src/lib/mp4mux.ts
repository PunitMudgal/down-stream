/**
 * Minimal fragmented-MP4 muxer: merges one video + one audio fMP4 byte
 * stream (init + media fragments, e.g. X/TikTok/IG HLS/DASH variants or MSE
 * captures) into a single multi-track fMP4 file. No re-encode, no remux
 * library, fully local.
 *
 * Strategy (kept deliberately narrow for correctness):
 * - Each input must be ftyp + moov init followed by moof/mdat fragments,
 *   exactly one audio/video track each.
 * - Output moov reuses the input track boxes verbatim (codecs, timescales,
 *   edit lists preserved), renumbered to track IDs 1 (video) and 2 (audio),
 *   plus fresh mvhd/mvex. No sample-table (stbl) rebuild needed: output
 *   stays fragmented.
 * - Each input fragment becomes one single-track output fragment, ordered
 *   chronologically across tracks. trun entries are rewritten fully explicit
 *   (duration/size/flags/cts) with recomputed data offsets.
 * - Encrypted input (senc/saiz/pssh) or non-fragmented input throws —
 *   never silently produce garbage.
 */

export interface MuxSample {
  dur: number;
  size: number;
  flags: number;
  cts: number;
}

interface Box {
  type: string;
  start: number;
  size: number;
  header: number;
  data: Uint8Array;
}

interface TrackDefaults {
  duration: number;
  size: number;
  flags: number;
}

interface ParsedTrack {
  id: number;
  timescale: number;
  handler: string;
  codec: string;
  trak: Uint8Array;
  trex: TrackDefaults;
}

interface ParsedFrag {
  trackId: number;
  baseTime: number;
  samples: MuxSample[];
  payload: Uint8Array;
}

function dv(u8: Uint8Array, off = 0): DataView {
  return new DataView(u8.buffer, u8.byteOffset + off, u8.byteLength - off);
}

function ascii(u8: Uint8Array, off: number): string {
  return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
}

function parseBoxes(u8: Uint8Array): Box[] {
  const out: Box[] = [];
  let off = 0;
  while (off + 8 <= u8.length) {
    let size = dv(u8, off).getUint32(0);
    const type = ascii(u8, off + 4);
    let header = 8;
    if (size === 1) {
      if (off + 16 > u8.length) throw new Error(`Truncated 64-bit box header for '${type}'.`);
      const hi = dv(u8, off).getUint32(8);
      const lo = dv(u8, off).getUint32(12);
      size = hi * 0x100000000 + lo;
      header = 16;
    } else if (size === 0) {
      size = u8.length - off;
    }
    if (size < header || off + size > u8.length) {
      throw new Error(`Corrupt '${type}' box (size ${size} at ${off}).`);
    }
    out.push({ type, start: off, size, header, data: u8.subarray(off + header, off + size) });
    off += size;
  }
  return out;
}

function child(box: Box, type: string): Box | undefined {
  return parseBoxes(box.data).find((b) => b.type === type);
}

function children(box: Box, type: string): Box[] {
  return parseBoxes(box.data).filter((b) => b.type === type);
}

function full(box: Box): { version: number; flags: number } {
  const d = dv(box.data, 0);
  return { version: d.getUint8(0), flags: (d.getUint8(1) << 16) | (d.getUint8(2) << 8) | d.getUint8(3) };
}

export function looksFmp4(u8: Uint8Array): boolean {
  try {
    const boxes = parseBoxes(u8.subarray(0, Math.min(u8.length, 1 << 20)));
    const types = boxes.map((b) => b.type);
    return types.includes("ftyp") && types.includes("moov");
  } catch {
    return false;
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  dv(b).setUint32(0, n >>> 0);
  return b;
}

function u64(n: number): Uint8Array {
  const b = new Uint8Array(8);
  const hi = Math.floor(n / 0x100000000);
  dv(b).setUint32(0, hi >>> 0);
  dv(b).setUint32(4, n >>> 0);
  return b;
}

function fourcc(s: string): Uint8Array {
  return Uint8Array.from([s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]);
}

/** Box writer (exported for tests). Size auto-prefixed. */
export function mp4box(type: string, ...payloads: Uint8Array[]): Uint8Array {
  const body = concat(payloads);
  const out = new Uint8Array(8 + body.byteLength);
  dv(out).setUint32(0, out.byteLength);
  out.set(fourcc(type), 4);
  out.set(body, 8);
  return out;
}

/** Split concatenated fMP4 bytes into init (ftyp+moov) + per-fragment chunks. */
export function splitFmp4(u8: Uint8Array): { init: Uint8Array; frags: Uint8Array[] } {
  const boxes = parseBoxes(u8);
  const initParts = boxes.filter((b) => b.type === "ftyp" || b.type === "moov");
  const initTypes = initParts.map((b) => b.type);
  if (!initTypes.includes("ftyp") || !initTypes.includes("moov")) {
    throw new Error("Not fragmented MP4: init segment lacks ftyp/moov.");
  }
  const init = concat(initParts.map((b) => u8.slice(b.start, b.start + b.size)));
  // Group top-level boxes into fragments: each moof starts one; trailing
  // boxes (mdat, styp, prft, emsg…) belong to it. Only moof+mdat are used.
  const frags: Uint8Array[] = [];
  let current: Uint8Array[] | null = null;
  let currentStart = 0;
  for (const b of boxes) {
    if (b.type === "ftyp" || b.type === "moov") continue;
    if (b.type === "moof") {
      if (current) frags.push(u8.slice(currentStart, b.start));
      current = [];
      currentStart = b.start;
    }
  }
  if (current) frags.push(u8.slice(currentStart));
  if (!frags.length) throw new Error("Not fragmented MP4: no media fragments found.");
  return { init, frags };
}

function parseTrex(mvex: Box | undefined, trackId: number): TrackDefaults {
  const def = { duration: 0, size: 0, flags: 0 };
  if (!mvex) return def;
  for (const trex of children(mvex, "trex")) {
    if (dv(trex.data, 4).getUint32(0) !== trackId) continue;
    return {
      duration: dv(trex.data, 12).getUint32(0),
      size: dv(trex.data, 16).getUint32(0),
      flags: dv(trex.data, 20).getUint32(0),
    };
  }
  return def;
}

function parseInitTrack(init: Uint8Array, wantHandler: "vide" | "soun"): ParsedTrack {
  const boxes = parseBoxes(init);
  const moov = boxes.find((b) => b.type === "moov");
  if (!moov) throw new Error("Init segment has no moov box.");
  for (const pssh of children(moov, "pssh")) {
    void pssh;
    throw new Error("Encrypted content (protection box) — refusing to mux.");
  }
  const traks = children(moov, "trak");
  // NOTE: child box offsets are relative to moov payload — rebase to init.
  const moovBase = moov.start + moov.header;
  const matches: ParsedTrack[] = [];
  for (const trak of traks) {
    const tkhd = child(trak, "tkhd");
    const mdia = child(trak, "mdia");
    if (!tkhd || !mdia) continue;
    const tkv = full(tkhd);
    const id = dv(tkhd.data, 0).getUint32(tkv.version === 1 ? 20 : 12);
    const mdhd = child(mdia, "mdhd");
    const hdlr = child(mdia, "hdlr");
    const minf = child(mdia, "minf");
    if (!mdhd || !hdlr || !minf) continue;
    const mdv = full(mdhd);
    const timescale = dv(mdhd.data, 0).getUint32(mdv.version === 1 ? 20 : 12) || 1;
    const handler = ascii(hdlr.data, 8);
    const stbl = child(minf, "stbl");
    const stsd = stbl ? child(stbl, "stsd") : undefined;
    let codec = "";
    if (stsd && stsd.data.byteLength >= 16) {
      codec = ascii(stsd.data, 12);
    }
    // Sample encryption inside the track = DRM.
    const stblBoxes = stbl ? parseBoxes(stbl.data).map((b) => b.type) : [];
    if (stblBoxes.includes("saiz") || stblBoxes.includes("sbgp") || stblBoxes.includes("senc")) {
      throw new Error("Encrypted samples in track — refusing to mux.");
    }
    if (handler === wantHandler) {
      matches.push({
        id,
        timescale,
        handler,
        codec,
        trak: init.slice(moovBase + trak.start, moovBase + trak.start + trak.size),
        trex: parseTrex(child(moov, "mvex"), id),
      });
    }
  }
  if (!matches.length) throw new Error(`No ${wantHandler === "vide" ? "video" : "audio"} track in init segment.`);
  if (matches.length > 1) throw new Error("Multi-track input per stream is not supported.");
  return matches[0];
}

function parseTraf(traf: Box, trex: TrackDefaults): { trackId: number; baseTime: number; samples: MuxSample[] } {
  for (const t of ["senc", "saiz", "sbgp"]) {
    if (child(traf, t)) throw new Error("Encrypted samples in fragment (sample encryption) — refusing to mux.");
  }
  const tfhd = child(traf, "tfhd");
  if (!tfhd) throw new Error("Fragment traf has no tfhd box.");
  const tf = full(tfhd);
  const d = dv(tfhd.data, 0);
  let off = 4;
  const trackId = d.getUint32(off);
  off += 4;
  let defDur: number | null = null;
  let defSize: number | null = null;
  let defFlags: number | null = null;
  let firstFlags: number | null = null;
  if (tf.flags & 0x000001) off += 8; // base_data_offset (normalized away on write)
  if (tf.flags & 0x000002) off += 4; // sample_description_index
  if (tf.flags & 0x000008) {
    defDur = d.getUint32(off);
    off += 4;
  }
  if (tf.flags & 0x000010) {
    defSize = d.getUint32(off);
    off += 4;
  }
  if (tf.flags & 0x000020) {
    defFlags = d.getUint32(off);
    off += 4;
  }
  if (tf.flags & 0x000004) {
    firstFlags = d.getUint32(off);
    off += 4;
  }

  let baseTime = 0;
  const tfdt = child(traf, "tfdt");
  if (tfdt) {
    const v = full(tfdt);
    baseTime = v.version === 1 ? Number(dv(tfdt.data, 0).getBigUint64(4)) : dv(tfdt.data, 0).getUint32(4);
  }

  const samples: MuxSample[] = [];
  for (const trun of children(traf, "trun")) {
    const rf = full(trun);
    const rd = dv(trun.data, 0);
    const count = rd.getUint32(4);
    let ro = 8;
    if (rf.flags & 0x000001) ro += 4; // data_offset (recomputed on write)
    if (rf.flags & 0x000004) ro += 4; // first_sample_flags
    const hasDur = !!(rf.flags & 0x000100);
    const hasSize = !!(rf.flags & 0x000200);
    const hasFlags = !!(rf.flags & 0x000400);
    const hasCts = !!(rf.flags & 0x000800);
    const entry = 4 * [hasDur, hasSize, hasFlags, hasCts].filter(Boolean).length;
    if (ro + count * entry > trun.data.byteLength) {
      throw new Error("Corrupt trun box: sample table overruns the box.");
    }
    for (let i = 0; i < count; i++) {
      let dur = defDur ?? trex.duration;
      let size = defSize ?? trex.size;
      let flags = i === 0 && firstFlags !== null ? firstFlags : (defFlags ?? trex.flags);
      let cts = 0;
      let eo = ro + i * entry;
      if (hasDur) {
        dur = rd.getUint32(eo);
        eo += 4;
      }
      if (hasSize) {
        size = rd.getUint32(eo);
        eo += 4;
      }
      if (hasFlags) {
        flags = rd.getUint32(eo);
        eo += 4;
      }
      if (hasCts) {
        cts = rf.version === 1 ? rd.getInt32(eo) : rd.getUint32(eo);
        eo += 4;
      }
      if (!dur) throw new Error("Fragment has zero-duration samples with no usable default.");
      samples.push({ dur, size, flags, cts });
    }
  }
  if (!samples.length) throw new Error("Fragment contains no samples.");
  return { trackId, baseTime, samples };
}

function patchTrackId(trak: Uint8Array, newId: number): Uint8Array {
  const out = trak.slice();
  // Input IS the trak box (header included) — walk its children.
  const inner = parseBoxes(out.subarray(8));
  const tkhd = inner.find((b) => b.type === "tkhd");
  if (!tkhd) throw new Error("Track has no tkhd box.");
  // FullBox: size(4)+type(4)+version(1)+flags(3); v0 id follows
  // creation(4)+modification(4); v1 follows creation(8)+modification(8).
  const absStart = 8 + tkhd.start;
  const version = out[absStart + 8];
  const idOff = absStart + 8 + 4 + (version === 1 ? 16 : 8);
  dv(out, 0).setUint32(idOff, newId);
  return out;
}

function buildMvhd(timescale: number, duration: number): Uint8Array {
  const unity = Uint8Array.from([
    0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0x40, 0, 0, 0,
  ]);
  return mp4box(
    "mvhd",
    concat([
      new Uint8Array([0, 0, 0, 0]), // version + flags
      u32(0), // creation_time
      u32(0), // modification_time
      u32(timescale),
      u32(duration),
      u32(0x00010000), // rate 1.0
      new Uint8Array([0x01, 0x00]), // volume 1.0
      new Uint8Array(2), // reserved
      new Uint8Array(8), // reserved
      unity, // display matrix
      new Uint8Array(24), // pre_defined
      u32(3), // next_track_ID
    ]),
  );
}

function buildTrex(trackId: number, def: TrackDefaults): Uint8Array {
  return mp4box("trex", concat([new Uint8Array(4), u32(trackId), u32(1), u32(def.duration), u32(def.size), u32(def.flags)]));
}

function buildMehd(duration: number): Uint8Array {
  return mp4box("mehd", concat([new Uint8Array(4), u32(duration)]));
}

interface OutFrag {
  sec: number;
  newId: number;
  baseTime: number;
  samples: MuxSample[];
  payload: Uint8Array;
}

function buildFragment(frag: OutFrag, sequence: number): Uint8Array {
  const useV1 = frag.samples.some((s) => s.cts < 0);
  const entrySize = 16; // dur+size+flags+cts always explicit
  const trunBody = concat([
    new Uint8Array([useV1 ? 1 : 0, 0, 0x0f, 0x01]),
    u32(frag.samples.length),
    u32(0), // data_offset placeholder
    concat(
      frag.samples.map((s) =>
        concat([u32(s.dur), u32(s.size), u32(s.flags), useV1 ? u32(s.cts) : u32(s.cts >>> 0)]),
      ),
    ),
  ]);
  const trun = mp4box("trun", trunBody);
  // tfhd: flags = default-base-is-moof (0x020000), track_ID only.
  const tfhd = mp4box("tfhd", concat([new Uint8Array([0, 2, 0, 0]), u32(frag.newId)]));
  const tfdt = mp4box("tfdt", concat([new Uint8Array([1, 0, 0, 0]), u64(frag.baseTime)]));
  // data_offset lives after sample_count: header(8) + ver/flags(4) +
  // sample_count(4) = offset 16 within trun.
  const dataOffsetHolder = mp4box(
    "moof",
    mp4box("mfhd", concat([new Uint8Array(4), u32(sequence)])),
    mp4box("traf", tfhd, tfdt, trun),
  );
  // data_offset is relative to moof start (default-base-is-moof) -> first mdat byte.
  const dataOffset = dataOffsetHolder.byteLength + 8;
  dv(trun, 0).setUint32(16, dataOffset);
  const moof = mp4box(
    "moof",
    mp4box("mfhd", concat([new Uint8Array(4), u32(sequence)])),
    mp4box("traf", tfhd, tfdt, trun),
  );
  return concat([moof, mp4box("mdat", frag.payload)]);
}

/**
 * Merge one video + one audio fMP4 stream into a single file.
 * Inputs: full concatenated bytes per track (init + fragments).
 */
export function muxFmp4(videoBytes: Uint8Array, audioBytes: Uint8Array): Uint8Array {
  const v = splitFmp4(videoBytes);
  const a = splitFmp4(audioBytes);
  const vTrack = parseInitTrack(v.init, "vide");
  const aTrack = parseInitTrack(a.init, "soun");

  interface WorkFrag extends OutFrag {
    track: number;
  }
  const work: WorkFrag[] = [];
  const ingest = (frags: Uint8Array[], track: ParsedTrack, order: number, newId: number) => {
    for (const f of frags) {
      const boxes = parseBoxes(f);
      const moof = boxes.find((b) => b.type === "moof");
      if (!moof) throw new Error("Fragment has no moof box.");
      const payloads: Uint8Array[] = [];
      for (const b of boxes) {
        if (b.type === "mdat") payloads.push(f.slice(b.start + b.header, b.start + b.size));
      }
      if (!payloads.length) throw new Error("Fragment has no media data.");
      const trafs = children(moof, "traf");
      if (!trafs.length) throw new Error("Fragment moof has no traf box.");
      for (const traf of trafs) {
        const parsed = parseTraf(traf, track.trex);
        work.push({
          track: order,
          sec: parsed.baseTime / track.timescale,
          newId,
          baseTime: parsed.baseTime,
          samples: parsed.samples,
          payload: concat(payloads),
        });
      }
    }
  };
  ingest(v.frags, vTrack, 0, 1);
  ingest(a.frags, aTrack, 1, 2);
  work.sort((x, y) => (x.sec === y.sec ? x.track - y.track : x.sec - y.sec));

  const trackEnd: Record<number, number> = { 0: 0, 1: 0 };
  const scales = [vTrack.timescale, aTrack.timescale];
  for (const w of work) {
    const total = w.samples.reduce((n, s) => n + s.dur, 0);
    trackEnd[w.track] = Math.max(trackEnd[w.track], (w.baseTime + total) / scales[w.track]);
  }
  const movieSec = Math.max(trackEnd[0], trackEnd[1]);
  if (!(movieSec > 0)) throw new Error("Could not determine media duration.");

  const ftyp = mp4box("ftyp", concat([fourcc("isom"), u32(0), fourcc("isom"), fourcc("iso6"), fourcc("mp41")]));
  const moov = mp4box(
    "moov",
    buildMvhd(1000, Math.round(movieSec * 1000)),
    patchTrackId(vTrack.trak, 1),
    patchTrackId(aTrack.trak, 2),
    mp4box("mvex", buildMehd(Math.round(movieSec * 1000)), buildTrex(1, vTrack.trex), buildTrex(2, aTrack.trex)),
  );

  const outFrags = work.map((w, i) => buildFragment(w, i + 1));
  return concat([ftyp, moov, ...outFrags]);
}
