import { join } from "node:path";

import { assert, describe, layer } from "@effect/vitest";
import { Duration, Effect, FileSystem, Path, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { LibraryId } from "@media/contracts/ids";
import {
  type ClientCapabilities,
  NegotiateResponse,
  SeekResponse,
} from "@media/contracts/media-playback";

import * as LibraryScanner from "../library/library-scanner.ts";
import * as MemoryLibrary from "../library/memory-library.ts";
import * as MediaTools from "../media/media-tools.ts";
import { sidecarTrackId } from "../subtitles/subtitle-tracks.ts";
import { ffmpegAvailable } from "../testing/fixture-library.ts";
import * as FixtureWorkspace from "../testing/fixture-workspace.ts";
import * as MediaTestServer from "../testing/media-test-server.ts";
import { signTestToken } from "../testing/test-tokens.ts";

const hasFfmpeg = await ffmpegAvailable();

const VOBSUB = join(import.meta.dirname, "..", "testing", "fixtures", "vobsub.mkv");

const FONT = join(import.meta.dirname, "..", "testing", "fixtures", "lar-blocks.ttf");

const TRACK = "e1";

const TRACK_AFTER_AUDIO = "e2";

const FILM = "Picture Subtitles (2020)/Picture Subtitles (2020).mkv";

const chromium: ClientCapabilities = {
  containers: ["mp4"],
  videoCodecs: [{ codec: "h264", maxBitDepth: 8 }],
  audioCodecs: [{ codec: "aac" }],
  maxWidth: 1920,
  maxHeight: 1080,
  hls: false,
  mse: true,
};

const decodeNegotiation = Schema.decodeUnknownEffect(Schema.toCodecJson(NegotiateResponse));

const decodeSeek = Schema.decodeUnknownEffect(Schema.toCodecJson(SeekResponse));

interface Film {
  readonly seconds: number;
  readonly captionsFrom: number;
  readonly audioCodec: "aac" | "ac3" | undefined;
}

const SHORT_FILM: Film = { seconds: 8, captionsFrom: 0, audioCodec: undefined };

const addFilm = Effect.fn(function* (library: string, film: Film = SHORT_FILM) {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const libraryId = LibraryId.make(library);
  const root = path.join(workspace.root, library);
  const output = path.join(root, FILM);

  yield* fs.makeDirectory(path.dirname(output), { recursive: true });
  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `color=c=0x305070:s=640x360:r=25:d=${String(film.seconds)}`,
    ...(film.audioCodec === undefined
      ? []
      : [
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=440:sample_rate=48000:duration=${String(film.seconds)}`,
        ]),
    "-itsoffset",
    String(film.captionsFrom),
    "-i",
    VOBSUB,
    "-map",
    "0:v",
    ...(film.audioCodec === undefined
      ? ["-map", "1:s"]
      : ["-map", "1:a", "-c:a", film.audioCodec, "-map", "2:s"]),
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "25",
    "-c:s",
    "copy",
    output,
  ]);
  yield* scanner.scan({ libraryId, root, mode: "incremental" });

  return MemoryLibrary.fileIdOf(libraryId, FILM);
});

const negotiate = Effect.fn(function* (
  token: string,
  burnInSubtitle?: string,
  startSeconds?: number,
) {
  const server = yield* MediaTestServer.Service;

  return yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        token,
        capabilities: chromium,
        burnInSubtitle,
        startSeconds,
      }),
    ),
  ).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeNegotiation),
    Effect.orDie,
  );
});

const seek = Effect.fn(function* (
  token: string,
  streamId: string | undefined,
  positionSeconds: number,
) {
  const server = yield* MediaTestServer.Service;

  return yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/seek`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token, streamId, positionSeconds }),
    ),
  ).pipe(
    Effect.flatMap((response) => response.json),
    Effect.flatMap(decodeSeek),
    Effect.orDie,
  );
});

