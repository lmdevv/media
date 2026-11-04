/**
 * Makes a file's scrub thumbnails with one ffmpeg run. Only keyframes are decoded
 * (`-skip_frame nokey`), which is what makes a two-hour film take seconds rather than minutes; the
 * `fps` filter then picks one frame per interval, so a thumbnail is the last keyframe at or before
 * its time. Frames are scaled to `TRICKPLAY_TILE_WIDTH` by the display aspect ratio, HDR
 * video is tone-mapped to SDR (falling back to untouched frames when ffmpeg lacks `zscale`), and
 * `tile` lays them out into JPEG sheets. ffmpeg runs on one thread at the lowest CPU priority, so
 * playback never waits for it.
 */
import {
  TRICKPLAY_COLUMNS,
  TRICKPLAY_ROWS,
  TRICKPLAY_TILE_WIDTH,
  TrickplayManifest,
  type TrickplayVersion,
  trickplayLayout,
} from "@media/contracts/trickplay";
import { Duration, Effect, FileSystem, Option, Path, Schema } from "effect";

import * as MediaTools from "../media/media-tools.ts";
import type { ResolvedMediaFile } from "../playback/file-resolver.ts";

const TrickplayFailure = Schema.Literals(["no-video", "unknown-duration", "no-output"]);

const FAILURE_MESSAGES: Readonly<Record<typeof TrickplayFailure.Type, string>> = {
  "no-video": "This file has no video to make thumbnails from",
  "unknown-duration": "This file's length is unknown, so thumbnails cannot be placed",
  "no-output": "ffmpeg could not read frames from this file",
};

class TrickplayUnavailable extends Schema.TaggedError<TrickplayUnavailable>()(
  "TrickplayUnavailable",
  { reason: TrickplayFailure, cause: Schema.Defect() },
) {
  override get message(): string {
    return FAILURE_MESSAGES[this.reason];
  }
}

const TONE_MAP = [
  "zscale=t=linear:npl=100",
  "format=gbrpf32le",
  "zscale=p=bt709",
  "tonemap=hable:desat=0",
  "zscale=t=bt709:m=bt709:r=pc",
].join(",");

const SHEET = /^(\d+)\.jpg$/u;

const FRAME_LOG = "frames.txt";

/**
 * The frame log as a filter option value, or none when the folder's path holds characters
 * filtergraph quoting cannot carry; the layout's count stands in then.
 */
