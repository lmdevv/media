import { assert, describe, it } from "@effect/vitest";

import { EpochMillis } from "@media/contracts/units";

import {
  capabilityOf,
  empty,
  Evidence,
  record,
  withBuild,
  withDevice,
} from "./capability-inventory.ts";
import { Result } from "effect";

import { VideoPlan } from "./playback-decision.ts";
import { summaryOf, transcodingReport } from "./transcode-diagnostics.ts";
import {
  candidateKeys,
  type CapabilitySnapshot,
  planVideo,
  type VideoIntent,
} from "./video-pipeline.ts";
import { capabilityKey, ImplId, sdrTarget, type SourceVideo } from "./video-ops.ts";

const AT = 1_760_000_000_000;

/** What the report says of a Quick Sync device whose driver line names `userDriver`. */
const reportedDriver = (userDriver: string): string | null | undefined =>
  transcodingReport(
    withDevice(empty, {
      domain: "qsv",
      node: "/dev/dri/renderD128",
      opened: true,
      pci: "8086:56a5 rev 05",
      kernelDriver: "i915",
      userDriver,
      at: AT,
    }),
    AT,
  ).devices[0]?.userDriver;

/** What the report says of a build whose version line is `version`. */
const reportedVersion = (version: string): string | null | undefined =>
  transcodingReport(
    withBuild(empty, { version, kernel: "6.18.63", features: new Set(), at: AT }),
    AT,
  ).build?.version;

describe("the transcoding report's identities", () => {
  it("names a driver by name and version alone, and none past 64 characters", () => {
    assert.strictEqual(
      reportedDriver("Intel iHD driver for Intel(R) Gen Graphics - 25.2.6 (/srv/a.mkv)"),
      "Intel iHD driver for Intel(R) Gen Graphics 25.2.6",
    );

    const long = `Intel iHD driver for Intel(R) Gen Graphics on a Card Named At Length - 25.2.6`;

    assert.isNull(reportedDriver(long));
    assert.isNull(reportedDriver("a line in some other form"));
  });

  it("names ffmpeg's version from its version line alone, and none past 64 characters", () => {
    assert.strictEqual(reportedVersion("ffmpeg version 9.0.2 Copyright (c) 2000-2026"), "9.0.2");
    assert.isNull(reportedVersion(`ffmpeg version ${"9".repeat(65)} Copyright`));
    assert.isNull(reportedVersion("built with gcc 14"));
  });
});

describe("the transcoding report's capabilities", () => {
  it("says a probe crashed, and when the key it set aside is probed again", () => {
    const key = capabilityKey(ImplId("decode.vaapi"), "mpeg2video/yuv420p");

    const crashed = Evidence.Probe({
      at: AT,
      outcome: "crashed",
      source: undefined,
      detail: "",
      millis: 150,
    });

    const inventory = record(empty, key, crashed, capabilityOf(empty, key).epoch);
    const [reported] = transcodingReport(inventory, AT).capabilities;

    assert.strictEqual(reported?.key, key);
    assert.strictEqual(reported?.source, "probe");
    assert.strictEqual(reported?.reason, "crashed");
    assert.strictEqual(reported?.quarantineEndsAt, EpochMillis.make(AT + 15 * 60_000));
  });
});

describe("the stage summary", () => {
  it("names the deinterlace stage and where it ran, a CPU one between moves included", () => {
    const source: SourceVideo = {
      codec: "mpeg2video",
      pixelFormat: "yuv420p",
      depth: 8,
      colour: "sdr",
      scan: "interlaced",
      width: 720,
      height: 576,
    };

    const intent: VideoIntent = {
      targets: [sdrTarget("h264")],
      frameRate: 25,
      bounds: { width: 1920, height: 1080 },
      cpuEncodeBounds: { width: 1920, height: 1080 },
      maxBitrate: undefined,
      burnImage: undefined,
    };

    const bound: CapabilitySnapshot = {
      domains: [{ domain: "vaapi", device: "/dev/dri/renderD128" }],
      verified: new Set(),
      excluded: new Set(),
    };

    const verified = new Set(candidateKeys(source, intent, bound).keys());

    const stagesWith = (excluded: ReadonlyArray<string>) => {
      const planned = planVideo(source, intent, {
        ...bound,
        verified,
        excluded: new Set(excluded.map((id) => ImplId(id))),
      });

      if (Result.isFailure(planned)) throw new Error(JSON.stringify(planned.failure));

      return summaryOf(VideoPlan.Encode({ intent, ...planned.success }), [], 1).stages;
    };

    assert.deepStrictEqual(stagesWith([]).slice(0, 2), [
      { op: "decode", domain: "vaapi", impl: "decode.vaapi" },
      { op: "deinterlace", domain: "vaapi", impl: "deinterlace.vaapi" },
    ]);
    assert.deepStrictEqual(stagesWith(["deinterlace.vaapi"]).slice(1, 4), [
      { op: "move", domain: "vaapi", impl: "move.vaapi>cpu", move: { from: "vaapi", to: "cpu" } },
      { op: "deinterlace", domain: "cpu", impl: "deinterlace.cpu" },
      { op: "move", domain: "vaapi", impl: "move.cpu>vaapi", move: { from: "cpu", to: "vaapi" } },
    ]);
  });
});
