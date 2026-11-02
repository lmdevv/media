import { NodeServices } from "@effect/platform-node";
import { assert, describe, layer } from "@effect/vitest";
import { Console, Context, Effect, FileSystem, Layer, Path, Schema } from "effect";

import { MediaFileId } from "@movies/contracts/ids";

import * as DiskCache from "../disk-cache.ts";
import { type MediaProbe, probeFile } from "../media/media-probe.ts";
import * as MediaTools from "../media/media-tools.ts";
import { ffmpegAvailable, qsvUsable, vaapiUsable } from "../testing/fixture-library.ts";
import { testConfigLayer } from "../testing/test-config.ts";
import { fragmentSpan, videoTiming } from "./fmp4-fragments.ts";
import {
  groupFragments,
  planGridSegments,
  planKeyframeSegments,
  type SegmentPlan,
} from "./hls-plan.ts";
import * as KeyframeIndex from "./keyframe-index.ts";
import { AudioPlan, VideoPlan } from "./playback-decision.ts";
import { hlsCommandArgs } from "./transcode-command.ts";

const hasFfmpeg = await ffmpegAvailable();

/**
 * Opts in to what depends on the machine: hardware encoders, properties the code does not meet
 * yet (whose measured values depend on the ffmpeg build), and the printed report.
 */
const optIn = process.env["MOVIES_TIMING"] === "1";

const runnable = {
  copy: hasFfmpeg,
  software: hasFfmpeg,
  qsv: optIn && hasFfmpeg && (await qsvUsable()),
  vaapi: optIn && hasFfmpeg && (await vaapiUsable()),
} as const;

const AAC_FRAME = 1024 / 48_000;

/**
 * How early a later run's audio may start: an AAC run opens with its priming frame and up to a
 * frame of silence that puts it on the grid; a copied AC-3 frame lasts 32 ms.
 */
/** As in `transcode-command.ts`: how far past a run's start copied audio must run on. */
const AUDIO_END_MARGIN = 0.5;

const AUDIO_START_LIMIT = 2 * AAC_FRAME + 0.001;

/** An encoder pads its last frame out to 1024 samples: up to 23.2 ms at 44.1 kHz. */
const LAST_FRAME = 1024 / 44_100;

const FRAMES = 24_000;

const PER_SECONDS = 1001;

const FRAME = PER_SECONDS / FRAMES;

/** Matroska stores times in whole milliseconds, so a 41.7 ms frame lasts 41 or 42 of them. */
const ROUNDING = 0.0015;

const RESUME_SEGMENTS = [1, 2] as const;

type Property =
  | "planned"
  | "audio start"
  | "video seam"
  | "audio seam"
  | "init"
  | "init audio"
  | "even"
  | "sync";

interface Source {
  readonly name: string;
  readonly audioArgs: ReadonlyArray<string>;
  readonly container: "mkv" | "mp4" | "ts";
  readonly seconds?: number;
  readonly keyframeFrames?: number;
}

interface Case {
  readonly name: string;
  readonly source: Source;
  readonly video: "copy" | "software" | "qsv" | "vaapi";
  readonly audio: "copy" | "aac";
  readonly expectedFailures: ReadonlyArray<Property>;
}

const SECONDS = 12;

const sine = (rate: number, seconds = SECONDS): ReadonlyArray<string> => [
  "-f",
  "lavfi",
  "-i",
  `sine=frequency=440:sample_rate=${String(rate)}:duration=${String(seconds)}`,
];

const TICKS_PER_MS = 48;

const JITTER_MS = 4;

const GAP_MS = 60;

const GAP_AT_FRAME = 188;

const EAC3: Source = {
  name: "eac3",
  audioArgs: [...sine(48_000), "-c:a", "eac3", "-ac", "6"],
  container: "mkv",
};

const DTS_JITTER: Source = {
  name: "dts-jitter",
  audioArgs: [
    ...sine(48_000),
    "-strict",
    "-2",
    "-c:a",
    "dca",
    "-ac",
    "6",
    "-bsf:a",
    `setts=ts=TS+trunc(${String(JITTER_MS)}*sin(N*1.7))*${String(TICKS_PER_MS)}`,
  ],
  container: "mkv",
};

const EAC3_GAP: Source = {
  name: "eac3-gap",
  audioArgs: [
    ...sine(48_000),
    "-c:a",
    "eac3",
    "-ac",
    "6",
    "-bsf:a",
    `setts=ts=TS+gte(N\\,${String(GAP_AT_FRAME)})*${String(GAP_MS * TICKS_PER_MS)}`,
  ],
  container: "mkv",
};