const stop = Effect.fn(function* (token: string, streamId: string | undefined) {
  const server = yield* MediaTestServer.Service;

  const response = yield* HttpClient.execute(
    HttpClientRequest.post(`${server.baseUrl}/api/playback/stop`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ token, streamId }),
    ),
  ).pipe(Effect.orDie);

  assert.strictEqual(response.status, 204);
});

const segmentHolding = Effect.fn(function* (playlistUrl: string, time: number) {
  const server = yield* MediaTestServer.Service;
  const url = new URL(playlistUrl);

  const playlist = yield* HttpClient.get(`${server.baseUrl}${url.pathname}${url.search}`).pipe(
    Effect.flatMap((response) => response.text),
    Effect.orDie,
  );

  const durations = playlist
    .split("\n")
    .filter((line) => line.startsWith("#EXTINF:"))
    .map((line) => Number.parseFloat(line.slice("#EXTINF:".length)));

  let end = 0;

  return durations.findIndex((duration) => {
    end += duration;

    return time < end - 0.001;
  });
});

const joinedSegment = Effect.fn(function* (playlistUrl: string, index: number) {
  const server = yield* MediaTestServer.Service;
  const fs = yield* FileSystem.FileSystem;
  const url = new URL(playlistUrl);
  const base = `${server.baseUrl}${url.pathname}`;

  const fetch = Effect.fn(function* (name: string) {
    const response = yield* HttpClient.get(new URL(`${name}${url.search}`, base).toString());

    if (response.status !== 200) {
      const body = yield* response.text;

      assert.fail(`${name} answered ${String(response.status)}: ${body}`);
    }

    return new Uint8Array(yield* response.arrayBuffer);
  }, Effect.orDie);

  const init = yield* fetch("init.mp4");
  const segment = yield* fetch(`${String(index)}.m4s`);
  const file = yield* fs.makeTempFileScoped({ suffix: ".mp4" });

  yield* fs.writeFile(file, new Uint8Array([...init, ...segment]));

  return file;
});

const bottomOfSegment = Effect.fn(function* (playlistUrl: string, index: number) {
  const tools = yield* MediaTools.Service;
  const fs = yield* FileSystem.FileSystem;
  const file = yield* joinedSegment(playlistUrl, index);
  const frame = yield* fs.makeTempFileScoped({ suffix: ".gray" });

  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    file,
    "-frames:v",
    "1",
    "-vf",
    "crop=iw:ih/3:0:ih*2/3,format=gray",
    "-f",
    "rawvideo",
    frame,
  ]);

  return yield* fs.readFile(frame);
});

const brightSamples = (samples: Uint8Array): number =>
  samples.filter((sample) => sample > 200).length;

const firstPacketTime = Effect.fn(function* (file: string, stream: "v" | "a") {
  const tools = yield* MediaTools.Service;

  const output = yield* tools.ffprobe([
    "-v",
    "error",
    "-select_streams",
    `${stream}:0`,
    "-show_entries",
    "packet=pts_time",
    "-read_intervals",
    "%+#1",
    "-of",
    "csv=p=0",
    file,
  ]);

  return Number.parseFloat(output);
});

