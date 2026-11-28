import { NodeServices } from "@effect/platform-node";
import { assert, describe, it, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path } from "effect";

import { ffmpegAvailable } from "../testing/fixture-library.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import { parseFfprobeJson, probeFile } from "./media-probe.ts";
import * as MediaTools from "./media-tools.ts";

const hasFfmpeg = await ffmpegAvailable();

interface StreamJson {
  readonly index: number;
  readonly codec_type: string;
  readonly codec_name: string;
  readonly profile?: string;
  readonly level?: number;
  readonly pix_fmt?: string;
  readonly width?: number;
  readonly height?: number;
  readonly avg_frame_rate?: string;
  readonly r_frame_rate?: string;
  readonly color_transfer?: string;
  readonly field_order?: string;
  readonly side_data_list?: ReadonlyArray<{ readonly side_data_type: string }>;
  readonly channels?: number;
  readonly channel_layout?: string;
  readonly sample_rate?: string;
  readonly disposition?: {
    readonly default?: number;
    readonly forced?: number;
    readonly hearing_impaired?: number;
    readonly attached_pic?: number;
  };
  readonly tags?: {
    readonly language?: string;
    readonly title?: string;
    readonly DURATION?: string;
  };
  readonly start_time?: string;
  readonly duration?: string;
}

const ffprobe = (streams: ReadonlyArray<StreamJson>, formatName = "matroska,webm") =>
  JSON.stringify({
    format: {
      format_name: formatName,
      duration: "5400.25",
      start_time: "0.000000",
      bit_rate: "8000000",
    },
    streams,
  });

/** The frame rate read for a 640x360 H.264 stream whose rates ffprobe reports as `rates`. */
const frameRateOf = (rates: Pick<StreamJson, "avg_frame_rate" | "r_frame_rate">) =>
  parseFfprobeJson(
    ffprobe(
      [{ index: 0, codec_type: "video", codec_name: "h264", width: 640, height: 360, ...rates }],
      "mov,mp4,m4a,3gp,3g2,mj2",
    ),
    "/library/Clip (2024)/Clip (2024).mp4",
  ).pipe(Effect.map((probe) => probe.video?.frameRate));

/** The field order read for a 720x576 MPEG-2 stream whose field order ffprobe reports as `order`. */
const SD_MPEG2: StreamJson = {
  index: 0,
  codec_type: "video",
  codec_name: "mpeg2video",
  width: 720,
  height: 576,
};

const fieldOrderOf = (order: string | undefined) =>
  parseFfprobeJson(
    ffprobe([order === undefined ? SD_MPEG2 : { ...SD_MPEG2, field_order: order }]),
    "/library/Clip (2004)/Clip (2004).mkv",
  ).pipe(Effect.map((probe) => probe.video?.fieldOrder));

