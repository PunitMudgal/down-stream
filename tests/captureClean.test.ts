import { describe, expect, it } from "vitest";
import {
  cleanCapturedStream,
  countInitTraks,
  describeCaptureCleanup,
  looksLikeIsoBmff,
} from "../src/lib/captureClean";
import { muxFmp4 } from "../src/lib/mp4mux";
import {
  audioStream,
  buildFragment,
  buildInit,
  concat,
  initOnlyStream,
  multiVideoTrakStream,
  muxedFragmentedStream,
  u8,
  videoStream,
} from "./helpers/fmp4";

/** A video init/stream pair whose bytes are identical every time it is built. */
function videoInit(codec = "avc1", timescale = 12800): Uint8Array {
  return buildInit({ trackId: 1, handler: "vide", codec4cc: codec, timescale, width: 64, height: 64 });
}

function frag(trackId: number, baseTime: number, sequence: number, size = 100): Uint8Array {
  return buildFragment({ trackId, baseTime, sequence, samples: [{ dur: 2560, size }] });
}

describe("looksLikeIsoBmff", () => {
  it("accepts fMP4 streams", () => {
    expect(looksLikeIsoBmff(videoStream(1))).toBe(true);
  });

  it("accepts a fragment-only capture (init header lost)", () => {
    expect(looksLikeIsoBmff(frag(1, 0, 1))).toBe(true);
  });

  it("rejects containers that are already concatenation-safe", () => {
    expect(looksLikeIsoBmff(u8(0x47, 0x40, 0x11, 0x10, 0, 0, 0, 0))).toBe(false); // MPEG-TS
    expect(looksLikeIsoBmff(u8(0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0))).toBe(false); // WebM/EBML
    expect(looksLikeIsoBmff(u8(1, 2, 3))).toBe(false);
  });
});

describe("cleanCapturedStream — untouched input", () => {
  it("returns the very same bytes for a clean capture", () => {
    const clean = videoStream(1);
    const out = cleanCapturedStream(clean);
    expect(out.bytes).toBe(clean);
    expect(describeCaptureCleanup(out)).toBeUndefined();
  });

  it("passes non-ISO containers through untouched", () => {
    const ts = u8(0x47, 0x40, 0x11, 0x10, 0x47, 0x40, 0x11, 0x10, 0x47, 0x40, 0x11, 0x10);
    const out = cleanCapturedStream(ts);
    expect(out.bytes).toBe(ts);
    expect(out.droppedTailBytes).toBe(0);
  });
});

describe("cleanCapturedStream — repair", () => {
  it("trims an unfinished fragment at the end (the player was still loading it)", () => {
    const init = videoInit();
    const stream = concat([init, frag(1, 0, 1), frag(1, 2560, 2)]);
    const partial = concat([stream, u8(0, 0, 1, 0x2a, 0, 0, 0)]);
    const out = cleanCapturedStream(partial);
    expect(out.droppedTailBytes).toBe(7);
    expect(Array.from(out.bytes)).toEqual(Array.from(stream));
    // The repaired stream is exactly what the muxer accepts.
    const merged = muxFmp4(out.bytes, audioStream(2));
    expect(merged[4]).toBe("f".charCodeAt(0));
    expect(merged[5]).toBe("t".charCodeAt(0));
  });

  it("drops an identical init header the player re-appended (reset / replay)", () => {
    const init = videoInit();
    const grown = concat([init, frag(1, 0, 1), frag(1, 2560, 2), init, frag(1, 5120, 3), frag(1, 7680, 4)]);
    const out = cleanCapturedStream(grown);
    expect(out.droppedInitDuplicates).toBe(2); // ftyp + moov
    expect(out.droppedFragmentDuplicates).toBe(0);
    expect(describeCaptureCleanup(out)).toMatch(/repeated header/i);
    expect(() => muxFmp4(out.bytes, audioStream(2))).not.toThrow();
  });

  it("stops at a second, different init header instead of writing a corrupt file (quality switch)", () => {
    const first = videoInit();
    const second = videoInit("hev1");
    const keep = concat([first, frag(1, 0, 1), frag(1, 2560, 2)]);
    const stream = concat([keep, second, frag(1, 5120, 3)]);
    const out = cleanCapturedStream(stream);
    expect(out.stoppedAtInitSwitch).toBe(true);
    expect(Array.from(out.bytes)).toEqual(Array.from(keep));
    expect(describeCaptureCleanup(out)).toMatch(/switched video quality/i);
    expect(() => muxFmp4(out.bytes, audioStream(2))).not.toThrow();
  });

  it("drops fragments the player appended twice after a buffer eviction", () => {
    const init = videoInit();
    const f1 = frag(1, 0, 1);
    const dup = frag(1, 0, 1); // identical bytes, appended again
    const grown = concat([init, f1, dup, frag(1, 2560, 2)]);
    const out = cleanCapturedStream(grown);
    expect(out.droppedFragmentDuplicates).toBe(f1.byteLength);
    expect(Array.from(out.bytes)).toEqual(Array.from(concat([init, f1, frag(1, 2560, 2)])));
  });

  it("drops a fragment whose decode time goes backwards (seek back)", () => {
    const init = videoInit();
    const replayed = frag(1, 0, 7, 120); // same time as f1 but different bytes
    const grown = concat([init, frag(1, 0, 1), frag(1, 5120, 2), replayed]);
    const out = cleanCapturedStream(grown);
    expect(out.droppedRewindFragments).toBe(replayed.byteLength);
    expect(describeCaptureCleanup(out)).toMatch(/seeking back/i);
    expect(() => muxFmp4(out.bytes, audioStream(2))).not.toThrow();
  });

  it("keeps an init-only capture intact (nothing complete was appended yet)", () => {
    const only = initOnlyStream(1);
    const out = cleanCapturedStream(only);
    expect(out.bytes).toBe(only);
    expect(describeCaptureCleanup(out)).toBeUndefined();
  });
});

describe("countInitTraks", () => {
  it("counts the trak boxes of the first moov", () => {
    expect(countInitTraks(videoStream(1))).toBe(1);
    expect(countInitTraks(audioStream(2))).toBe(1);
    expect(countInitTraks(muxedFragmentedStream())).toBe(2);
    expect(countInitTraks(multiVideoTrakStream())).toBe(2);
    expect(countInitTraks(frag(1, 0, 1))).toBe(0); // no init header
  });

  it("sees the tracks a repaired quality-switch capture still carries", () => {
    const stream = concat([videoInit(), frag(1, 0, 1), videoInit("hev1"), frag(1, 5120, 2)]);
    expect(countInitTraks(cleanCapturedStream(stream).bytes)).toBe(1);
  });
});