describe.skipIf(!hasFfmpeg)("image subtitles", () => {
  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "lists a DVD subtitle and plays without it until asked",
      () =>
        Effect.gen(function* () {
          const fileId = yield* addFilm("listed").pipe(Effect.orDie);
          const token = signTestToken({ fid: fileId, sid: "burn-in-listed" });

          const plain = yield* negotiate(token);
          const track = plain.subtitles.find((subtitle) => subtitle.kind === "bitmap");

          assert.strictEqual(plain.mode, "remux");
          assert.deepInclude(track, { id: TRACK, codec: "dvd_subtitle", source: "embedded" });
          assert.isUndefined(track?.url);
          assert.isUndefined(plain.burnedInSubtitle);

          yield* stop(token, plain.streamId);
        }),
      60_000,
    );

    it.effect(
      "burns a DVD subtitle into a transcode on request",
      () =>
        Effect.gen(function* () {
          const fileId = yield* addFilm("burned-from-start").pipe(Effect.orDie);
          const token = signTestToken({ fid: fileId, sid: "burn-in-start" });

          const burned = yield* negotiate(token, TRACK);

          assert.strictEqual(burned.mode, "transcode-software");
          assert.strictEqual(burned.burnedInSubtitle, TRACK);
          assert.deepStrictEqual([burned.video.width, burned.video.height], [640, 360]);

          assert.isAbove(brightSamples(yield* bottomOfSegment(burned.url, 2)), 200);

          yield* stop(token, burned.streamId);
        }),
      60_000,
    );

    it.effect(
      "burns a DVD subtitle into the stream a seek restarts",
      () =>
        Effect.gen(function* () {
          const fileId = yield* addFilm("burned-after-seek").pipe(Effect.orDie);
          const token = signTestToken({ fid: fileId, sid: "burn-in-seek" });

          const late = yield* negotiate(token, TRACK, 7);
          const moved = yield* seek(token, late.streamId, 5);

          assert.strictEqual(moved.generation, 2);
          assert.isAbove(brightSamples(yield* bottomOfSegment(moved.playlistUrl, 2)), 200);

          yield* stop(token, late.streamId);
        }),
      60_000,
    );

    it.effect(
      "keeps burning through a replaced stream and a seek, and goes back without the subtitle",
      () =>
        Effect.gen(function* () {
          const fileId = yield* addFilm("burned-then-replaced").pipe(Effect.orDie);
          const token = signTestToken({ fid: fileId, sid: "burn-in-replaced" });

          const burned = yield* negotiate(token, TRACK);

          assert.isAbove(brightSamples(yield* bottomOfSegment(burned.url, 2)), 200);

          const late = yield* negotiate(token, TRACK, 7);
          const moved = yield* seek(token, late.streamId, 5);

          assert.strictEqual(moved.generation, 2);
          assert.isAbove(brightSamples(yield* bottomOfSegment(moved.playlistUrl, 2)), 200);

          const back = yield* negotiate(token);

          assert.strictEqual(back.mode, "remux");
          assert.isUndefined(back.burnedInSubtitle);

          yield* stop(token, back.streamId);
        }),
      60_000,
    );

    for (const audioCodec of ["aac", "ac3"] as const) {
      it.effect(
        `burns a caption that started before a distant seek, on the source timeline, with ${audioCodec} audio`,
        () =>
          Effect.gen(function* () {
            const captionOffset = 38;
            const seekInsideCaption = 44;
            const afterCaptions = 52;

            const fileId = yield* addFilm(`burned-long-${audioCodec}`, {
              seconds: afterCaptions + 2,
              captionsFrom: captionOffset,
              audioCodec,
            }).pipe(Effect.orDie);

            const token = signTestToken({ fid: fileId, sid: `burn-in-long-${audioCodec}` });

            const start = yield* negotiate(token, TRACK_AFTER_AUDIO);
            const moved = yield* seek(token, start.streamId, seekInsideCaption);

            assert.strictEqual(moved.generation, 2);

            const seekSegment = yield* segmentHolding(moved.playlistUrl, seekInsideCaption);
            const segment = yield* joinedSegment(moved.playlistUrl, seekSegment);

            assert.closeTo(yield* firstPacketTime(segment, "v"), seekInsideCaption, 0.001);
            assert.closeTo(yield* firstPacketTime(segment, "a"), seekInsideCaption, 0.05);
            assert.isAbove(
              brightSamples(yield* bottomOfSegment(moved.playlistUrl, seekSegment)),
              200,
            );

            const clearSegment = yield* segmentHolding(moved.playlistUrl, afterCaptions);

            assert.strictEqual(
              brightSamples(yield* bottomOfSegment(moved.playlistUrl, clearSegment)),
              0,
            );

            yield* stop(token, start.streamId);
          }).pipe(Effect.scoped),
        90_000,
      );
    }

    it.effect("refuses to burn in a track the file does not have", () =>
      Effect.gen(function* () {
        const server = yield* MediaTestServer.Service;
        const { library } = yield* FixtureWorkspace.Service;
        const token = signTestToken({ fid: server.fileId("movies", library.remuxMovie) });

        const response = yield* HttpClient.execute(
          HttpClientRequest.post(`${server.baseUrl}/api/playback/negotiate`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              token,
              capabilities: chromium,
              burnInSubtitle: "e99",
            }),
          ),
        ).pipe(Effect.orDie);

        assert.strictEqual(response.status, 422);
        assert.deepStrictEqual(yield* response.json.pipe(Effect.orDie), {
          _tag: "UnsupportedPlayback",
          reason: "subtitle-not-burnable",
        });
      }).pipe(Effect.timeout(Duration.seconds(20))),
    );
  });
});

