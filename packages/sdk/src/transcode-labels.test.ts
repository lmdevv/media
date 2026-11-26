import { describe, expect, it } from "vitest";

import { TranscodeReason, TranscodeReasonCode } from "@media/contracts/media-playback";
import { Schema } from "effect";

import {
  capabilityCounts,
  causeLabel,
  devicesOf,
  domainLabel,
  reasonLabel,
  stageLabel,
} from "./transcode-labels";

const gpu = {
  node: "renderD128",
  opened: true,
  pci: "8086:56a5 rev 05",
  kernelDriver: "i915",
  userDriver: "Intel iHD driver 26.3.5",
};

describe("TranscodeLabels", () => {
  it("names stages, moves, domains, and causes, and passes a later backend's names through", () => {
    expect(stageLabel({ op: "tonemap", domain: "cpu", impl: "tonemap.cpu" })).toBe(
      "Tone map · CPU",
    );
    expect(
      stageLabel({
        op: "move",
        domain: "qsv",
        impl: "move.qsv>cpu",
        move: { from: "qsv", to: "cpu" },
      }),
    ).toBe("Move · QSV → CPU");
    expect(stageLabel({ op: "burn-image", domain: "cpu", impl: "burn-image.cpu" })).toBe(
      "Subtitle · CPU",
    );
    expect(stageLabel({ op: "deinterlace", domain: "nvenc", impl: "deinterlace.nvenc" })).toBe(
      "deinterlace · NVENC",
    );
    expect(domainLabel("vaapi")).toBe("VA-API");
    expect(causeLabel("capability")).toBe("stage failed");
    expect(causeLabel("driver-crash")).toBe("driver-crash");
  });

  it("names every reason a change or a failure can give apart", () => {
    const labels = TranscodeReason.literals.map(reasonLabel);

    expect(new Set(labels).size).toBe(TranscodeReason.literals.length);
    expect(reasonLabel("disk-full")).toBe("disk full");
  });

  it("names undecided as probes that could not tell, which a timeout or a probe with no frames leaves", () => {
    expect(reasonLabel("undecided")).toBe("probes inconclusive");
  });

  it("names a reason a newer server added as it names other", () => {
    const newer = Schema.decodeSync(TranscodeReasonCode)("driver-reset");

    expect(reasonLabel(newer)).toBe(reasonLabel("other"));
  });

  it("lists each GPU once with the APIs that opened it", () => {
    expect(
      devicesOf([
        { ...gpu, domain: "qsv" },
        { ...gpu, domain: "vaapi", opened: false, userDriver: null },
        {
          ...gpu,
          node: "renderD129",
          pci: null,
          kernelDriver: null,
          domain: "vaapi",
          opened: false,
        },
      ]),
    ).toEqual([
      {
        node: "renderD128",
        label: "8086:56a5 rev 05 · i915",
        apis: ["QSV"],
        driver: "Intel iHD driver 26.3.5",
      },
      { node: "renderD129", label: "renderD129", apis: [], driver: null },
    ]);
  });

  it("counts capabilities by status and keeps only quarantines still in force", () => {
    const now = 1_000_000;

    expect(
      capabilityCounts(
        [
          { key: "decode.qsv:h264/yuv420p", status: "verified", quarantineEndsAt: null },
          { key: "decode.qsv:h264/yuv420p10le", status: "unsupported", quarantineEndsAt: null },
          { key: "tonemap.qsv:pq", status: "unknown", quarantineEndsAt: now + 1 },
          { key: "encode.qsv:h264/8/cbr", status: "unknown", quarantineEndsAt: "restart" },
          { key: "scale.qsv:8>8", status: "verified", quarantineEndsAt: now },
        ],
        now,
      ),
    ).toEqual({
      verified: 2,
      unsupported: 1,
      unknown: 2,
      quarantined: [
        { key: "tonemap.qsv:pq", endsAt: now + 1 },
        { key: "encode.qsv:h264/8/cbr", endsAt: "restart" },
      ],
    });
  });
});
