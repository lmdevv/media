import { assert, describe, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Option, Path, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LibraryId } from "@media/contracts/ids";
import { type ClientCapabilities, NegotiateResponse } from "@media/contracts/media-playback";

import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-tokens.ts";

const settings = {
  enabled: process.env["MEDIA_TIMING"] === "1" && (await ffmpegAvailable()),
  runsPerCase: Number(process.env["MEDIA_TIMING_RUNS"] ?? "5"),
  keptSourcesFolder: process.env["MEDIA_TIMING_SOURCES"],
  quickSync: process.env["MEDIA_TIMING_HARDWARE"] === "qsv",
  casesNaming: process.env["MEDIA_TIMING_ONLY"] ?? "",
  rowsJsonFile: process.env["MEDIA_TIMING_OUT"],
};

const TIMING = LibraryId.make("timing");

const SECONDS = 300;

const RESUME_SECONDS = 200;

const SOURCES = {
  "1080p": {
    name: "Startup 1080p (2020)/Startup 1080p (2020).mkv",
    size: "1920x1080",
    bitrate: "8M",
    gop: "48",
  },
  "4k": {
    name: "Startup 4K (2020)/Startup 4K (2020).mkv",
    size: "3840x2160",
    bitrate: "40M",
    gop: "120",
  },
} as const;

type Source = keyof typeof SOURCES;

const screen = (maxWidth: number, maxHeight: number, ac3: boolean): ClientCapabilities => ({
  containers: ["mp4", "webm"],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: ac3 ? [{ codec: "aac" }, { codec: "ac3", maxChannels: 6 }] : [{ codec: "aac" }],
  maxWidth,
  maxHeight,
  hls: false,
  mse: true,
});

const PATHS = {
  remux: screen(3840, 2160, true),
  "audio transcode": screen(3840, 2160, false),
  transcode: screen(1280, 720, false),
} as const;

type PathName = keyof typeof PATHS;

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const makeLibrary = Effect.gen(function* () {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = path.join(workspace.root, "timing");
  const cache = settings.keptSourcesFolder ?? root;

  for (const source of Object.values(SOURCES)) {
    const kept = path.join(cache, source.name);
    const output = path.join(root, source.name);

    if (!(yield* fs.exists(kept))) {
      yield* fs.makeDirectory(path.dirname(kept), { recursive: true });
      yield* tools.ffmpeg(
        [
          "-hide_banner",
          "-nostdin",
          "-v",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          `testsrc2=size=${source.size}:rate=24:duration=${String(SECONDS)}`,
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=440:sample_rate=48000:duration=${String(SECONDS)}`,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-b:v",
          source.bitrate,
          "-pix_fmt",
          "yuv420p",
          "-g",
          source.gop,
          "-c:a",
          "ac3",
          "-ac",
          "6",
          `${kept}.tmp.mkv`,
        ],
        { timeout: Duration.minutes(30) },
      );
      yield* fs.rename(`${kept}.tmp.mkv`, kept);
    }

    if (kept !== output) {
      yield* fs.makeDirectory(path.dirname(output), { recursive: true });
      // Not copyFile, whose fchown the NixOS unit's system call filter denies.
      yield* fs
        .link(kept, output)
        .pipe(Effect.catch(() => Stream.run(fs.stream(kept), fs.sink(output))));
    }
  }

  yield* scanner.scan({ libraryId: TIMING, root, mode: "incremental" });
});

const writtenAt = Effect.fn(function* (
  streamId: string,
  generation: number,
  origin: number,
  names: ReadonlyArray<string>,
) {
  const server = yield* MediaTestServer.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const times = yield* Effect.forEach(names, (name) =>
    fs.stat(path.join(server.transcodeDir, streamId, String(generation), name)).pipe(
      Effect.map((info) => [name, Option.getOrUndefined(info.mtime)?.getTime()] as const),
      Effect.orElseSucceed(() => [name, undefined] as const),
    ),
  );

  return new Map(times.map(([name, at]) => [name, at === undefined ? undefined : at - origin]));
});

const segmentHolding = (playlist: string, seconds: number): number => {
  const durations = [...playlist.matchAll(/#EXTINF:([\d.]+),/gu)].map((match) => Number(match[1]));

  let end = 0;

  for (const [index, duration] of durations.entries()) {
    end += duration;

    if (seconds < end) return index;
  }

  return Math.max(0, durations.length - 1);
};

const fetchWhole = (url: string, origin: number) =>
  Effect.gen(function* () {
    const response = yield* HttpClient.get(url);
    const firstByteMs = Math.round(performance.now() - origin);
    const bytes = (yield* response.arrayBuffer).byteLength;

    assert.strictEqual(response.status, 200, url);
    assert.isAbove(bytes, 0, url);

    return { firstByteMs, doneMs: Math.round(performance.now() - origin), bytes };
  }).pipe(Effect.orDie);

const startPlayback = Effect.fn(function* (
  source: Source,
  pathName: PathName,
  startSeconds: number,
  session: string,
) {
  const server = yield* MediaTestServer.Service;
  const fileId = MemoryLibrary.fileIdOf(TIMING, SOURCES[source].name);
  const token = signTestToken({ fid: fileId, sid: session });
  const origin = performance.now();
  const wallOrigin = Date.now();
  const since = () => Math.round(performance.now() - origin);

  const negotiation = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        token,
        capabilities: PATHS[pathName],
        startSeconds,
      }),
    ),
  ).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeNegotiation),
    Effect.orDie,
  );

  const negotiatedMs = since();
  const url = new URL(negotiation.url);
  const local = `${server.baseUrl}${url.pathname}${url.search}`;
  const file = (name: string) => new URL(`${name}${url.search}`, local).toString();

  const playlist = yield* HttpClient.get(local).pipe(
    Effect.flatMap((response) => response.text),
    Effect.orDie,
  );

  const playlistMs = since();

  const index = segmentHolding(playlist, negotiation.startSeconds);

  const [init, segment] = yield* Effect.all(
    [fetchWhole(file("init.mp4"), origin), fetchWhole(file(`${String(index)}.m4s`), origin)],
    { concurrency: "unbounded" },
  );

  const written = yield* writtenAt(
    negotiation.streamId ?? "",
    negotiation.generation ?? 1,
    wallOrigin,
    ["init.mp4", "f0.m4s", "f1.m4s"],
  );

  yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/stop`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token, streamId: negotiation.streamId }),
    ),
  ).pipe(Effect.orDie);

  return {
    source,
    path: pathName,
    from: startSeconds,
    mode: negotiation.mode,
    segment: index,
    negotiatedMs,
    playlistMs,
    initMs: init.doneMs,
    segmentFirstByteMs: segment.firstByteMs,
    segmentMs: segment.doneMs,
    initBytes: init.bytes,
    segmentBytes: segment.bytes,
    initWrittenMs: written.get("init.mp4"),
    firstFragmentWrittenMs: written.get("f0.m4s"),
    secondFragmentWrittenMs: written.get("f1.m4s"),
  };
});

