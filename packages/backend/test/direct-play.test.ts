import { playsDirectly as contractsPlaysDirectly } from "@media/contracts/direct-play";
import type { DirectPlayFile } from "@media/contracts/direct-play";
import type { ClientCapabilities } from "@media/contracts/media-playback";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { playsDirectly } from "../convex/lib/directPlay";

const codecs = fc.constantFrom("h264", "hevc", "HEVC", "hvc1", "av1", "vp9", "mpeg2video");

const audioCodecs = fc.constantFrom("aac", "mp4a", "ac3", "ac-3", "eac3", "opus", "dts", "mp2");

const ranges = fc.constantFrom(
  "sdr" as const,
  "hdr10" as const,
  "hlg" as const,
  "dolby-vision" as const,
);

const containers = fc.constantFrom(
  "mp4" as const,
  "mov" as const,
  "mkv" as const,
  "webm" as const,
  "avi" as const,
  "ts" as const,
  "other" as const,
);

const clients: fc.Arbitrary<ClientCapabilities> = fc.record({
  containers: fc.uniqueArray(containers, { maxLength: 4 }),
  videoCodecs: fc.array(
    fc.record(
      {
        codec: codecs,
        profiles: fc.array(fc.constantFrom("Main", "Main 10", "High"), { maxLength: 2 }),
        maxLevel: fc.integer({ min: 30, max: 160 }),
        maxBitDepth: fc.constantFrom(8, 10, 12),
        dynamicRanges: fc.uniqueArray(ranges, { maxLength: 3 }),
      },
      { requiredKeys: ["codec"] },
    ),
    { maxLength: 3 },
  ),
  audioCodecs: fc.array(
    fc.record(
      { codec: audioCodecs, maxChannels: fc.constantFrom(2, 6, 8) },
      { requiredKeys: ["codec"] },
    ),
    { maxLength: 3 },
  ),
  maxWidth: fc.constantFrom(1920, 3840),
  maxHeight: fc.constantFrom(1080, 2160),
  hls: fc.boolean(),
  mse: fc.boolean(),
});

const files: fc.Arbitrary<DirectPlayFile> = fc.record({
  container: fc.oneof(containers, fc.constant("flv")),
  video: fc.option(
    fc.record(
      {
        codec: codecs,
        profile: fc.constantFrom("Main", "main 10", "High", "Baseline"),
        level: fc.integer({ min: 30, max: 160 }),
        bitDepth: fc.constantFrom(8, 10, 12),
        width: fc.constantFrom(720, 1920, 3840, 7680),
        height: fc.constantFrom(576, 1080, 2160, 4320),
        dynamicRange: ranges,
      },
      { requiredKeys: ["codec", "bitDepth", "width", "height", "dynamicRange"] },
    ),
    { nil: undefined },
  ),
  audio: fc.option(fc.record({ codec: audioCodecs, channels: fc.integer({ min: 1, max: 8 }) }), {
    nil: undefined,
  }),
});

const filesFor = (client: ClientCapabilities): fc.Arbitrary<DirectPlayFile> => {
  const support = client.videoCodecs[0];
  const audio = client.audioCodecs[0];

  return fc.record({
    container: fc.constantFrom(...client.containers, "mkv"),
    video: fc.record({
      codec: fc.constant(support?.codec ?? "h264"),
      profile: fc.constantFrom(support?.profiles?.[0], undefined, "High 4:4:4"),
      level: fc.constantFrom(undefined, 30, 153),
      bitDepth: fc.constantFrom(8, 10),
      width: fc.constantFrom(1280, 3840),
      height: fc.constantFrom(720, 2160),
      dynamicRange: fc.constantFrom("sdr" as const, support?.dynamicRanges?.[0] ?? "hdr10"),
    }),
    audio: fc.constantFrom(
      undefined,
      audio === undefined ? undefined : { codec: audio.codec, channels: 2 },
      { codec: "truehd", channels: 8 },
    ),
  });
};

const pairs = fc.oneof(
  fc.tuple(clients, files),
  clients.chain((client) => fc.tuple(fc.constant(client), filesFor(client))),
);

describe("direct play in Convex", () => {
  it("decides every file and client as the contracts the media service negotiates with do", () => {
    fc.assert(
      fc.property(pairs, ([client, file]) => {
        expect(playsDirectly(client, file)).toBe(contractsPlaysDirectly(client, file));
      }),
      { numRuns: 2_000 },
    );

    const answers = fc
      .sample(pairs, 2_000)
      .map(([client, file]) => contractsPlaysDirectly(client, file));

    expect(new Set(answers)).toStrictEqual(new Set([true, false]));
  });
});
