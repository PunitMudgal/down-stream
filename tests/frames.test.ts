import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addressableFrame, sendToAcceptingFrame, sendToFrame } from "../src/bg/frames";

const sendMessage = vi.fn();
const getAllFrames = vi.fn();

beforeEach(() => {
  sendMessage.mockReset();
  getAllFrames.mockReset();
  getAllFrames.mockResolvedValue([{ frameId: 0 }, { frameId: 4 }, { frameId: 6 }]);
  vi.stubGlobal("chrome", { tabs: { sendMessage }, webNavigation: { getAllFrames } });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("addressableFrame", () => {
  it("treats the top frame (0) as addressable", () => {
    expect(addressableFrame(0)).toBe(0);
    expect(addressableFrame(7)).toBe(7);
  });

  it("treats absent and sentinel ids as 'any frame'", () => {
    expect(addressableFrame(undefined)).toBeUndefined();
    expect(addressableFrame(-1)).toBeUndefined();
  });
});

describe("sendToFrame", () => {
  it("addresses the owning frame when it is known", async () => {
    sendMessage.mockResolvedValueOnce({ ok: true, frame: 4 });
    const msg = { type: "FETCH_TEXT", url: "https://cdn/x.m3u8" };
    await expect(sendToFrame(9, 4, msg)).resolves.toEqual({ ok: true, frame: 4 });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(9, msg, { frameId: 4 });
  });

  it("falls back to the whole tab when that frame is gone", async () => {
    // A stored frame id outlives navigations — the tab-wide send must still land.
    sendMessage
      .mockRejectedValueOnce(new Error("No frame with id 4"))
      .mockResolvedValueOnce({ ok: true, via: "tab" });
    const msg = { type: "PAGE_FETCH_BYTES", transferId: "t1" };
    await expect(sendToFrame(9, 4, msg)).resolves.toEqual({ ok: true, via: "tab" });
    expect(sendMessage).toHaveBeenNthCalledWith(1, 9, msg, { frameId: 4 });
    expect(sendMessage).toHaveBeenNthCalledWith(2, 9, msg);
  });

  it("asks the whole tab when no frame is known", async () => {
    sendMessage.mockResolvedValueOnce({ ok: true });
    await sendToFrame(3, undefined, { type: "COLLECT_NOW" });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(3, { type: "COLLECT_NOW" });
  });

  it("does not retry the top frame through the sentinel", async () => {
    sendMessage.mockResolvedValueOnce({ ok: true });
    await sendToFrame(3, -1, { type: "MS_CANCEL", jobId: "j" });
    expect(sendMessage).toHaveBeenCalledWith(3, { type: "MS_CANCEL", jobId: "j" });
  });

  it("propagates the failure when even the whole tab has no listener", async () => {
    sendMessage.mockRejectedValue(new Error("Could not establish connection"));
    await expect(sendToFrame(3, 2, { type: "FETCH_TEXT" })).rejects.toThrow(
      /Could not establish connection/,
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe("sendToAcceptingFrame", () => {
  const msg = { type: "MS_DOWNLOAD", jobId: "j1" };

  it("walks past frames that decline and stops at the one that owns it", async () => {
    sendMessage.mockImplementation((_tab: number, _msg: unknown, opts?: { frameId?: number }) => {
      if (opts?.frameId === 4) {
        return Promise.resolve({ ok: false, declined: true, error: "Capture expired" });
      }
      if (opts?.frameId === 0) return Promise.resolve({ ok: true, accepted: true });
      return Promise.reject(new Error("no listener"));
    });
    await expect(sendToAcceptingFrame(9, 4, msg)).resolves.toEqual({
      accepted: true,
      response: { ok: true, accepted: true },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(1, 9, msg, { frameId: 4 });
    expect(sendMessage).toHaveBeenNthCalledWith(2, 9, msg, { frameId: 0 });
  });

  it("reports the decline when no frame in the tab holds the bytes", async () => {
    sendMessage.mockResolvedValue({ ok: false, declined: true, error: "Capture expired" });
    await expect(sendToAcceptingFrame(9, 4, msg)).resolves.toEqual({
      accepted: false,
      error: "Capture expired",
    });
    // preferred frame, the tab's other frames, then the untargeted fallback
    expect(sendMessage.mock.calls.map((c) => c[2])).toEqual([
      { frameId: 4 },
      { frameId: 0 },
      { frameId: 6 },
      undefined,
    ]);
  });

  it("bounds the frame walk but still falls back to the whole tab", async () => {
    sendMessage.mockResolvedValue({ ok: false, declined: true });
    const res = await sendToAcceptingFrame(9, 4, msg, 1);
    expect(res.accepted).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(2); // one targeted try + fallback
    expect(sendMessage).toHaveBeenLastCalledWith(9, msg);
  });

  it("accepts a plain success without a decline flag", async () => {
    sendMessage.mockResolvedValue({ ok: true, accepted: true });
    const res = await sendToAcceptingFrame(9, 6, msg);
    expect(res.accepted).toBe(true);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(9, msg, { frameId: 6 });
  });

  it("carries the machine-readable decline reason through the walk", async () => {
    sendMessage.mockResolvedValue({
      ok: false,
      declined: true,
      error: "The player's buffer is still empty.",
      reason: "empty",
    });
    const res = await sendToAcceptingFrame(9, undefined, { type: "BLOB_DOWNLOAD", jobId: "b1" });
    expect(res).toEqual({ accepted: false, error: "The player's buffer is still empty.", reason: "empty" });
  });

  it("omits the reason when declining frames give none", async () => {
    sendMessage.mockResolvedValue({ ok: false, declined: true, error: "nope" });
    const res = await sendToAcceptingFrame(9, undefined, msg);
    expect(res).toEqual({ accepted: false, error: "nope" });
    expect("reason" in res).toBe(false);
  });
});