/**
 * A styled script: "LAR" in the attached block font, 40 lines tall, yellow, its top left at
 * (40, 250) of the 640x360 picture, from 1 s to 50 s, so it draws one solid 72x40 rectangle.
 */
const STYLED_SCRIPT = [
  "[Script Info]",
  "ScriptType: v4.00+",
  "PlayResX: 640",
  "PlayResY: 360",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: Blocks,Lar Blocks,40,&H0000FFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:01.00,0:00:50.00,Blocks,,0,0,0,,{\\pos(40,250)}LAR",
  "",
].join("\n");

const TEXT_FILM = "Styled Subtitles (2020)/Styled Subtitles (2020).mkv";

/** Every character ffmpeg's filter syntax treats specially, in a track's title. */
const HOSTILE_TITLE = "it's [a], title: with; \\ and = %d $HOME\nnext";

/**
 * A 54 s film whose subtitle track (e1) is the styled script with the block font attached, its
 * title holding every character special to ffmpeg's filter syntax, and a plain SRT sidecar.
 */
const addTextFilm = Effect.fn(function* (library: string) {
  const workspace = yield* FixtureWorkspace.Service;
  const tools = yield* MediaTools.Service;
  const scanner = yield* LibraryScanner.Service;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const libraryId = LibraryId.make(library);
  const root = path.join(workspace.root, library);
  const output = path.join(root, TEXT_FILM);
  const script = path.join(root, "styled.ass");
  const sidecar = output.replace(/\.mkv$/u, ".en.srt");

  yield* fs.makeDirectory(path.dirname(output), { recursive: true });
  yield* fs.writeFileString(script, STYLED_SCRIPT);
  yield* fs.writeFileString(sidecar, "1\n00:00:01,000 --> 00:00:50,000\nPlain sidecar line\n");
  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=0x305070:s=640x360:r=25:d=54",
    "-i",
    script,
    "-map",
    "0:v",
    "-map",
    "1:s",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "25",
    "-c:s",
    "copy",
    "-metadata:s:s:0",
    `title=${HOSTILE_TITLE}`,
    "-attach",
    FONT,
    "-metadata:s:t:0",
    "mimetype=application/x-truetype-font",
    "-metadata:s:t:0",
    "filename=../Lar Blocks.ttf",
    output,
  ]);
  yield* scanner.scan({ libraryId, root, mode: "incremental" });

  return { fileId: MemoryLibrary.fileIdOf(libraryId, TEXT_FILM), sidecar };
});

/** The first frame of segment `index` of a playlist's stream, as 640x360 RGB. */
const rgbOfSegment = Effect.fn(function* (playlistUrl: string, index: number) {
  const tools = yield* MediaTools.Service;
  const fs = yield* FileSystem.FileSystem;
  const file = yield* joinedSegment(playlistUrl, index);
  const frame = yield* fs.makeTempFileScoped({ suffix: ".rgb" });

  yield* tools.ffmpeg([
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    file,
    "-frames:v",
    "1",
    "-pix_fmt",
    "rgb24",
    "-f",
    "rawvideo",
    frame,
  ]);

  return yield* fs.readFile(frame);
});

