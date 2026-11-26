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
import { transcodingReport } from "./transcode-diagnostics.ts";
import { capabilityKey, ImplId } from "./video-ops.ts";

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
