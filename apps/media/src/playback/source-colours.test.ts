import { assert, describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import FIXTURES from "../media/ffprobe-fixtures/colours.json" with { type: "json" };
import { parseFfprobeJson, type VideoStream } from "../media/media-probe.ts";
import {
  COLOUR_DECISIONS,
  kindOf,
  SOURCE_KINDS,
  type SourceKind,
  sourceColour,
  tableLines,
} from "./source-colours.ts";

/**
 * ffprobe's output for one file of each kind, read with the probe's own arguments and trimmed to
 * what the probe reads: the Feature Test pattern clips generated for this table (HDR10, HLG, SDR in
 * BT.601, BT.2020, and full range), FFmpeg's test suite (Dolby Vision 7 and 8.1, an iPhone's 8.4,
 * an HDR10 Matroska with container metadata), and Apple's HLS example (Dolby Vision 5 and HDR10+).
 */
type FixtureName = keyof typeof FIXTURES;

/** Every fixture's name, as the JSON lists them. */
const NAMES: ReadonlyArray<FixtureName> = [
  "dolby-vision-5",
  "hdr10plus",
  "dolby-vision-8.4",
  "dolby-vision-8.1",
  "dolby-vision-7",
  "hdr10",
  "hlg",
  "sdr-bt601",
  "sdr-bt2020",
  "sdr-full-range",
  "hdr10-matroska",
];

const probed = (name: FixtureName) =>
  parseFfprobeJson(JSON.stringify(FIXTURES[name]), `/media/${name}.mkv`).pipe(
    Effect.map((probe) => {
      assert.isDefined(probe.video);

      return probe.video;
    }),
  );

describe("the table of source colours", () => {
  it("decides for every kind", () => {
    const lines = tableLines();

    const table = [
      "| kind | source | copied to a client that declares | Dolby Vision on a copy | decoded as | when encoded | why |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      ...lines.map((line) =>
        [
          "",
          line.kind,
          line.about,
          line.copiedTo === "sdr" ? "anything (SDR)" : line.copiedTo,
          line.dolbyVisionCopy,
          line.signal,
          line.encode,
          line.why,
          "",
        ].join(" | "),
      ),
    ].join("\n");

    console.info(`\n${table}\n`);
    expect(lines.map((line) => line.kind)).toStrictEqual(SOURCE_KINDS);

    expect(
      Object.fromEntries(lines.map((line) => [line.kind, [line.copiedTo, line.signal]])),
    ).toStrictEqual({
      sdr: ["sdr", "sdr"],
      "sdr-bt601": ["sdr", "sdr"],
      "sdr-bt2020": ["sdr", "sdr"],
      "sdr-full-range": ["sdr", "sdr"],
      hdr10: ["hdr10", "pq"],
      hdr10plus: ["hdr10", "pq"],
      hlg: ["hlg", "hlg"],
      "dolby-vision-5": ["dolby-vision", "dovi"],
      "dolby-vision-7": ["hdr10", "pq"],
      "dolby-vision-8.1": ["dolby-vision or hdr10", "pq"],
      "dolby-vision-8.2": ["dolby-vision or sdr", "sdr"],
      "dolby-vision-8.4": ["dolby-vision or hlg", "hlg"],
      "dolby-vision-other": ["dolby-vision", "dovi"],
    });
  });

  it.effect("reads each kind from ffprobe's own output", () =>
    Effect.gen(function* () {
      const kinds: Partial<Record<FixtureName, SourceKind>> = {};

      for (const name of NAMES) kinds[name] = kindOf(yield* probed(name));

      expect(kinds).toStrictEqual({
        "dolby-vision-5": "dolby-vision-5",
        hdr10plus: "hdr10plus",
        "dolby-vision-8.4": "dolby-vision-8.4",
        "dolby-vision-8.1": "dolby-vision-8.1",
        "dolby-vision-7": "dolby-vision-7",
        hdr10: "hdr10",
        hlg: "hlg",
        "sdr-bt601": "sdr-bt601",
        "sdr-bt2020": "sdr-bt2020",
        "sdr-full-range": "sdr-full-range",
        "hdr10-matroska": "hdr10",
      });
    }),
  );

  it.effect("reads HDR10's static metadata from the first picture when MP4 keeps none", () =>
    Effect.gen(function* () {
      const hdr10Plus = yield* probed("hdr10plus");

      expect(hdr10Plus.colour).toStrictEqual({
        transfer: "smpte2084",
        primaries: "bt2020",
        matrix: "bt2020nc",
        range: "limited",
        chromaLocation: "topleft",
        mastering: { minLuminance: 0.005, maxLuminance: 1000 },
        contentLight: { maxCll: 1375, maxFall: 188 },
      });
      expect(hdr10Plus.hdr10Plus).toBe(true);
      expect(sourceColour(hdr10Plus)).toStrictEqual({
        signal: "pq",
        transfer: "smpte2084",
        primaries: "bt2020",
        matrix: "bt2020nc",
        range: "limited",
        mastering: "present",
      });
    }),
  );

  it.effect("reads a Dolby Vision configuration and what its base layer is", () =>
    Effect.gen(function* () {
      const dolbyVision: Record<string, VideoStream["dolbyVision"]> = {};

      for (const name of [
        "dolby-vision-5",
        "dolby-vision-7",
        "dolby-vision-8.1",
        "dolby-vision-8.4",
      ] as const) {
        dolbyVision[name] = (yield* probed(name)).dolbyVision;
      }

      expect(dolbyVision).toStrictEqual({
        "dolby-vision-5": { profile: 5, level: 3, compatibility: 0 },
        "dolby-vision-7": { profile: 7, level: 6, compatibility: 6 },
        "dolby-vision-8.1": { profile: 8, level: 4, compatibility: 1 },
        "dolby-vision-8.4": { profile: 8, level: 4, compatibility: 4 },
      });

      const ipt = yield* probed("dolby-vision-5");

      expect(ipt.dynamicRange).toBe("dolby-vision");
      expect(sourceColour(ipt).signal).toBe("dovi");
      expect(sourceColour(yield* probed("dolby-vision-8.4")).signal).toBe("hlg");
    }),
  );

  it.effect("reads SDR's matrix, primaries, and range as the stream states them", () =>
    Effect.gen(function* () {
      const bt601 = yield* probed("sdr-bt601");
      const full = yield* probed("sdr-full-range");

      expect([bt601.colour?.matrix, bt601.colour?.primaries]).toStrictEqual([
        "smpte170m",
        "smpte170m",
      ]);
      expect(sourceColour(full)).toMatchObject({ signal: "sdr", range: "full" });
      expect(sourceColour(yield* probed("sdr-bt2020"))).toMatchObject({
        signal: "sdr",
        primaries: "bt2020",
      });
    }),
  );

  it("decides a Dolby Vision stream whose configuration was not read as profile 5", () => {
    const unread: VideoStream = {
      index: 0,
      codec: "hevc",
      bitDepth: 10,
      width: 3840,
      height: 2160,
      dynamicRange: "dolby-vision",
    };

    expect(kindOf(unread)).toBe("dolby-vision-other");
    expect(COLOUR_DECISIONS[kindOf(unread)].signal).toBe(COLOUR_DECISIONS["dolby-vision-5"].signal);
  });
});