describe("parseFfprobeJson", () => {
  it.effect(
    "reads the field order a stream says, the field coded first as the one shown first",
    () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* fieldOrderOf("progressive"), "progressive");
        assert.strictEqual(yield* fieldOrderOf("tt"), "tff");
        // ffmpeg's encoders mark top-field-first pictures `tb`, and Matroska keeps it.
        assert.strictEqual(yield* fieldOrderOf("tb"), "tff");
        assert.strictEqual(yield* fieldOrderOf("bb"), "bff");
        assert.strictEqual(yield* fieldOrderOf("bt"), "bff");
        assert.strictEqual(yield* fieldOrderOf("unknown"), "unknown");
        assert.strictEqual(yield* fieldOrderOf(undefined), "unknown");
      }),
  );

  it.effect("reads the most frames a second the stream reports", () =>
    Effect.gen(function* () {
      // 4 s at 60 fps then 12 s at 15 fps, as ffprobe reads it.
      assert.strictEqual(yield* frameRateOf({ avg_frame_rate: "105/4", r_frame_rate: "60/1" }), 60);
      assert.approximately(
        (yield* frameRateOf({ avg_frame_rate: "30000/1001", r_frame_rate: "30000/1001" })) ?? 0,
        29.97,
        0.001,
      );
      // A millisecond timestamp clock read as a base rate leaves the average.
      assert.approximately(
        (yield* frameRateOf({ avg_frame_rate: "30000/1001", r_frame_rate: "1000/1" })) ?? 0,
        29.97,
        0.001,
      );
      // Jittered timestamps on a fast stream: the base rate is their clock, far above any picture rate.
      assert.approximately(
        (yield* frameRateOf({ avg_frame_rate: "80000/687", r_frame_rate: "2000/1" })) ?? 0,
        116.45,
        0.01,
      );
      // A slow-motion recording keeps its picture rate.
      assert.strictEqual(
        yield* frameRateOf({ avg_frame_rate: "120/1", r_frame_rate: "240/1" }),
        240,
      );
      assert.strictEqual(yield* frameRateOf({ r_frame_rate: "25/1" }), 25);
      assert.strictEqual(yield* frameRateOf({}), undefined);
    }),
  );

  it.effect("reads Dolby Vision, bitmap subtitles, and skips cover art", () =>
    Effect.gen(function* () {
      const probe = yield* parseFfprobeJson(
        ffprobe([
          {
            index: 0,
            codec_type: "video",
            codec_name: "mjpeg",
            width: 600,
            height: 900,
            disposition: { attached_pic: 1 },
          },
          {
            index: 1,
            codec_type: "video",
            codec_name: "hevc",
            profile: "Main 10",
            level: 153,
            pix_fmt: "yuv420p10le",
            width: 3840,
            height: 2160,
            avg_frame_rate: "24000/1001",
            color_transfer: "smpte2084",
            side_data_list: [{ side_data_type: "DOVI configuration record" }],
          },
          {
            index: 2,
            codec_type: "audio",
            codec_name: "truehd",
            channels: 8,
            channel_layout: "7.1",
            sample_rate: "48000",
            disposition: { default: 1 },
            tags: { language: "eng", title: "Atmos", DURATION: "01:29:59.750000000" },
            start_time: "0.500000",
          },
          {
            index: 3,
            codec_type: "subtitle",
            codec_name: "hdmv_pgs_subtitle",
            disposition: { forced: 1 },
            tags: { language: "eng" },
          },
          {
            index: 4,
            codec_type: "subtitle",
            codec_name: "ass",
            disposition: { hearing_impaired: 1 },
            tags: { language: "jpn" },
          },
        ]),
        "/library/Movie (2020)/Movie (2020).mkv",
      );

      assert.strictEqual(probe.container, "mkv");
      assert.strictEqual(probe.durationSeconds, 5400.25);
      assert.strictEqual(probe.bitRate, 8_000_000);
      assert.deepStrictEqual(
        [probe.video?.index, probe.video?.dynamicRange, probe.video?.bitDepth],
        [1, "dolby-vision", 10],
      );
      assert.approximately(probe.video?.frameRate ?? 0, 23.976, 0.001);
      assert.deepStrictEqual(probe.audio[0], {
        index: 2,
        codec: "truehd",
        profile: undefined,
        channels: 8,
        channelLayout: "7.1",
        sampleRate: 48_000,
        language: "eng",
        title: "Atmos",
        default: true,
        endSeconds: 5400.25,
      });
      assert.deepStrictEqual(
        probe.subtitles.map((track) => [
          track.codec,
          track.kind,
          track.forced,
          track.hearingImpaired,
        ]),
        [
          ["hdmv_pgs_subtitle", "bitmap", true, false],
          ["ass", "text", false, true],
        ],
      );
    }),
  );

  it.effect("reads where an audio track ends from its duration, or not at all", () =>
    Effect.gen(function* () {
      const probe = yield* parseFfprobeJson(
        ffprobe(
          [
            {
              index: 1,
              codec_type: "audio",
              codec_name: "ac3",
              start_time: "1.400000",
              duration: "6.016000",
            },
            { index: 2, codec_type: "audio", codec_name: "ac3", start_time: "1.400000" },
          ],
          "mpegts",
        ),
        "/media/recording.ts",
      );

      assert.approximately(probe.audio[0]?.endSeconds ?? 0, 7.416, 0.000_001);
      assert.isUndefined(probe.audio[1]?.endSeconds);
    }),
  );

  it.effect("tells MP4 from MOV and WebM from Matroska by extension, and HLG from PQ", () =>
    Effect.gen(function* () {
      const hlg = [
        {
          index: 0,
          codec_type: "video",
          codec_name: "hevc",
          width: 1920,
          height: 1080,
          color_transfer: "arib-std-b67",
        },
      ];

      const mov = yield* parseFfprobeJson(ffprobe(hlg, "mov,mp4,m4a,3gp,3g2,mj2"), "/a/clip.MOV");
      const webm = yield* parseFfprobeJson(ffprobe(hlg), "/a/clip.webm");

      assert.deepStrictEqual(
        [mov.container, webm.container, mov.video?.dynamicRange],
        ["mov", "webm", "hlg"],
      );
    }),
  );

  it.effect("reads chapters from the first frame, in order, without empty markers", () =>
    Effect.gen(function* () {
      const json = JSON.stringify({
        format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "300.0", start_time: "1.5" },
        streams: [],
        chapters: [
          { start_time: "61.5", end_time: "131.5", tags: { title: "The Wall" } },
          { start_time: "1.5", end_time: "61.5", tags: { title: "Opening" } },
          { start_time: "131.5", end_time: "301.5", tags: { title: " " } },
          { start_time: "301.5", end_time: "301.5", tags: { title: "Empty" } },
          { start_time: "nope", end_time: "1" },
        ],
      });

      const probe = yield* parseFfprobeJson(json, "/media/feature.mp4");

      assert.deepStrictEqual(probe.chapters, [
        { startSeconds: 0, endSeconds: 60, title: "Opening" },
        { startSeconds: 60, endSeconds: 130, title: "The Wall" },
        { startSeconds: 130, endSeconds: 300, title: undefined },
      ]);
    }),
  );

  it.effect("fails with a typed error on output that is not a probe", () =>
    Effect.gen(function* () {
      const error = yield* parseFfprobeJson("{}", "/a/b.mkv").pipe(Effect.flip);

      assert.strictEqual(
        error.message,
        "Media probe invalid: ffprobe output did not describe a media file",
      );
    }),
  );
});

