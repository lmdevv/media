import { join } from "node:path";

import { LyricBody } from "@music/commands/lyrics";
import { Effect } from "effect";
import {
  type IAudioMetadata,
  type ILyricsTag,
  LyricsContentType,
  parseFile,
  TimestampFormat,
} from "music-metadata";
import { describe, expect, it } from "vitest";

import { runTool } from "../ffmpeg.ts";
import * as Files from "../files.ts";
import { MEDIA_TEST_TIMEOUT, temporaryDirectory } from "../testing/fixtures.ts";
import { runScoped } from "../testing/run.ts";
import { embeddedLyrics } from "./embedded.ts";

const LRC = "[00:01.00]Hello\n[00:02.50]<00:02.50>Wor<00:02.80>ld<00:03.20>";

/** A one-second sine in `name`, encoded by ffmpeg with `metadata` as `key=value` tags. */
const encode = (dir: string, name: string, codec: string, metadata: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = join(dir, name);

    yield* runTool("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      ...metadata.flatMap((tag) => ["-metadata", tag]),
      "-c:a",
      codec,
      path,
    ]);

    return path;
  });

const lyricsOf = (path: string) =>
  Effect.promise(() => parseFile(path, { duration: false, skipCovers: true })).pipe(
    Effect.map(embeddedLyrics),
  );

const encoder = new TextEncoder();

const syncsafe = (size: number): Uint8Array =>
  Uint8Array.of((size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f);

const concat = (parts: ReadonlyArray<Uint8Array>): Uint8Array => {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;

  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }

  return bytes;
};

/** An ID3v2.4 frame with UTF-8 text (encoding byte 3). */
const frame = (id: string, body: ReadonlyArray<Uint8Array>): Uint8Array => {
  const content = concat(body);

  return concat([encoder.encode(id), syncsafe(content.length), Uint8Array.of(0, 0), content]);
};

const uslt = (language: string, text: string) =>
  frame("USLT", [
    Uint8Array.of(3),
    encoder.encode(language),
    Uint8Array.of(0),
    encoder.encode(text),
  ]);

/**
 * `SYLT` with `format` 1 (MPEG frames) or 2 (milliseconds), and ID3 content type 1 (lyrics)
 * unless `contentType` names another.
 */
const sylt = (
  language: string,
  format: 1 | 2,
  entries: ReadonlyArray<readonly [number, string]>,
  contentType = 1,
) =>
  frame("SYLT", [
    Uint8Array.of(3),
    encoder.encode(language),
    Uint8Array.of(format, contentType, 0),
    ...entries.flatMap(([time, text]) => {
      const stamp = new Uint8Array(4);

      new DataView(stamp.buffer).setUint32(0, time);

      return [encoder.encode(text), Uint8Array.of(0), stamp];
    }),
  ]);

/** An MP3 whose ID3v2.4 tag holds `frames`; ffmpeg cannot write `USLT` or `SYLT` itself. */
const mp3WithFrames = (dir: string, frames: ReadonlyArray<Uint8Array>) =>
  Effect.gen(function* () {
    const bare = yield* encode(dir, "bare.mp3", "libmp3lame", []);
    const audio = yield* Files.readWholeFile(bare);
    const body = concat(frames);
    const path = join(dir, "tagged.mp3");
    const header = concat([encoder.encode("ID3"), Uint8Array.of(4, 0, 0), syncsafe(body.length)]);

    yield* Files.writeFileAtomic(path, concat([header, body, audio]), "w");

    return path;
  });

