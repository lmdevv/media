import { NegotiateResponse, SeekResponse } from "@media/contracts/media-playback";
import { MediaFile } from "@media/contracts/models/catalog";
import { StartedPlayback } from "@media/contracts/models/playback";
import { Playback } from "@media/sdk/effect";
import { fixedValue } from "@media/ui/lib/live-value";
import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StreamInfo } from "./stream-info";

/** Twelve seconds of MPEG-2 at 2560x1440, wider than the CPU encodes. */
const file = {
  id: "file-1",
  titleId: "title-1",
  episodeId: null,
  versionName: null,
  sizeBytes: 1_000,
  probe: {
    container: "mkv",
    durationMs: 12_000,
    bitRate: null,
    video: [
      {
        index: 0,
        codec: "mpeg2video",
        profile: null,
        width: 2560,
        height: 1440,
        frameRate: 24,
        bitDepth: 8,
        pixelFormat: "yuv420p",
        hdr: "none",
        bitRate: null,
      },
    ],
    audio: [],
    subtitles: [],
    chapters: [],
  },
  externalSubtitles: [],
  hdr: false,
  missing: false,
  trickplay: null,
};

/** The file transcoded at full size on Quick Sync, as negotiated. */
const onGpu = Schema.decodeSync(NegotiateResponse)({
  mode: "transcode-qsv",
  url: "http://media.test/media/hls/stream-0123456789abcde/1/index.m3u8?ticket=t",
  streamId: "stream-0123456789abcde",
  generation: 1,
  startSeconds: 0,
  durationSeconds: 12,
  video: { codec: "h264", width: 2560, height: 1440, dynamicRange: "sdr" },
  transcode: {
    stages: [
      { op: "decode", domain: "qsv", impl: "decode.qsv" },
      { op: "encode", domain: "qsv", impl: "encode.qsv" },
    ],
    changes: [],
  },
  subtitles: [],
  expiresAt: 1_800_000_000_000,
});

/** The replacement after the Quick Sync run failed: the CPU, which encodes 1080p at most. */
const replaced = Schema.decodeSync(SeekResponse)({
  streamId: "stream-0123456789abcde",
  generation: 2,
  playlistUrl: "http://media.test/media/hls/stream-0123456789abcde/2/index.m3u8?ticket=t",
  mode: "transcode-software",
  video: { codec: "h264", width: 1920, height: 1080, dynamicRange: "sdr" },
  transcode: {
    stages: [
      { op: "decode", domain: "cpu", impl: "decode.cpu" },
      { op: "scale", domain: "cpu", impl: "scale.cpu" },
      { op: "encode", domain: "cpu", impl: "encode.cpu" },
    ],
    changes: [
      {
        at: 1_790_000_000_000,
        generation: 2,
        cause: "source",
        excluded: ["decode.qsv", "encode.qsv"],
        reason: "file-only",
      },
    ],
  },
});

const started = Schema.decodeUnknownSync(StartedPlayback)({
  sessionId: "session-1",
  titleId: "title-1",
  episodeId: null,
  episode: null,
  file,
  token: "t",
  tokenExpiresAt: 1_800_000_000_000,
  mediaBaseUrl: "http://media.test",
  resumePositionMs: 0,
});

/** What the panel reads for `stream`, its lines one after another. */
const panelText = (stream: NegotiateResponse): ReadonlyArray<string> =>
  renderToStaticMarkup(
    <StreamInfo
      file={Schema.decodeUnknownSync(MediaFile)(file)}
      stream={stream}
      bufferedAhead={fixedValue(12)}
      onClose={() => undefined}
    />,
  )
    .replaceAll(/<[^>]+>/gu, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

describe("StreamInfo", () => {
  it("shows the picture size and stages of the generation a replacement moved the player to", () => {
    const before = panelText(onGpu);
    const after = panelText(Playback.inGeneration({ started, stream: onGpu }, replaced).stream);

    expect(before).toContain("→ H.264 · 1440p · SDR");
    expect(before).toContain("Encode · QSV");
    expect(after).toContain("→ H.264 · 1080p · SDR");
    expect(after).not.toContain("→ H.264 · 1440p · SDR");
    expect(after).toEqual(expect.arrayContaining(["Decode · CPU", "Scale · CPU", "Encode · CPU"]));
    expect(after).not.toContain("Encode · QSV");
    expect(after.some((line) => line.endsWith(" · this file only · decode.qsv +1"))).toBe(true);
  });

  it("names a change whose reason a newer server added as a failure, and shows the rest", () => {
    const newer = Schema.decodeSync(NegotiateResponse)({
      ...Schema.encodeSync(NegotiateResponse)(onGpu),
      transcode: {
        stages: replaced.transcode.stages,
        changes: [
          {
            at: 1_790_000_000_000,
            generation: 2,
            cause: "source",
            excluded: ["decode.qsv", "encode.qsv"],
            reason: "driver-reset",
          },
        ],
      },
    });

    const lines = panelText(newer);

    expect(lines).toEqual(expect.arrayContaining(["Decode · CPU", "Scale · CPU", "Encode · CPU"]));
    expect(lines.some((line) => line.endsWith(" · failed · decode.qsv +1"))).toBe(true);
  });
});
