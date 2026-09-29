/**
 * Repair a raw MediaSource append stream before it is saved.
 *
 * `SourceBuffer.appendBuffer` hands us whatever the player chose to feed: whole
 * segments in order in the simple case, but also
 *   - a partial tail (the player is still downloading the last segment),
 *   - a re-appended, identical init header (`SourceBuffer.reset()`,
 *     `changeType()`, or a seek back to the start),
 *   - fragments appended twice (re-buffered after eviction),
 *   - fragments whose decode time jumps backwards (seek back),
 *   - a second, *different* init header after an ABR quality switch.
 * A naive concatenation of those bytes is not a valid fMP4 file: the muxer
 * refuses it ("expected exactly one ftyp and one moov", "trailing junk",
 * "Corrupt 'moof' box") and the whole download fails even though almost every
 * byte is fine.
 *
 * This module turns such a stream into the longest playable prefix, dropping
 * only the parts that would corrupt the file, and reports what it dropped so
 * the UI can explain the result. Non-ISO-BMFF captures (MPEG-TS, WebM) pass
 * through untouched — concatenation is already valid for them.
 *
 * Pure byte work (no DOM, no chrome.*), so it is unit-testable.
 */

export interface IsoBox {
  type: string;
  /** Offset of the box header inside the walked buffer. */
  start: number;
  /** Total box size, header included. */
  size: number;
  /** Header size (8, or 16 for 64-bit sizes). */
  header: number;
}

/** What the repair changed, so a job note can say it in prose. */
export interface CaptureCleanup {
  /** Bytes to save (the original array when nothing had to be dropped). */
  bytes: Uint8Array;
  /** Bytes after the last complete box (an unfinished fragment). */
  droppedTailBytes: number;
  /** Number of re-appended, byte-identical init boxes (`ftyp`/`moov`) dropped. */
  droppedInitDuplicates: number;
  /** Bytes of fragments that were exact duplicates of an earlier fragment. */
  droppedFragmentDuplicates: number;
  /** Bytes of fragments whose decode time went backwards. */
  droppedRewindFragments: number;
  /** A second, *different* init header appeared (ABR switch) — stream cut there. */
  stoppedAtInitSwitch: boolean;
}

/** Top-level box types a MediaSource append stream can legitimately begin with. */
const ISO_BMFF_HEADS = new Set(["ftyp", "styp", "moov", "moof", "sidx", "free", "skip", "mdat", "emsg", "prft"]);

function fourccAt(u8: Uint8Array, off: number): string {
  return String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]);
}

function viewAt(u8: Uint8Array, off: number): DataView {
  return new DataView(u8.buffer, u8.byteOffset + off, u8.byteLength - off);
}

/**
 * True when the bytes look like an ISO base media file (fMP4/CMAF) rather than
 * an append-friendly container such as MPEG-TS or WebM. Only checked on the
 * first box; a capture that lost its init header (starts at `moof`) still
 * counts, because fragment-level repair is exactly what it needs.
 */
export function looksLikeIsoBmff(u8: Uint8Array): boolean {
  if (u8.byteLength < 8) return false;
  return ISO_BMFF_HEADS.has(fourccAt(u8, 4));
}

/**
 * Tolerant top-level box walk: stops at the first header that does not fit
 * (a partial append) instead of throwing, so a truncated stream is still
 * usable. `tailStart` is where the walk gave up.
 */
function walkBoxes(u8: Uint8Array): { boxes: IsoBox[]; tailStart: number } {
  const boxes: IsoBox[] = [];
  let off = 0;
  while (off + 8 <= u8.byteLength) {
    const view = viewAt(u8, off);
    let size = view.getUint32(0);
    const type = fourccAt(u8, off + 4);
    let header = 8;
    if (size === 1) {
      if (off + 16 > u8.byteLength) break;
      size = view.getUint32(8) * 0x100000000 + view.getUint32(12);
      header = 16;
    } else if (size === 0) {
      size = u8.byteLength - off; // "to end of file" — only legal as the last box
    }
    if (size < header || off + size > u8.byteLength) break;
    boxes.push({ type, start: off, size, header });
    off += size;
  }
  return { boxes, tailStart: off };
}

function boxBytes(u8: Uint8Array, b: IsoBox): Uint8Array {
  return u8.subarray(b.start, b.start + b.size);
}

function sameBoxBytes(u8: Uint8Array, a: IsoBox, b: IsoBox): boolean {
  if (a.size !== b.size) return false;
  const x = a.start;
  const y = b.start;
  for (let i = 0; i < a.size; i++) {
    if (u8[x + i] !== u8[y + i]) return false;
  }
  return true;
}