describe("embeddedLyrics", { timeout: MEDIA_TEST_TIMEOUT }, () => {
  it("reads ID3 USLT, SYLT in milliseconds, and SYLT in MPEG frames as plain text", () =>
    runScoped(
      Effect.gen(function* () {
        const dir = yield* temporaryDirectory("lyrics");

        const path = yield* mp3WithFrames(dir, [
          uslt("eng", "Line one\nLine two"),
          sylt("deu", 2, [
            [1000, "Hallo"],
            [2500, "Welt"],
          ]),
          sylt("fra", 1, [
            [40, "Bonjour"],
            [90, "Monde"],
          ]),
        ]);

        expect(yield* lyricsOf(path)).toEqual([
          {
            kind: "main",
            lang: "en",
            origin: { _tag: "Embedded", tag: "id3:USLT" },
            body: { _tag: "Plain", text: "Line one\nLine two" },
          },
          {
            kind: "main",
            lang: "de",
            origin: { _tag: "Embedded", tag: "id3:SYLT" },
            body: {
              _tag: "Synced",
              lines: [
                { text: "Hallo", startMs: 1000, endMs: null, words: null, voice: null },
                { text: "Welt", startMs: 2500, endMs: null, words: null, voice: null },
              ],
            },
          },
          {
            kind: "main",
            lang: "fr",
            origin: { _tag: "Embedded", tag: "id3:SYLT" },
            body: { _tag: "Plain", text: "Bonjour\nMonde" },
          },
        ]);
      }),
    ));

  it("reads LRC pasted into USLT as timed lyrics, and syllable SYLT as word timing", () =>
    runScoped(
      Effect.gen(function* () {
        const dir = yield* temporaryDirectory("lyrics");

        const path = yield* mp3WithFrames(dir, [
          uslt("XXX", LRC),
          sylt("eng", 2, [
            [1000, "Hel"],
            [1300, "lo"],
            [2000, "\nworld"],
          ]),
        ]);

        const [fromUslt, fromSylt] = yield* lyricsOf(path);

        expect(fromUslt).toMatchObject({
          lang: null,
          body: {
            lines: [
              { text: "Hello", startMs: 1000, words: null },
              {
                text: "World",
                startMs: 2500,
                endMs: 3200,
                words: [
                  { text: "Wor", startMs: 2500, endMs: 2800 },
                  { text: "ld", startMs: 2800, endMs: 3200 },
                ],
              },
            ],
          },
        });
        expect(fromSylt).toMatchObject({
          body: {
            lines: [
              {
                text: "Hello",
                startMs: 1000,
                words: [
                  { text: "Hel", startMs: 1000, endMs: null },
                  { text: "lo", startMs: 1300, endMs: null },
                ],
              },
              { text: "world", startMs: 2000, words: null },
            ],
          },
        });
      }),
    ));

  it("reads SYLT lyrics and transcriptions only, and one entry per line as line timing", () =>
    runScoped(
      Effect.gen(function* () {
        const dir = yield* temporaryDirectory("lyrics");

        const path = yield* mp3WithFrames(dir, [
          sylt(
            "eng",
            2,
            [
              [1000, "Am"],
              [2000, "G"],
            ],
            5,
          ),
          sylt(
            "eng",
            2,
            [
              [1000, "Spoken"],
              [2000, "\nWords"],
            ],
            2,
          ),
          sylt(
            "eng",
            2,
            [
              [3000, "Trivia"],
              [4000, "Facts"],
            ],
            6,
          ),
        ]);

        expect(yield* lyricsOf(path)).toEqual([
          {
            kind: "main",
            lang: "en",
            origin: { _tag: "Embedded", tag: "id3:SYLT" },
            body: {
              _tag: "Synced",
              lines: [
                { text: "Spoken", startMs: 1000, endMs: null, words: null, voice: null },
                { text: "Words", startMs: 2000, endMs: null, words: null, voice: null },
              ],
            },
          },
        ]);
      }),
    ));

  it("skips a lyrics tag larger than a lyric file may be", () =>
    runScoped(
      Effect.gen(function* () {
        const dir = yield* temporaryDirectory("lyrics");

        const path = yield* mp3WithFrames(dir, [
          uslt("eng", "x".repeat(256 * 1024 + 1)),
          uslt("deu", "Klein"),
        ]);

        expect(yield* lyricsOf(path)).toMatchObject([{ lang: "de", body: { text: "Klein" } }]);
      }),
    ));

  it("reads lyrics ffmpeg writes to ID3 TXXX frames", () =>
    runScoped(
      Effect.gen(function* () {
        const dir = yield* temporaryDirectory("lyrics");
        const path = yield* encode(dir, "txxx.mp3", "libmp3lame", ["lyrics-eng=Plain words"]);

        expect(yield* lyricsOf(path)).toEqual([
          {
            kind: "main",
            lang: "en",
            origin: { _tag: "Embedded", tag: "other" },
            body: { _tag: "Plain", text: "Plain words" },
          },
        ]);
      }),
    ));

  it("reads Vorbis LYRICS, UNSYNCEDLYRICS, and SYNCEDLYRICS, keeping repeats once", () =>
    runScoped(
      Effect.gen(function* () {
        const dir = yield* temporaryDirectory("lyrics");

        const path = yield* encode(dir, "song.flac", "flac", [
          `LYRICS=${LRC}`,
          "UNSYNCEDLYRICS=Plain one\r\nPlain two",
          `SYNCEDLYRICS=${LRC}`,
        ]);

        const sets = yield* lyricsOf(path);

        expect(sets.map((set) => [set.origin, LyricBody.guards.Synced(set.body)])).toEqual([
          [{ _tag: "Embedded", tag: "vorbis:LYRICS" }, true],
          [{ _tag: "Embedded", tag: "vorbis:UNSYNCEDLYRICS" }, false],
        ]);
        expect(sets[0]).toMatchObject({ body: { lines: [{}, { words: [{ text: "Wor" }, {}] }] } });
        expect(sets[1]).toMatchObject({ body: { text: "Plain one\nPlain two" } });
      }),
    ));

  it("skips a lyrics tag whose stamps are too large to represent, and reads the others", () =>
    runScoped(
      Effect.gen(function* () {
        const dir = yield* temporaryDirectory("lyrics");

        const path = yield* encode(dir, "song.flac", "flac", [
          `LYRICS=[${"9".repeat(310)}:01]Broken`,
          "UNSYNCEDLYRICS=Plain words",
        ]);

        expect((yield* lyricsOf(path)).map((set) => [set.origin, set.body])).toEqual([
          [
            { _tag: "Embedded", tag: "vorbis:UNSYNCEDLYRICS" },
            { _tag: "Plain", text: "Plain words" },
          ],
        ]);
      }),
    ));

  it("reads MP4 ©lyr", () =>
    runScoped(
      Effect.gen(function* () {
        const dir = yield* temporaryDirectory("lyrics");
        const path = yield* encode(dir, "song.m4a", "aac", ["lyrics=Just text"]);

        expect(yield* lyricsOf(path)).toEqual([
          {
            kind: "main",
            lang: null,
            origin: { _tag: "Embedded", tag: "mp4:lyr" },
            body: { _tag: "Plain", text: "Just text" },
          },
        ]);
      }),
    ));

  it("reads nothing from a song without lyrics or with a blank lyrics tag", () =>
    runScoped(
      Effect.gen(function* () {
        const dir = yield* temporaryDirectory("lyrics");
        const none = yield* encode(dir, "none.flac", "flac", ["TITLE=Song"]);
        const blank = yield* encode(dir, "blank.opus", "libopus", ["LYRICS=   "]);

        expect(yield* lyricsOf(none)).toEqual([]);
        expect(yield* lyricsOf(blank)).toEqual([]);
      }),
    ));
});

