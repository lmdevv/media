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
 * ffprobe's output for one file of each kind, read with the probe's own two runs and trimmed to
 * what the probe reads: clips generated for this table (HDR10, HLG, SDR in BT.601, BT.2020, and full
 * range), FFmpeg's test suite (Dolby Vision 7 and 8.1, an iPhone's 8.4 with its ambient viewing
 * environment, an HDR10 Matroska with container metadata), and Apple's HLS example (Dolby Vision 5
 * and HDR10+).
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

/** What a table line's ranges say a client must declare, in words. */
const DECLARED: ReadonlyMap<string, string> = new Map([
  ["sdr", "anything (SDR)"],
  ["", "nothing"],
]);

const declared = (ranges: string): string => DECLARED.get(ranges) ?? ranges;

/**
 * The probe of fixture `name` with its Dolby Vision record edited to say 8.1 (HDR10), as a file whose
 * record and pictures disagree: an iPhone's 8.4 states HLG, Apple's profile 5 no transfer at all.
 */
const relabelled = (name: "dolby-vision-8.4" | "dolby-vision-5") =>
  parseFfprobeJson(
    JSON.stringify(FIXTURES[name]).replace(
      /"dv_profile":\s*\d+,\s*"dv_level":\s*(\d+),\s*"dv_bl_signal_compatibility_id":\s*\d+/u,
      '"dv_profile": 8, "dv_level": $1, "dv_bl_signal_compatibility_id": 1',
    ),
    `/media/${name}-as-8.1.mkv`,
  );

/** Profile 8 of `compatibility` over `colour`, its first picture carrying no RPU. */
const profile8 = (
  compatibility: number,
  colour: NonNullable<VideoStream["colour"]>,
): VideoStream => ({
  index: 0,
  codec: "hevc",
  bitDepth: 10,
  width: 3840,
  height: 2160,
  dynamicRange: "dolby-vision",
  colour,
  dolbyVision: { profile: 8, level: 6, compatibility },
});

describe("the table of source colours", () => {
  it("decides for every kind", () => {
    const lines = tableLines();

    const table = [
      "| kind | source | played as stored by a client that declares | copied to a client that declares | Dolby Vision on a copy | decoded as | encoded for an HDR screen as | when encoded for SDR | why |",
      "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
      ...lines.map((line) =>
        [
          "",
          line.kind,
          line.about,
          declared(line.directPlayTo),
          declared(line.copiedTo),
          line.dolbyVisionCopy,
          line.signal,
          line.keeps === "none" ? "SDR" : `HEVC Main 10 ${line.keeps}`,
          line.encode,
          line.why,
          "",
        ].join(" | "),
      ),
    ].join("\n");

    console.info(`\n${table}\n`);
    expect(lines.map((line) => line.kind)).toStrictEqual(SOURCE_KINDS);

    expect(
      Object.fromEntries(
        lines.map((line) => [
          line.kind,
          [line.directPlayTo, line.copiedTo, line.signal, line.keeps],
        ]),
      ),
    ).toStrictEqual({
      sdr: ["sdr", "sdr", "sdr", "none"],
      "sdr-bt601": ["sdr", "sdr", "sdr", "none"],
      "sdr-bt2020": ["sdr", "sdr", "sdr", "none"],
      "sdr-full-range": ["sdr", "sdr", "sdr", "none"],
      hdr10: ["hdr10", "hdr10", "pq", "hdr10"],
      hdr10plus: ["hdr10", "hdr10", "pq", "hdr10"],
      hlg: ["hlg", "hlg", "hlg", "hlg"],
      "dolby-vision-5": ["dolby-vision", "dolby-vision", "dovi", "none"],
      "dolby-vision-7": ["", "hdr10", "pq", "hdr10"],
      "dolby-vision-8.1": ["dolby-vision", "dolby-vision or hdr10", "pq", "hdr10"],
      "dolby-vision-8.2": ["dolby-vision", "dolby-vision or sdr", "sdr", "none"],
      "dolby-vision-8.4": ["dolby-vision", "dolby-vision or hlg", "hlg", "hlg"],
      "dolby-vision-other": ["", "", "dovi", "none"],
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
        mastering: {
          minLuminance: 0.005,
          maxLuminance: 1000,
          primaries: {
            red: { x: 0.708, y: 0.292 },
            green: { x: 0.17, y: 0.797 },
            blue: { x: 0.131, y: 0.046 },
            whitePoint: { x: 0.3127, y: 0.329 },
          },
        },
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
      expect(ipt.dolbyVisionRpu).toBe(true);
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

  it("believes a Dolby Vision record only where the stream states its base layer's transfer, for every id", () => {
    const transfers = ["smpte2084", "arib-std-b67", "bt709", "smpte170m", "bt2020-10", undefined];

    const sdrTransfers: ReadonlySet<string | undefined> = new Set([
      "bt709",
      "smpte170m",
      "bt2020-10",
    ]);

    // The rule, read off the record and the stream: each base layer an id names needs its transfer.
    const believed = (profile: number, compatibility: number, transfer: string | undefined) => {
      if (profile === 7 && compatibility === 6 && transfer === "smpte2084") return "dolby-vision-7";

      if (profile !== 8) return "dolby-vision-other";

      if (compatibility === 1 && transfer === "smpte2084") return "dolby-vision-8.1";

      if (compatibility === 4 && transfer === "arib-std-b67") return "dolby-vision-8.4";

      return compatibility === 2 && sdrTransfers.has(transfer)
        ? "dolby-vision-8.2"
        : "dolby-vision-other";
    };

    for (const profile of [7, 8]) {
      for (let compatibility = 0; compatibility < 16; compatibility += 1) {
        for (const transfer of transfers) {
          const video: VideoStream = {
            index: 0,
            codec: "hevc",
            bitDepth: 10,
            width: 3840,
            height: 2160,
            dynamicRange: "dolby-vision",
            colour: transfer === undefined ? {} : { transfer },
            dolbyVision: { profile, level: 6, compatibility },
            dolbyVisionRpu: true,
          };

          expect(
            kindOf(video),
            `${String(profile)}.${String(compatibility)} over ${transfer ?? "no transfer"}`,
          ).toBe(believed(profile, compatibility, transfer));
        }
      }
    }
  });

  it.effect(
    "reads a real file whose record names another base layer than its pictures as no kind it names",
    () =>
      Effect.gen(function* () {
        for (const name of ["dolby-vision-8.4", "dolby-vision-5"] as const) {
          const video = (yield* relabelled(name)).video;

          assert.isDefined(video);
          expect(video.dolbyVision?.compatibility, name).toBe(1);
          expect(kindOf(video), name).toBe("dolby-vision-other");
        }
      }),
  );

  it("reads profile 8 without an RPU on its first picture as its base layer's own kind", () => {
    expect(kindOf(profile8(1, { transfer: "smpte2084", primaries: "bt2020" }))).toBe("hdr10");
    expect(kindOf(profile8(4, { transfer: "arib-std-b67", primaries: "bt2020" }))).toBe("hlg");
    expect(kindOf(profile8(2, { transfer: "bt709", primaries: "bt709" }))).toBe("sdr");
    expect(kindOf(profile8(2, { transfer: "bt2020-10", primaries: "bt2020" }))).toBe("sdr-bt2020");
  });

  it("decides a Dolby Vision stream whose configuration was not read as no kind it names", () => {
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