/** AAC in MP4 starts with a priming frame its edit list hides: a negative first timestamp. */
const AAC_MP4: Source = {
  name: "aac",
  audioArgs: [...sine(48_000), "-c:a", "aac"],
  container: "mp4",
};

const AAC_44: Source = {
  name: "aac-44k",
  audioArgs: [...sine(44_100), "-c:a", "aac"],
  container: "mkv",
};

/** MPEG-TS starts at 1.4 s and has no index, so a seek lands where it lands. */
const AC3_TS: Source = {
  name: "ac3",
  audioArgs: [...sine(48_000), "-c:a", "ac3", "-output_ts_offset", "1.4"],
  container: "ts",
};

/** AC-3 that ends 4.5 s before the video, so a run can start after the last audio packet. */
const AC3_SHORT: Source = {
  name: "ac3-short",
  audioArgs: [...sine(48_000, 7.5), "-c:a", "ac3"],
  container: "mkv",
};

/** MPEG-TS whose AC-3 ends before planned segment 2, which is not the last. */
const AC3_TS_SHORT: Source = {
  name: "ac3-ts-short",
  audioArgs: [...sine(48_000, 6), "-c:a", "ac3", "-output_ts_offset", "1.4"],
  container: "ts",
  seconds: 16,
};

const AC3_TS_LONG_GOP: Source = {
  name: "ac3-long-gop",
  audioArgs: [...sine(48_000, 30), "-c:a", "ac3", "-output_ts_offset", "1.4"],
  container: "ts",
  seconds: 30,
  keyframeFrames: 240,
};

const ENCODER_SEAM: ReadonlyArray<Property> = ["audio seam"];

const CASES: ReadonlyArray<Case> = [
  {
    name: "remux, AAC copied",
    source: AAC_MP4,
    video: "copy",
    audio: "copy",
    expectedFailures: [],
  },
  {
    name: "remux, AC-3 copied from MPEG-TS",
    source: AC3_TS,
    video: "copy",
    audio: "copy",
    expectedFailures: [],
  },
  { name: "remux, E-AC-3 to AAC", source: EAC3, video: "copy", audio: "aac", expectedFailures: [] },
  {
    name: "remux, jittered DTS to AAC",
    source: DTS_JITTER,
    video: "copy",
    audio: "aac",
    expectedFailures: [],
  },
  {
    name: "remux, E-AC-3 with a gap to AAC",
    source: EAC3_GAP,
    video: "copy",
    audio: "aac",
    expectedFailures: [],
  },
  {
    name: "remux, 44.1 kHz AAC to AAC",
    source: AAC_44,
    video: "copy",
    audio: "aac",
    expectedFailures: [],
  },
  {
    name: "remux, AC-3 from MPEG-TS to AAC",
    source: AC3_TS,
    video: "copy",
    audio: "aac",
    expectedFailures: [],
  },
  {
    name: "remux, AC-3 to AAC from MPEG-TS with keyframes 10 s apart",
    source: AC3_TS_LONG_GOP,
    video: "copy",
    audio: "aac",
    expectedFailures: [],
  },
  {
    name: "software, E-AC-3 to AAC",
    source: EAC3,
    video: "software",
    audio: "aac",
    expectedFailures: ENCODER_SEAM,
  },
  {
    name: "software, AAC copied",
    source: AAC_MP4,
    video: "software",
    audio: "copy",
    expectedFailures: ENCODER_SEAM,
  },
  {
    name: "software, AC-3 copied from MPEG-TS",
    source: AC3_TS,
    video: "software",
    audio: "copy",
    expectedFailures: ENCODER_SEAM,
  },
  {
    name: "software, AC-3 copied, ending 4.5 s before the video",
    source: AC3_SHORT,
    video: "software",
    audio: "copy",
    expectedFailures: ENCODER_SEAM,
  },
  {
    name: "software, AC-3 copied from MPEG-TS, ending two segments before the video",
    source: AC3_TS_SHORT,
    video: "software",
    audio: "copy",
    expectedFailures: ENCODER_SEAM,
  },
  {
    name: "Quick Sync, E-AC-3 to AAC",
    source: EAC3,
    video: "qsv",
    audio: "aac",
    expectedFailures: ENCODER_SEAM,
  },
  {
    name: "VA-API, E-AC-3 to AAC",
    source: EAC3,
    video: "vaapi",
    audio: "aac",
    expectedFailures: [],
  },
];

