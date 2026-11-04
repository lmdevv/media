import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { Effect } from "effect";

import { imageContentType } from "./art-store.ts";
import { runTool } from "./ffmpeg.ts";
import * as Files from "./files.ts";
import { fixtureLibrary, MEDIA_TEST_TIMEOUT, temporaryDirectory } from "./testing/fixtures.ts";
import { runScoped } from "./testing/run.ts";
import { readTrackTags } from "./tag-reader.ts";

describe("readTrackTags", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("reads tags, format details, and the embedded cover", () =>
    runScoped(
      Effect.gen(function* () {
        const { root } = yield* fixtureLibrary;
        const tags = yield* readTrackTags(join(root, "Aurora Tones/First Light/01 Dawn.flac"));

        expect(tags).toMatchObject({
          title: "Dawn",
          artist: "Aurora Tones",
          albumArtist: "Aurora Tones",
          album: "First Light",
          trackNumber: 1,
          discNumber: 1,
          year: 2021,
          genre: "Ambient",
          codec: "flac",
          lossless: true,
          sampleRate: 44_100,
          bitDepth: 16,
        });
        expect(tags.durationMs).toBeGreaterThan(3900);
        expect(tags.durationMs).toBeLessThan(4100);
        expect(imageContentType(tags.picture ?? new Uint8Array())).toBe("image/png");
      }),
    ));

  it("leaves blank and missing tags out, and reads a lossy file's bitrate", () =>
    runScoped(
      Effect.gen(function* () {
        const dir = yield* temporaryDirectory("tags");
        const path = join(dir, "blank.mp3");

        yield* runTool("ffmpeg", [
          "-v",
          "error",
          "-f",
          "lavfi",
          "-i",
          "sine=frequency=330:duration=2",
          "-map_metadata",
          "-1",
          "-metadata",
          "title=   ",
          "-metadata",
          "artist=  Someone  ",
          "-c:a",
          "libmp3lame",
          "-b:a",
          "128k",
          path,
        ]);

        const tags = yield* readTrackTags(path);

        expect(tags).toMatchObject({
          title: undefined,
          artist: "Someone",
          album: undefined,
          trackNumber: undefined,
          year: undefined,
          codec: "mp3",
          lossless: false,
          bitrate: 128_000,
          picture: undefined,
        });
      }),
    ));

  it("fails for a file that is not audio, and for one that is gone", () =>
    runScoped(
      Effect.gen(function* () {
        const dir = yield* temporaryDirectory("tags");
        const junk = join(dir, "junk.flac");

        yield* Files.writeFileAtomic(junk, new TextEncoder().encode("not audio at all"), "w");

        const notAudio = yield* Effect.flip(readTrackTags(junk));
        const gone = yield* Effect.flip(readTrackTags(join(dir, "gone.flac")));

        expect(notAudio.message).toBe(`Could not read tags: ${junk}`);
        expect(gone.message).toBe(`Could not read tags: ${join(dir, "gone.flac")}`);
      }),
    ));
});