/** What `music-metadata` reports for a tag format it maps only to common `lyrics`, such as APE. */
const commonOnly = (lyrics: Array<ILyricsTag>, native: IAudioMetadata["native"] = {}) =>
  embeddedLyrics({
    common: {
      track: { no: null, of: null },
      disk: { no: null, of: null },
      movementIndex: { no: null, of: null },
      lyrics,
    },
    native,
  });

describe("embeddedLyrics: common lyrics", () => {
  const apeTitle = { APEv2: [{ id: "Title", value: "Song" }] };

  it("reads synchronized lyrics timed in milliseconds as timed lyrics", () => {
    const sets = commonOnly(
      [
        {
          contentType: LyricsContentType.lyrics,
          timeStampFormat: TimestampFormat.milliseconds,
          language: "eng",
          text: "Hello\nWorld",
          syncText: [
            { text: "Hello", timestamp: 1000 },
            { text: "World", timestamp: 2500 },
          ],
        },
      ],
      apeTitle,
    );

    expect(sets).toEqual([
      {
        kind: "main",
        lang: "en",
        origin: { _tag: "Embedded", tag: "other" },
        body: {
          _tag: "Synced",
          lines: [
            { text: "Hello", startMs: 1000, endMs: null, words: null, voice: null },
            { text: "World", startMs: 2500, endMs: null, words: null, voice: null },
          ],
        },
      },
    ]);
  });

  it("reads lyrics timed in MPEG frames as plain text", () => {
    const frames = {
      contentType: LyricsContentType.text,
      timeStampFormat: TimestampFormat.mpegFrameNumber,
      syncText: [
        { text: "Hello", timestamp: 38 },
        { text: "World", timestamp: 96 },
      ],
    };

    expect(commonOnly([frames]).map((set) => set.body)).toEqual([
      { _tag: "Plain", text: "Hello\nWorld" },
    ]);
    expect(commonOnly([{ ...frames, text: "Whole text" }]).map((set) => set.body)).toEqual([
      { _tag: "Plain", text: "Whole text" },
    ]);
  });

  it("skips chords, events, and other text that is not lyrics", () => {
    expect(
      commonOnly([
        {
          contentType: LyricsContentType.chord,
          timeStampFormat: TimestampFormat.milliseconds,
          syncText: [{ text: "Am", timestamp: 1000 }],
        },
      ]),
    ).toEqual([]);
  });

  it("is not read when a native tag holds lyrics", () => {
    const common: ILyricsTag = {
      contentType: LyricsContentType.lyrics,
      timeStampFormat: TimestampFormat.notSynchronized,
      text: "Common words",
      syncText: [],
    };

    expect(commonOnly([common], apeTitle).map((set) => set.body)).toEqual([
      { _tag: "Plain", text: "Common words" },
    ]);
    expect(
      commonOnly([common], { vorbis: [{ id: "LYRICS", value: "Native words" }] }).map((set) => [
        set.origin,
        set.body,
      ]),
    ).toEqual([
      [
        { _tag: "Embedded", tag: "vorbis:LYRICS" },
        { _tag: "Plain", text: "Native words" },
      ],
    ]);
  });
});
