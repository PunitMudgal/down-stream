import { describe, expect, it } from "vitest";
import { extractMediaFileUrls, hasMediaBodyHint } from "../src/lib/apiUrls";

const IG_MP4 =
  "https://scontent-sjc6-1.cdninstagram.com/o1/v/t2/f2/m367/AQPhsUiY0kyEJd9KDmE.mp4?_nc_cat=100&oe=69EFEA01";
const IG_NO_EXT =
  "https://scontent-lga3-1.cdninstagram.com/o1/v/t16/f2/m86/AQNcliphash?_nc_cat=111&oe=69EFEA01";
const IG_JPG =
  "https://scontent.cdninstagram.com/v/t51.2885-15/12345678_n.jpg?_nc_cat=1";

describe("hasMediaBodyHint", () => {
  it("recognizes playlists the existing hook already peeked", () => {
    expect(hasMediaBodyHint('{"playbackUrl":"https://cdn.example.com/a.m3u8"}')).toBe(true);
    expect(hasMediaBodyHint("https://cdn.example.com/v.mpd?token=1")).toBe(true);
  });

  it("recognizes Instagram-style GraphQL that never contains a .m3u8/.mpd URL", () => {
    expect(hasMediaBodyHint('{"video_versions":[{"url":"https://cdn/x"}]}')).toBe(true);
    expect(hasMediaBodyHint('{"video_dash_manifest":"<?xml version=\\"1.0\\"?><MPD>"}')).toBe(true);
    expect(hasMediaBodyHint('<MPD type="static">')).toBe(true);
  });

  it("does not treat ordinary JSON as media-bearing", () => {
    expect(hasMediaBodyHint('{"ok":true,"items":[]}')).toBe(false);
    expect(hasMediaBodyHint("")).toBe(false);
  });
});

describe("extractMediaFileUrls", () => {
  it("pulls progressive files out of escaped JSON (Pinterest-style)", () => {
    const body = '{"videoUrl":"https:\\/\\/cdn.example.com\\/clip.mp4?token=1"}';
    expect(extractMediaFileUrls(body)).toEqual(["https://cdn.example.com/clip.mp4?token=1"]);
  });

  it("pulls Instagram video_versions progressive files even when no playlist is present", () => {
    const body = JSON.stringify({
      data: { xdt_shortcode_media: { video_versions: [{ url: IG_MP4 }] } },
    });
    expect(extractMediaFileUrls(body)).toEqual([IG_MP4]);
  });

  it("pulls Instagram CDN video URLs that have no file extension", () => {
    const body = `{"video_versions":[{"url":"${IG_NO_EXT}"}]}`;
    expect(extractMediaFileUrls(body)).toEqual([IG_NO_EXT]);
  });

  it("pulls BaseURL files out of an inline DASH MPD", () => {
    const body = `{"video_dash_manifest":"<?xml version=\\"1.0\\"?><MPD><BaseURL>${IG_MP4}</BaseURL></MPD>"}`;
    expect(extractMediaFileUrls(body)).toEqual([IG_MP4]);
  });

  it("never treats Instagram still images as videos", () => {
    expect(extractMediaFileUrls(`{"url":"${IG_JPG}"}`)).toEqual([]);
  });

  it("skips raw stream fragments", () => {
    expect(extractMediaFileUrls("https://cdn.example.com/seg-1.m4s")).toEqual([]);
    expect(extractMediaFileUrls("https://cdn.example.com/init.m4v")).toEqual([]);
  });
});