/** What the block text looks like in a 640x360 RGB picture: inside its rectangle, and outside. */
const blockText = (rgb: Uint8Array) => {
  let inside = 0;
  let yellow = 0;
  let stray = 0;

  for (let y = 0; y < 360; y += 1) {
    for (let x = 0; x < 640; x += 1) {
      const at = (y * 640 + x) * 3;
      const lit = (rgb[at] ?? 0) > 180 && (rgb[at + 1] ?? 0) > 180 && (rgb[at + 2] ?? 0) < 90;

      if (x >= 43 && x < 109 && y >= 253 && y < 287) {
        inside += 1;

        if (lit) yellow += 1;
      } else if ((x < 34 || x >= 118 || y < 244 || y >= 296) && lit) {
        stray += 1;
      }
    }
  }

  return { filled: yellow / inside, stray };
};

describe.skipIf(!hasFfmpeg)("text subtitles", () => {
  layer(MediaTestServer.layer(), { excludeTestServices: true, timeout: "120 seconds" })((it) => {
    it.effect(
      "burns a styled ASS track in, in its own font, place, and colour, and from inside a long cue",
      () =>
        Effect.gen(function* () {
          const server = yield* MediaTestServer.Service;
          const fs = yield* FileSystem.FileSystem;
          const { fileId } = yield* addTextFilm("styled").pipe(Effect.orDie);
          const token = signTestToken({ fid: fileId, sid: "burn-text-styled" });

          const plain = yield* negotiate(token);

          assert.strictEqual(plain.mode, "remux");
          assert.deepInclude(
            plain.subtitles.find((track) => track.id === "e1"),
            { codec: "ass", kind: "text", title: HOSTILE_TITLE },
          );

          const burned = yield* negotiate(token, "e1");

          assert.strictEqual(burned.mode, "transcode-software");
          assert.strictEqual(burned.burnedInSubtitle, "e1");
          assert.deepInclude(burned.transcode?.stages ?? [], {
            op: "burn-text",
            domain: "cpu",
            impl: "burn-text.cpu",
          });

          // A solid block, so the attached font drew it: a fallback font's letters fill far less.
          const start = blockText(yield* rgbOfSegment(burned.url, 1));

          assert.isAtLeast(start.filled, 0.97);
          assert.strictEqual(start.stray, 0);

          const moved = yield* seek(token, burned.streamId, 30);
          const segment = yield* segmentHolding(moved.playlistUrl, 30);
          const inside = blockText(yield* rgbOfSegment(moved.playlistUrl, segment));

          assert.isAtLeast(inside.filled, 0.97);
          assert.strictEqual(inside.stray, 0);

          // The stream's own folder held the script and the font, and goes with the stream.
          assert.isTrue(
            yield* fs.exists(join(server.transcodeDir, burned.streamId ?? "", "subtitle")),
          );
          yield* stop(token, burned.streamId);
          assert.isFalse(yield* fs.exists(join(server.transcodeDir, burned.streamId ?? "")));
        }).pipe(Effect.scoped),
      90_000,
    );

    it.effect(
      "burns a plain SRT sidecar in, in the default style near the bottom",
      () =>
        Effect.gen(function* () {
          const { fileId, sidecar } = yield* addTextFilm("sidecar").pipe(Effect.orDie);
          const token = signTestToken({ fid: fileId, sid: "burn-text-sidecar" });
          const track = sidecarTrackId(sidecar);

          const burned = yield* negotiate(token, track);

          assert.strictEqual(burned.mode, "transcode-software");
          assert.strictEqual(burned.burnedInSubtitle, track);
          assert.isAbove(brightSamples(yield* bottomOfSegment(burned.url, 1)), 300);

          yield* stop(token, burned.streamId);
        }).pipe(Effect.scoped),
      90_000,
    );
  });
});