describe.runIf(hasFfmpeg)("probeFile", () => {
  layer(
    MediaTools.layer.pipe(
      Layer.provide(testConfigLayer({})),
      Layer.provideMerge(NodeServices.layer),
    ),
  )((tools) => {
    tools.effect("reads the picture's first frame in a file whose first packets are audio", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const media = yield* MediaTools.Service;
        const file = path.join(yield* fs.makeTempDirectoryScoped(), "Audio First (2026).mkv");

        // The picture starts half a second in, so Matroska writes audio's packets first, and keeps
        // HEVC's mastering display and content light level only in the pictures' SEI messages.
        yield* media.ffmpeg([
          "-hide_banner",
          "-nostdin",
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=440:duration=2",
          "-itsoffset",
          "0.5",
          "-f",
          "lavfi",
          "-i",
          "testsrc2=size=320x180:rate=24:duration=1",
          "-map",
          "1:v",
          "-map",
          "0:a",
          "-c:v",
          "libx265",
          "-vf",
          "setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,format=yuv420p10le",
          "-x265-params",
          "log-level=error:hdr10=1:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400",
          "-c:a",
          "aac",
          file,
        ]);

        const { video } = yield* probeFile(file);

        assert.strictEqual(video?.dynamicRange, "hdr10");
        assert.deepStrictEqual(video?.colour?.mastering, {
          minLuminance: 0.005,
          maxLuminance: 1000,
          primaries: {
            red: { x: 0.68, y: 0.32 },
            green: { x: 0.265, y: 0.69 },
            blue: { x: 0.15, y: 0.06 },
            whitePoint: { x: 0.3127, y: 0.329 },
          },
        });
        assert.deepStrictEqual(video?.colour?.contentLight, { maxCll: 1000, maxFall: 400 });
      }).pipe(Effect.scoped),
    );
  });
});
