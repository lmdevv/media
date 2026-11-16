import { describe, expect, it } from "vitest";

import { castLoadPlan, castTrackIds } from "./cast-profile";
import type { CastItem } from "./cast-profile";

/** A receiver credential's shape: `r1.` and 43 base64url characters. */
const CREDENTIAL = `r1.${"c".repeat(43)}`;

const episode: CastItem = {
  title: "Slack Tide",
  episode: { seriesTitle: "Tide Tables", season: 1, episode: 2 },
  imageUrl: "http://nas.lan:8080/artwork/a1.still?w=500",
};

const subtitles = [
  {
    id: "x0",
    source: "sidecar" as const,
    codec: "subrip",
    kind: "text" as const,
    language: "eng",
    forced: false,
    default: false,
    hearingImpaired: false,
    url: "http://nas.lan:8080/media/subtitles/f1/x0.vtt?ticket=t1.k1.ticket",
  },
  {
    id: "e4",
    source: "embedded" as const,
    codec: "hdmv_pgs_subtitle",
    kind: "bitmap" as const,
    language: "fre",
    forced: false,
    default: false,
    hearingImpaired: false,
  },
  {
    id: "e5",
    source: "embedded" as const,
    codec: "ass",
    kind: "text" as const,
    forced: true,
    default: false,
    hearingImpaired: false,
    url: "http://nas.lan:8080/media/subtitles/f1/e5.vtt?ticket=t1.k1.ticket",
  },
];

describe("castLoadPlan", () => {
  it("sends an HLS stream as fMP4 with its WebVTT tracks, the item, the position, and the credential in the ticket's place", () => {
    const plan = castLoadPlan(
      {
        mode: "remux",
        url: "http://nas.lan:8080/media/hls/abc/0/index.m3u8?ticket=t1.k1.ticket",
        durationSeconds: 1_800,
        subtitles,
      },
      episode,
      "e5",
      612.4,
      CREDENTIAL,
    );

    expect(plan).toStrictEqual({
      contentUrl: `http://nas.lan:8080/media/hls/abc/0/index.m3u8?ticket=${CREDENTIAL}`,
      contentType: "application/x-mpegurl",
      hls: true,
      durationSeconds: 1_800,
      startSeconds: 612.4,
      item: episode,
      tracks: [
        {
          trackId: 1,
          subtitleId: "x0",
          url: `http://nas.lan:8080/media/subtitles/f1/x0.vtt?ticket=${CREDENTIAL}`,
          name: "English",
          language: "eng",
        },
        {
          trackId: 3,
          subtitleId: "e5",
          url: `http://nas.lan:8080/media/subtitles/f1/e5.vtt?ticket=${CREDENTIAL}`,
          name: "Subtitles 3 (Forced)",
          language: "und",
        },
      ],
      activeTrackIds: [3],
    });
    expect(castTrackIds(plan.tracks, null)).toStrictEqual([]);
    expect(castTrackIds(plan.tracks, "e4")).toStrictEqual([]);
  });

  it("sends a direct file as MP4 and never starts before zero", () => {
    const plan = castLoadPlan(
      {
        mode: "direct",
        url: "http://nas.lan:8080/media/direct/f1?ticket=t1.k1.ticket",
        durationSeconds: 90,
        subtitles: [],
      },
      { title: "Harbour Lights", episode: null, imageUrl: null },
      null,
      -3,
      CREDENTIAL,
    );

    expect(plan).toMatchObject({
      contentUrl: `http://nas.lan:8080/media/direct/f1?ticket=${CREDENTIAL}`,
      contentType: "video/mp4",
      hls: false,
      startSeconds: 0,
      tracks: [],
    });
  });
});