type Row = Effect.Success<ReturnType<typeof startPlayback>>;

const median = (values: ReadonlyArray<number>): number | undefined => {
  const sorted = values.toSorted((left, right) => left - right);
  const upper = sorted[Math.floor(sorted.length / 2)];
  const lower = sorted[Math.ceil(sorted.length / 2) - 1];

  return upper === undefined || lower === undefined ? undefined : (upper + lower) / 2;
};

const summary = (rows: ReadonlyArray<Row>) => {
  const groups = Map.groupBy(rows, (row) => `${row.source} ${row.path} from ${String(row.from)}`);

  return [...groups].map(([name, group]) => {
    const of = (pick: (row: Row) => number | undefined) =>
      median(group.flatMap((row) => pick(row) ?? []));

    const totals = group.map((row) => row.segmentMs);

    return {
      case: name,
      mode: group[0]?.mode,
      runs: group.length,
      negotiated: of((row) => row.negotiatedMs),
      playlist: of((row) => row.playlistMs),
      init: of((row) => row.initMs),
      segmentFirstByte: of((row) => row.segmentFirstByteMs),
      segment: of((row) => row.segmentMs),
      range: `${String(Math.min(...totals))}-${String(Math.max(...totals))}`,
      f0Written: of((row) => row.firstFragmentWrittenMs),
      f1Written: of((row) => row.secondFragmentWrittenMs),
    };
  });
};

const SOURCE_NAMES: ReadonlyArray<Source> = ["1080p", "4k"];

const PATH_NAMES: ReadonlyArray<PathName> = ["remux", "audio transcode", "transcode"];

const cases = SOURCE_NAMES.flatMap((source) =>
  PATH_NAMES.flatMap((name) => [0, RESUME_SECONDS].map((from) => ({ source, name, from }))),
).filter(({ source, name, from }) =>
  `${source} ${name} from ${String(from)}`.includes(settings.casesNaming),
);

describe.skipIf(!settings.enabled)("playback start timing", () => {
  layer(
    MediaTestServer.layer({
      STREAM_IDLE_SECONDS: "600",
      HARDWARE_ACCELERATION: settings.quickSync ? "qsv" : "none",
    }),
    { excludeTestServices: true, timeout: "3600 seconds" },
  )((it) => {
    it.effect(
      "times each startup stage per path, source, and start position",
      () =>
        Effect.gen(function* () {
          yield* makeLibrary;

          const rows: Array<Row> = [];

          for (let run = 0; run < settings.runsPerCase; run += 1) {
            for (const { source, name, from } of cases) {
              rows.push(
                yield* startPlayback(source, name, from, `${name}-${source}-${String(run)}`),
              );
            }
          }

          console.table(summary(rows));

          const out = settings.rowsJsonFile;

          if (out !== undefined) {
            const fs = yield* FileSystem.FileSystem;

            yield* fs.writeFileString(out, JSON.stringify(rows, undefined, 2));
          }

          assert.strictEqual(rows.length, settings.runsPerCase * cases.length);
        }),
      3_600_000,
    );
  });
});