interface Span {
  readonly first: number;
  readonly end: number;
  readonly steps: ReadonlyArray<number>;
}

interface SegmentTiming {
  readonly index: number;
  readonly planned: number;
  readonly video: Span;
  readonly audio: Span;
}

interface Run {
  readonly from: number;
  readonly init: Uint8Array;
  /** Streams ffprobe finds in `init.mp4` alone. */
  readonly initStreams: number;
  readonly segments: ReadonlyArray<SegmentTiming>;
}

interface Ends {
  readonly video: { readonly end: number };
  readonly audio: { readonly end: number };
}

interface Measurement {
  readonly plan: SegmentPlan;
  readonly sourceEnds: Ends;
  readonly fromStart: Run;
  readonly resumed: ReadonlyArray<Run>;
}

class Measured extends Context.Service<Measured, Measurement>()(
  "@movies/media/test/HlsTiming/Measured",
) {}

class Workspace extends Context.Service<Workspace, { readonly root: string }>()(
  "@movies/media/test/HlsTiming/Workspace",
) {}

const workspaceLayer = Layer.effect(
  Workspace,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "movies-hls-timing-" });

    return { root };
  }).pipe(Effect.orDie),
);

const toolsLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { root } = yield* Workspace;
    const path = yield* Path.Path;

    const config = testConfigLayer({
      DATA_DIR: path.join(root, "data"),
      FFMPEG_PATH: process.env["FFMPEG_PATH"] ?? "ffmpeg",
      FFPROBE_PATH: process.env["FFPROBE_PATH"] ?? "ffprobe",
    });

    return KeyframeIndex.layer.pipe(
      Layer.provideMerge(DiskCache.layer),
      Layer.provideMerge(MediaTools.layer),
      Layer.provide(config),
    );
  }),
).pipe(Layer.provideMerge(workspaceLayer), Layer.provideMerge(NodeServices.layer));

class Sources extends Context.Service<
  Sources,
  { readonly file: (source: Source) => Effect.Effect<string> }
>()("@movies/media/test/HlsTiming/Sources") {}