/** FNV-1a over a byte range — cheap pre-filter before an exact comparison. */
function hashRange(u8: Uint8Array, start: number, end: number): number {
  let h = 0x811c9dc5;
  for (let i = start; i < end; i++) {
    h ^= u8[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Decode-start time per track inside one fragment (`traf` > `tfdt`), keyed by
 * `tfhd` track_ID. Fragments without a `tfdt` are simply not checked.
 */
function fragmentDecodeTimes(u8: Uint8Array, start: number, end: number): Map<number, number> {
  const out = new Map<number, number>();
  const region = u8.subarray(start, end);
  for (const moof of walkBoxes(region).boxes) {
    if (moof.type !== "moof") continue;
    const moofView = region.subarray(moof.start + moof.header, moof.start + moof.size);
    for (const traf of walkBoxes(moofView).boxes) {
      if (traf.type !== "traf") continue;
      const trafView = moofView.subarray(traf.start + traf.header, traf.start + traf.size);
      let trackId = 0;
      let time: number | undefined;
      for (const kid of walkBoxes(trafView).boxes) {
        const data = trafView.subarray(kid.start + kid.header, kid.start + kid.size);
        if (kid.type === "tfhd" && data.byteLength >= 8) {
          trackId = viewAt(data, 4).getUint32(0);
        } else if (kid.type === "tfdt" && data.byteLength >= 8) {
          if (data[0] === 1 && data.byteLength >= 12) {
            time = viewAt(data, 4).getUint32(0) * 0x100000000 + viewAt(data, 8).getUint32(0);
          } else {
            time = viewAt(data, 4).getUint32(0);
          }
        }
      }
      if (trackId > 0 && time !== undefined) out.set(trackId, time);
    }
  }
  return out;
}

/** One unit of output: a standalone box, or a `moof`+payload fragment range. */
type Unit =
  | { kind: "box"; box: IsoBox }
  | { kind: "frag"; start: number; end: number };

/** Box types that always end the fragment in progress. */
const FRAGMENT_BREAKS = new Set(["moof", "ftyp", "styp", "moov", "sidx"]);

/** How many recent fragments are remembered for duplicate detection. */
const DUP_WINDOW = 64;

/**
 * Turn a captured append stream into the longest playable ISO-BMFF prefix.
 *
 * Anything that cannot be validated stays untouched (non-fMP4 containers), and
 * when nothing has to be dropped the original array is returned as-is.
 */
export function cleanCapturedStream(u8: Uint8Array): CaptureCleanup {
  const untouched: CaptureCleanup = {
    bytes: u8,
    droppedTailBytes: 0,
    droppedInitDuplicates: 0,
    droppedFragmentDuplicates: 0,
    droppedRewindFragments: 0,
    stoppedAtInitSwitch: false,
  };
  if (!looksLikeIsoBmff(u8)) return untouched;

  const { boxes, tailStart } = walkBoxes(u8);
  if (boxes.length === 0) return untouched;
  const droppedTailBytes = u8.byteLength - tailStart;

  // ---- init groups: each moov, plus the ftyp that introduces it ------------
  const moovs = boxes.filter((b) => b.type === "moov");
  interface Group {
    start: number;
    moov: IsoBox;
    ftyps: IsoBox[];
  }
  const groups: Group[] = [];
  let cursor = 0;
  for (const moov of moovs) {
    const ftyps = boxes.filter((b) => b.type === "ftyp" && b.start >= cursor && b.start < moov.start);
    groups.push({ start: ftyps.length ? ftyps[0].start : moov.start, moov, ftyps });
    cursor = moov.start + moov.size;
  }

  // ---- how far the usable stream goes -------------------------------------
  let keptEnd = tailStart;
  let stoppedAtInitSwitch = false;
  const droppedInitBoxes = new Set<number>(); // box.start values
  for (let i = 1; i < groups.length; i++) {
    const g = groups[i];
    if (sameBoxBytes(u8, groups[0].moov, g.moov)) {
      // The player re-appended the very same header (reset/replay): drop it and
      // keep following its fragments — they continue the same buffer.
      for (const f of g.ftyps) droppedInitBoxes.add(f.start);
      droppedInitBoxes.add(g.moov.start);
      continue;
    }
    // A *different* header means the codec/timescale/track layout changed (ABR
    // quality switch, ad break). The bytes after it cannot be joined to the
    // prefix without corrupting the file, so the stream ends here.
    keptEnd = g.start;
    stoppedAtInitSwitch = true;
    break;
  }

  // ---- group boxes into units -------------------------------------------
  const units: Unit[] = [];
  let openFrag: { start: number; end: number } | null = null;
  const closeFrag = (): void => {
    if (openFrag && openFrag.end > openFrag.start) units.push({ kind: "frag", ...openFrag });
    openFrag = null;
  };
  for (const b of boxes) {
    if (b.start >= keptEnd) break;
    if (droppedInitBoxes.has(b.start)) {
      closeFrag();
      continue;
    }
    if (b.type === "moof") {
      closeFrag();
      openFrag = { start: b.start, end: Math.min(b.start + b.size, keptEnd) };
      continue;
    }
    if (openFrag) {
      if (FRAGMENT_BREAKS.has(b.type)) {
        closeFrag();
        units.push({ kind: "box", box: b });
      } else {
        openFrag.end = Math.min(b.start + b.size, keptEnd);
      }
      continue;
    }
    units.push({ kind: "box", box: b });
  }
  closeFrag();

  // ---- drop duplicates and decode-time rewinds ---------------------------
  const seen = new Map<number, Array<{ start: number; end: number }>>();
  const seenOrder: Array<{ hash: number; start: number }> = [];
  const lastTime = new Map<number, number>();
  let droppedFragmentDuplicates = 0;
  let droppedRewindFragments = 0;
  let outBytes = 0;
  const kept: Unit[] = [];
  for (const unit of units) {
    if (unit.kind === "box") {
      kept.push(unit);
      outBytes += unit.box.size;
      continue;
    }
    const { start, end } = unit;
    const len = end - start;
    if (len <= 0) continue;
    const hash = hashRange(u8, start, end);
    const bucket = seen.get(hash);
    const dup =
      bucket?.some((r) => {
        if (r.end - r.start !== len) return false;
        for (let i = 0; i < len; i++) if (u8[start + i] !== u8[r.start + i]) return false;
        return true;
      }) ?? false;
    if (dup) {
      droppedFragmentDuplicates += len;
      continue;
    }
    const times = fragmentDecodeTimes(u8, start, end);
    let rewound = false;
    times.forEach((t, id) => {
      const prev = lastTime.get(id);
      if (prev !== undefined && t < prev) rewound = true;
    });
    if (rewound) {
      droppedRewindFragments += len;
      continue;
    }
    times.forEach((t, id) => lastTime.set(id, t));
    if (bucket) bucket.push({ start, end });
    else seen.set(hash, [{ start, end }]);
    seenOrder.push({ hash, start });
    while (seenOrder.length > DUP_WINDOW) {
      const old = seenOrder.shift();
      if (!old) break;
      const list = seen.get(old.hash);
      const idx = list?.findIndex((r) => r.start === old.start) ?? -1;
      if (list && idx >= 0) list.splice(idx, 1);
      if (list && list.length === 0) seen.delete(old.hash);
    }
    kept.push(unit);
    outBytes += len;
  }

  const changed =
    kept.length !== units.length ||
    droppedTailBytes > 0 ||
    droppedInitBoxes.size > 0 ||
    stoppedAtInitSwitch ||
    outBytes !== u8.byteLength;
  if (!changed) return untouched;

  const out = new Uint8Array(outBytes);
  let off = 0;
  for (const unit of kept) {
    const part = unit.kind === "box" ? boxBytes(u8, unit.box) : u8.subarray(unit.start, unit.end);
    out.set(part, off);
    off += part.byteLength;
  }
  return {
    bytes: out,
    droppedTailBytes,
    droppedInitDuplicates: droppedInitBoxes.size,
    droppedFragmentDuplicates,
    droppedRewindFragments,
    stoppedAtInitSwitch,
  };
}

/**
 * Number of `trak` boxes in the stream's first `moov`. More than one means the
 * player muxes video+audio into a single SourceBuffer, so the bytes are already
 * a complete file and must NOT be muxed with a separate audio track.
 */
export function countInitTraks(u8: Uint8Array): number {
  const { boxes } = walkBoxes(u8);
  const moov = boxes.find((b) => b.type === "moov");
  if (!moov) return 0;
  const inner = u8.subarray(moov.start + moov.header, moov.start + moov.size);
  return walkBoxes(inner).boxes.filter((b) => b.type === "trak").length;
}

/** Human sentence for anything the repair dropped, or undefined when clean. */
export function describeCaptureCleanup(c: CaptureCleanup): string | undefined {
  const bits: string[] = [];
  if (c.stoppedAtInitSwitch) {
    bits.push("the player switched video quality mid-stream, so the file ends where the new quality began");
  }
  if (c.droppedRewindFragments > 0) {
    bits.push("fragments the player replayed after seeking back were removed");
  }
  if (c.droppedFragmentDuplicates > 0) {
    bits.push("already-buffered fragments the player appended twice were removed");
  }
  if (c.droppedInitDuplicates > 0) {
    bits.push("the repeated header the player re-appended was removed");
  }
  if (c.droppedTailBytes > 0) {
    bits.push("an unfinished fragment at the end was trimmed");
  }
  return bits.length ? `Repaired the captured buffer: ${bits.join("; ")}.` : undefined;
}