const frameLogOption = (folder: string): string | null =>
  /['\\]/u.test(folder) ? null : `'${folder}/${FRAME_LOG}'`;

const SheetSize = Schema.Struct({
  streams: Schema.Tuple([Schema.Struct({ width: Schema.Int, height: Schema.Int })]),
});

const decodeSheetSize = Schema.decodeUnknownEffect(Schema.fromJsonString(SheetSize));

const thumbnailArgs = (
  file: Pick<ResolvedMediaFile, "path"> & { readonly videoIndex: number },
  interval: Duration.Duration,
  folder: string,
  toneMap: boolean,
): ReadonlyArray<string> => {
  const filters = [
    // Slot `i` takes the last keyframe at or before `i * interval` (rounding up assigns frames to
    // the next tick); the last, partial slot stays. ffmpeg 6 emits nothing for a clip shorter than
    // one interval unless the first slot is pinned to zero.
    `fps=fps=1000/${String(Duration.toMillis(interval))}:round=up:eof_action=pass:start_time=0`,
    ...Option.match(Option.fromNullishOr(frameLogOption(folder)), {
      onNone: () => [],
      // `print` lists only frames that carry metadata, so each picked frame is tagged first.
      onSome: (log) => [
        "metadata=mode=add:key=movies.thumbnail:value=1",
        `metadata=mode=print:key=movies.thumbnail:file=${log}`,
      ],
    }),
    `scale=${String(TRICKPLAY_TILE_WIDTH)}:trunc(ow/dar/2)*2:out_range=full`,
    "setsar=1",
    ...(toneMap ? [TONE_MAP] : []),
    // JPEG is full range; ffmpeg's encoder refuses the limited range most video decodes to.
    "format=yuvj420p",
    `tile=${String(TRICKPLAY_COLUMNS)}x${String(TRICKPLAY_ROWS)}`,
  ];

  return [
    "-hide_banner",
    "-nostats",
    "-v",
    "error",
    "-threads",
    "1",
    "-skip_frame",
    "nokey",
    "-i",
    file.path,
    "-map",
    `0:${String(file.videoIndex)}`,
    "-an",
    "-sn",
    "-dn",
    "-threads",
    "1",
    "-vf",
    filters.join(","),
    "-fps_mode",
    "passthrough",
    "-q:v",
    "5",
    "-start_number",
    "0",
    "-f",
    "image2",
    `${folder}/%d.jpg`,
  ];
};

/**
 * Writes `file`'s sheets into `folder` (empty, owned by the caller) and returns their manifest
 * as version `version`.
 */
export const generate = Effect.fn("TrickplayGenerator.generate")(function* (
  file: ResolvedMediaFile,
  version: TrickplayVersion,
  interval: Duration.Duration,
  folder: string,
) {
  const tools = yield* MediaTools.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const video = file.probe.video;
  const durationMs = file.probe.durationSeconds * 1000;

  if (video === undefined) {
    return yield* new TrickplayUnavailable({ reason: "no-video", cause: null });
  }

  if (!(durationMs > 0)) {
    return yield* new TrickplayUnavailable({ reason: "unknown-duration", cause: null });
  }

  const target = { path: file.path, videoIndex: video.index };

  const sheets = fs.readDirectory(folder).pipe(
    Effect.map((names) => names.filter((name) => SHEET.test(name))),
    Effect.orElseSucceed(() => []),
  );

  const run = (toneMap: boolean) =>
    tools.ffmpegInBackground(thumbnailArgs(target, interval, folder, toneMap));

  yield* video.dynamicRange === "sdr"
    ? run(false)
    : run(true).pipe(
        Effect.catchTag("MediaToolFailed", (error) =>
          Effect.logInfo("TrickplayGenerator.tone_map_failed", error).pipe(
            Effect.andThen(sheets),
            Effect.map((names) => [...names, FRAME_LOG]),
            Effect.flatMap((names) =>
              Effect.forEach(names, (name) =>
                fs.remove(path.join(folder, name)).pipe(Effect.ignore),
              ),
            ),
            Effect.andThen(run(false)),
          ),
        ),
      );

  const written = (yield* sheets).length;

  if (written === 0) {
    return yield* new TrickplayUnavailable({
      reason: "no-output",
      cause: "ffmpeg wrote no sheets",
    });
  }

  const size = yield* tools
    .ffprobe([
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      path.join(folder, "0.jpg"),
    ])
    .pipe(
      Effect.flatMap(decodeSheetSize),
      Effect.mapError((cause) => new TrickplayUnavailable({ reason: "no-output", cause })),
    );

  const [sheet] = size.streams;
  const perSheet = TRICKPLAY_COLUMNS * TRICKPLAY_ROWS;
  const layout = trickplayLayout(durationMs, Duration.toMillis(interval), perSheet);
  const log = path.join(folder, FRAME_LOG);

  // The frames ffmpeg picked: fewer than the layout when the video ends before the container
  // (a longer audio track), and the last sheet's padding is black, not thumbnails.
  const picked = yield* fs.readFileString(log).pipe(
    Effect.map((text) => text.split("\n").filter((line) => line.startsWith("frame:")).length),
    Effect.orElseSucceed(() => layout.thumbnailCount),
  );

  yield* fs.remove(log).pipe(Effect.ignore);

  const thumbnailCount = Math.max(1, Math.min(layout.thumbnailCount, picked, written * perSheet));

  return yield* Schema.decodeEffect(TrickplayManifest)({
    version,
    intervalMs: Duration.toMillis(interval),
    tileWidth: Math.round(sheet.width / TRICKPLAY_COLUMNS),
    tileHeight: Math.round(sheet.height / TRICKPLAY_ROWS),
    columns: TRICKPLAY_COLUMNS,
    rows: TRICKPLAY_ROWS,
    thumbnailCount,
    sheetCount: Math.ceil(thumbnailCount / perSheet),
  }).pipe(Effect.mapError((cause) => new TrickplayUnavailable({ reason: "no-output", cause })));
});