const generateSource = Effect.fn("HlsTiming.generateSource")(function* (source: Source) {
  const { root } = yield* Workspace;
  const tools = yield* MediaTools.Service;
  const path = yield* Path.Path;
  const output = path.join(root, `${source.name}.${source.container}`);

  yield* tools.ffmpegInBackground([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc2=size=320x180:rate=${String(FRAMES)}/${String(PER_SECONDS)}:duration=${String(source.seconds ?? SECONDS)}`,
    ...source.audioArgs,
    "-map",
    "0:v",
    "-map",
    "1:a",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(source.keyframeFrames ?? 48),
    "-bf",
    "3",
    output,
  ]);

  return output;
});

const PacketList = Schema.fromJsonString(
  Schema.Struct({
    packets: Schema.Array(
      Schema.Struct({
        stream_index: Schema.Int,
        pts_time: Schema.FiniteFromString,
        /** ffprobe 6 leaves it out for a priming frame it trims. */
        duration_time: Schema.optional(Schema.FiniteFromString),
      }),
    ),
  }),
);

interface Packet {
  readonly pts: number;
  readonly duration: number | undefined;
}

const span = (packets: ReadonlyArray<Packet>): Span => {
  const sorted = packets.toSorted((left, right) => left.pts - right.pts);
  const steps = sorted.slice(1).map((packet, index) => packet.pts - (sorted[index]?.pts ?? 0));
  const last = sorted.at(-1);

  return {
    first: sorted[0]?.pts ?? Number.NaN,
    end: (last?.pts ?? Number.NaN) + (last?.duration ?? steps.at(-1) ?? Number.NaN),
    steps,
  };
};

const endGap = (ends: Ends): number => ends.audio.end - ends.video.end;

const latestEnd = (spans: ReadonlyArray<Span>): number =>
  Math.max(...spans.flatMap((each) => (Number.isNaN(each.end) ? [] : [each.end])));

const runEnds = (run: Run): Ends => ({
  video: { end: latestEnd(run.segments.map((segment) => segment.video)) },
  audio: { end: latestEnd(run.segments.map((segment) => segment.audio)) },
});

const probeSpans = Effect.fn("HlsTiming.probeSpans")(function* (file: string) {
  const tools = yield* MediaTools.Service;

  const output = yield* tools
    .ffprobe([
      "-v",
      "error",
      "-show_entries",
      "packet=stream_index,pts_time,duration_time",
      "-of",
      "json",
      file,
    ])
    .pipe(Effect.catchTag("MediaToolFailed", () => Effect.succeed('{"packets":[]}')));

  const { packets } = yield* Schema.decodeEffect(PacketList)(output);

  const of = (stream: number) =>
    packets
      .filter((packet) => packet.stream_index === stream)
      .map((packet) => ({ pts: packet.pts_time, duration: packet.duration_time }));

  return { video: span(of(0)), audio: span(of(1)) };
});

const probeSegment = Effect.fn("HlsTiming.probeSegment")(function* (
  init: Uint8Array,
  fragments: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* fs.makeTempFileScoped({ suffix: ".mp4" });
  const parts = yield* Effect.forEach(fragments, (fragment) => fs.readFile(fragment));
  yield* fs.writeFile(file, Buffer.concat([init, ...parts]));

  return yield* probeSpans(file);
}, Effect.scoped);

const runFrom = Effect.fn("HlsTiming.runFrom")(function* (
  testCase: Case,
  input: string,
  probe: MediaProbe,
  plan: SegmentPlan,
  startSegment: number,
) {
  const { root } = yield* Workspace;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tools = yield* MediaTools.Service;
  const audioIndex = probe.audio[0]?.index ?? 1;
  const from = plan.starts[startSegment] ?? plan.end;

  const outputDirectory = path.join(
    root,
    `${testCase.source.name}-${testCase.video}-${testCase.audio}-${String(startSegment)}`,
  );

  yield* fs.makeDirectory(outputDirectory, { recursive: true });

  yield* tools.ffmpegInBackground(
    hlsCommandArgs({
      input,
      sourceStart: probe.startSeconds,
      from,
      videoIndex: probe.video?.index ?? 0,
      videoCodec: probe.video?.codec ?? "h264",
      videoBitDepth: 8,
      video:
        testCase.video === "copy"
          ? VideoPlan.Copy()
          : VideoPlan.Encode({
              encoder: testCase.video,
              width: 320,
              height: 180,
              toneMap: false,
              bitrate: 1_000_000,
              burnSubtitle: undefined,
            }),
      audio:
        testCase.audio === "copy"
          ? AudioPlan.Copy({ index: audioIndex })
          : AudioPlan.Aac({ index: audioIndex }),
      audioCodec: probe.audio[0]?.codec ?? "",
      copiedAudioEnd: testCase.audio === "copy" ? probe.audio[0]?.endSeconds : undefined,
      subtitleCodec: "",
      segmentStarts: plan.starts.slice(startSegment),
      previousStart: plan.starts[startSegment - 1],
      outputDirectory,
      qsvDevice: process.env["QSV_DEVICE"] ?? "/dev/dri/renderD128",
      vaapiDevice: process.env["VAAPI_DEVICE"] ?? "/dev/dri/renderD128",
    }),
  );

  const names = (yield* fs.readDirectory(outputDirectory))
    .filter((name) => /^f\d+\.m4s$/u.test(name))
    .toSorted((left, right) => Number(left.slice(1, -4)) - Number(right.slice(1, -4)));

  const init = yield* fs.readFile(path.join(outputDirectory, "init.mp4"));
  const video = videoTiming(init);

  const fragments = yield* Effect.forEach(names, (name) =>
    Effect.gen(function* () {
      const fragment = path.join(outputDirectory, name);

      const written =
        video === undefined ? undefined : fragmentSpan(video, yield* fs.readFile(fragment));

      return { path: fragment, start: written?.start ?? Number.NaN };
    }),
  );

  const initStreams = yield* tools
    .ffprobe([
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type",
      "-of",
      "csv=p=0",
      path.join(outputDirectory, "init.mp4"),
    ])
    .pipe(
      Effect.map((output) => output.split("\n").filter((line) => line.trim() !== "").length),
      Effect.catchTag("MediaToolFailed", () => Effect.succeed(0)),
    );

  const groups = [...groupFragments(plan, startSegment, from, fragments)];

  const segments = yield* Effect.forEach(groups, ([index, members]) =>
    Effect.map(
      probeSegment(
        init,
        members.map((fragment) => fragment.path),
      ),
      (timing) => ({
        index,
        planned: plan.starts[index] ?? plan.end,
        ...timing,
      }),
    ),
  );

  return {
    from,
    init,
    initStreams,
    segments,
  } satisfies Run;
});

const continued = (fromStart: Run, resumed: Run): ReadonlyArray<SegmentTiming> => {
  const first = resumed.segments[0]?.index ?? 0;

  return [...fromStart.segments.filter((segment) => segment.index < first), ...resumed.segments];
};

const seams = (segments: ReadonlyArray<SegmentTiming>, stream: "video" | "audio") =>
  segments.slice(1).map((segment, index) => ({
    index: segment.index,
    gap: segment[stream].first - (segments[index]?.[stream].end ?? Number.NaN),
  }));

const ms = (seconds: number): string => (seconds * 1000).toFixed(1);

const STREAMS = ["video", "audio"] as const;

const describeSpan = ({ first, end, steps }: Span): string =>
  `${ms(first)}..${ms(end)} steps ${ms(Math.min(...steps))}..${ms(Math.max(...steps))}`;

const describeRun = (label: string, segments: ReadonlyArray<SegmentTiming>): string =>
  [
    `  ${label}`,
    ...segments.map(
      (segment) =>
        `    s${String(segment.index)} planned ${ms(segment.planned)}: video ${describeSpan(segment.video)} | audio ${describeSpan(segment.audio)}`,
    ),
    ...STREAMS.map((stream) => {
      const list = seams(segments, stream).map((seam) => `s${String(seam.index)} ${ms(seam.gap)}`);

      return `    ${stream} seams ${list.join(", ")}`;
    }),
  ].join("\n");

const measure = (testCase: Case) =>
  Layer.effect(
    Measured,
    Effect.gen(function* () {
      const input = yield* (yield* Sources).file(testCase.source);
      const probe = yield* probeFile(input);
      const keyframes = yield* KeyframeIndex.Service;

      const plan =
        testCase.video === "copy"
          ? planKeyframeSegments(
              yield* keyframes.keyframes({
                fileId: MediaFileId.make(testCase.source.name),
                path: input,
                sizeBytes: 1,
                modifiedAtMs: 1,
                probe,
                subtitles: [],
              }),
              probe.startSeconds,
              probe.durationSeconds,
            )
          : planGridSegments(probe.startSeconds, probe.durationSeconds);

      const fromStart = yield* runFrom(testCase, input, probe, plan, 0);

      const resumed = yield* Effect.forEach(RESUME_SEGMENTS, (start) =>
        runFrom(testCase, input, probe, plan, start),
      );

      const sourceEnds = yield* probeSpans(input);

      if (optIn) {
        yield* Console.log(
          [
            `${testCase.name} (plan ${plan.starts.map(ms).join(", ")})`,
            `  audio ends ${ms(endGap(sourceEnds))} ms after video in the source, ${ms(endGap(runEnds(fromStart)))} ms in a run from the start`,
            describeRun("from the start", fromStart.segments),
            ...resumed.map((run) =>
              describeRun(`continued at ${ms(run.from)}`, continued(fromStart, run)),
            ),
          ].join("\n"),
        );
      }

      return { plan, sourceEnds, fromStart, resumed };
    }).pipe(Effect.orDie),
  );

const lateness = (testCase: Case): number =>
  testCase.video === "copy" ? ROUNDING : FRAME + ROUNDING;

const checkPlanned = (testCase: Case, run: Run, label: string) => {
  for (const segment of run.segments) {
    const offset = segment.video.first - segment.planned;

    assert.isTrue(
      offset >= -ROUNDING && offset <= lateness(testCase),
      `${label}: segment ${String(segment.index)} video starts ${ms(offset)} ms from its plan`,
    );
  }

  assert.isTrue(
    (run.segments[0]?.audio.first ?? Number.NaN) >= 0,
    `${label}: audio starts at ${ms(run.segments[0]?.audio.first ?? Number.NaN)} ms`,
  );
};

const checkSeams = (stream: "video" | "audio", limit: number) =>
  Effect.gen(function* () {
    const { fromStart, resumed } = yield* Measured;

    for (const run of resumed) {
      for (const seam of seams(continued(fromStart, run), stream)) {
        assert.isAtMost(
          Math.abs(seam.gap),
          limit,
          `${stream} seam at s${String(seam.index)} after a run from ${ms(run.from)} ms`,
        );
      }
    }
  });

const sourcesLayer = Layer.effect(
  Sources,
  Effect.gen(function* () {
    const context = yield* Effect.context<Workspace | MediaTools.Service | Path.Path>();

    const files = new Map(
      yield* Effect.forEach(new Set(CASES.map((testCase) => testCase.source)), (source) =>
        Effect.map(
          Effect.cached(generateSource(source).pipe(Effect.provideContext(context), Effect.orDie)),
          (file) => [source, file] as const,
        ),
      ),
    );

    return {
      file: (source: Source) =>
        files.get(source) ?? Effect.die(`${source.name} is no case's source`),
    };
  }),
).pipe(Layer.provideMerge(toolsLayer));

