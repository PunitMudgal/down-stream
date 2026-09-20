import { describe, expect, it } from "vitest";
import {
  BLOB_EMPTY_HINT,
  BLOB_GONE_HINT,
  BLOB_MSE_HINT,
  blobDeadMessage,
  parseBlobRoute,
  pickCaptureTracks,
} from "../src/lib/blobResolve";

describe("parseBlobRoute", () => {
  it("reads a bytes route from the hook", () => {
    expect(
      parseBlobRoute({ __vdg: "blob-resolve-result", kind: "blob", size: 4096, type: "video/webm" }),
    ).toEqual({ kind: "blob", size: 4096, mime: "video/webm" });
  });

  it("defaults the MIME when the page gives none", () => {
    expect(parseBlobRoute({ __vdg: "blob-resolve-result", size: 10 })).toEqual({
      kind: "blob",
      size: 10,
      mime: "video/mp4",
    });
  });

  it("picks the video track and its audio sibling for a MediaSource buffer", () => {
    const route = parseBlobRoute({
      __vdg: "blob-resolve-result",
      kind: "mse",
      sessionId: "ms-3",
      tracks: [
        { idx: 0, kind: "video", bytes: 900 },
        { idx: 1, kind: "audio", bytes: 120 },
      ],
    });
    expect(route).toEqual({ kind: "mse", sessionId: "ms-3", videoTrackIdx: 0, audioTrackIdx: 1 });
  });

  it("treats an unknown/generic track as the video track", () => {
    const route = parseBlobRoute({
      __vdg: "blob-resolve-result",
      kind: "mse",
      sessionId: "ms-1",
      tracks: [{ idx: 2, kind: "other", bytes: 5 }],
    });
    expect(route).toEqual({ kind: "mse", sessionId: "ms-1", videoTrackIdx: 2 });
  });

  it("rejects a MediaSource reply without a session id", () => {
    expect(
      parseBlobRoute({ __vdg: "blob-resolve-result", kind: "mse", tracks: [] }),
    ).toBeUndefined();
  });

  it("maps hook error tokens to dead routes", () => {
    expect(parseBlobRoute({ __vdg: "blob-resolve-result", error: "not-fetchable" })).toEqual({
      kind: "dead",
      reason: "not-fetchable",
    });
    expect(parseBlobRoute({ __vdg: "blob-resolve-result", kind: "blob", size: 0 })).toEqual({
      kind: "dead",
      reason: "empty",
    });
  });

  it("ignores replies from anything other than the hook", () => {
    expect(parseBlobRoute(undefined)).toBeUndefined();
    expect(parseBlobRoute(null)).toBeUndefined();
    expect(parseBlobRoute({ size: 10 })).toBeUndefined();
    expect(parseBlobRoute("nope")).toBeUndefined();
  });
});

describe("pickCaptureTracks", () => {
  it("ignores an empty track and keeps the one carrying bytes", () => {
    expect(
      pickCaptureTracks([
        { idx: 0, kind: "video", bytes: 0 },
        { idx: 1, kind: "video", bytes: 2048 },
        { idx: 2, kind: "audio", bytes: 0 },
      ]),
    ).toEqual({ videoTrackIdx: 1 });
  });

  it("falls back to the first track when nothing has bytes yet", () => {
    expect(pickCaptureTracks([{ idx: 4, kind: "video", bytes: 0 }])).toEqual({ videoTrackIdx: 4 });
    expect(pickCaptureTracks([])).toEqual({ videoTrackIdx: 0 });
  });

  it("pairs exactly one audio track with the busiest video track", () => {
    expect(
      pickCaptureTracks([
        { idx: 0, kind: "audio", bytes: 100 },
        { idx: 1, kind: "video", bytes: 100 },
        { idx: 2, kind: "audio", bytes: 400 },
        { idx: 3, kind: "video", bytes: 900 },
      ]),
    ).toEqual({ videoTrackIdx: 3, audioTrackIdx: 2 });
  });
});

describe("blobDeadMessage", () => {
  it("explains a live MediaSource buffer", () => {
    expect(blobDeadMessage("not-fetchable")).toBe(BLOB_MSE_HINT);
    expect(blobDeadMessage("empty")).toBe(BLOB_EMPTY_HINT);
    expect(blobDeadMessage("not-held")).toBe(BLOB_GONE_HINT);
    expect(blobDeadMessage(undefined)).toBe(BLOB_GONE_HINT);
  });

  it("passes through a real message from the page", () => {
    expect(blobDeadMessage("Blob read failed.")).toBe("Blob read failed.");
  });
});