describe.runIf(hasFfmpeg)("HLS timing", () => {
  layer(sourcesLayer, { excludeTestServices: true, timeout: "180 seconds" })((shared) => {
    for (const testCase of CASES) {
      describe.runIf(runnable[testCase.video])(testCase.name, () => {
        shared.layer(measure(testCase), { timeout: "180 seconds" })((it) => {
          const test = (property: Property) =>
            testCase.expectedFailures.includes(property)
              ? optIn
                ? it.effect.fails
                : it.effect.skip
              : it.effect;

          test("planned")(
            "presents every run's video at the planned times, and no audio before 0",
            () =>
              Effect.gen(function* () {
                const { fromStart, resumed } = yield* Measured;

                checkPlanned(testCase, fromStart, "from the start");

                for (const run of resumed) checkPlanned(testCase, run, `from ${ms(run.from)} ms`);
              }),
          );

          test("video seam")("continues an earlier run's video without a step", () =>
            checkSeams("video", ROUNDING),
          );

          test("audio seam")(
            testCase.video === "copy"
              ? "continues an earlier run's audio without a gap or overlap"
              : "continues an earlier run's audio within one AAC frame",
            () => checkSeams("audio", testCase.video === "copy" ? ROUNDING : AAC_FRAME + ROUNDING),
          );

          test("init audio")("writes every run's init.mp4 with its video and audio tracks", () =>
            Effect.gen(function* () {
              const { fromStart, resumed } = yield* Measured;

              for (const run of [fromStart, ...resumed]) {
                assert.strictEqual(
                  run.initStreams,
                  2,
                  `init.mp4 of the run from ${ms(run.from)} ms`,
                );
              }
            }),
          );

          // In MPEG-TS, init.mp4 differs between runs in metadata only: ffmpeg rounds the first
          // frame's composition offset in the 90 kHz clock one tick (11 µs) differently from run to
          // run, and estimates AAC's bitrate fields from what it read; which differ depends on the
          // ffmpeg build. Fragments decode to the same frames and times behind either init.
          if (testCase.source.container !== "ts") {
            test("init")("writes the same init.mp4 in every run", () =>
              Effect.gen(function* () {
                const { fromStart, resumed } = yield* Measured;

                for (const run of resumed) {
                  assert.deepStrictEqual(run.init, fromStart.init, `run from ${ms(run.from)} ms`);
                }
              }),
            );
          }

          if (testCase.video !== "copy") {
            test("audio start")("starts a later run's audio at most a frame before its start", () =>
              Effect.gen(function* () {
                const { resumed, sourceEnds } = yield* Measured;

                // A run that starts after the audio ends keeps what its seek lands before.
                for (const run of resumed.filter(
                  (each) => sourceEnds.audio.end >= each.from + AUDIO_END_MARGIN,
                )) {
                  const early = run.from - (run.segments[0]?.audio.first ?? Number.NaN);

                  assert.isAtMost(
                    early,
                    AUDIO_START_LIMIT,
                    `audio from ${ms(early)} ms before ${ms(run.from)}`,
                  );
                }
              }),
            );
          }

          test("sync")("keeps audio as far from video at the end as the source does", () =>
            Effect.gen(function* () {
              const { sourceEnds, fromStart } = yield* Measured;
              const drift = endGap(runEnds(fromStart)) - endGap(sourceEnds);

              assert.isAtMost(
                Math.abs(drift),
                LAST_FRAME + ROUNDING,
                `audio drifts ${ms(drift)} ms`,
              );
            }),
          );

          if (testCase.audio === "aac") {
            test("even")("gives every AAC frame the same duration", () =>
              Effect.gen(function* () {
                const { fromStart, resumed } = yield* Measured;

                for (const run of [fromStart, ...resumed]) {
                  const steps = run.segments.flatMap((segment) => segment.audio.steps);

                  assert.isAbove(steps.length, 100, `AAC frames from ${ms(run.from)} ms`);

                  assert.isAtMost(
                    Math.max(...steps) - Math.min(...steps),
                    0.000_1,
                    `AAC frames from ${ms(run.from)} ms last ${ms(Math.min(...steps))}..${ms(Math.max(...steps))} ms`,
                  );
                }
              }),
            );
          }
        });
      });
    }
  });
});
