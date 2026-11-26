import * as fc from "fast-check";
import { Exit, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { EvidenceReason, ServerReport } from "./server-functions";
import { EpochMillis } from "./units";

/** `value` as the wire carries it and read back. */
const overTheWire = <A, I>(schema: Schema.Codec<A, I>, value: A): A => {
  const codec = Schema.toCodecJson(schema);

  return Schema.decodeUnknownSync(codec)(
    JSON.parse(JSON.stringify(Schema.encodeSync(codec)(value))),
  );
};

const instant = fc
  .integer({ min: 0, max: 8_640_000_000_000_000 })
  .map((at) => EpochMillis.make(at));

const text = fc.string({ maxLength: 40 });

const report = fc.record({
  version: text,
  activeStreams: fc.nat(),
  runsAwaitingExit: fc.nat(),
  startedAt: instant,
  transcoding: fc.record({
    build: fc.option(
      fc.record({ version: fc.option(text, { nil: null }), kernel: text, checkedAt: instant }),
      { nil: null },
    ),
    devices: fc.array(
      fc.record({
        domain: text,
        node: text,
        opened: fc.boolean(),
        pci: fc.option(text, { nil: null }),
        kernelDriver: fc.option(text, { nil: null }),
        userDriver: fc.option(text, { nil: null }),
        checkedAt: instant,
      }),
      { maxLength: 3 },
    ),
    capabilities: fc.array(
      fc.record({
        key: text,
        domain: text,
        status: fc.constantFrom("unknown" as const, "verified" as const, "unsupported" as const),
        source: fc.constantFrom("listing" as const, "probe" as const, null),
        checkedAt: fc.option(instant, { nil: null }),
        reason: fc.option(fc.constantFrom(...EvidenceReason.literals), { nil: null }),
        quarantineEndsAt: fc.oneof(instant, fc.constant("restart" as const), fc.constant(null)),
      }),
      { maxLength: 6 },
    ),
  }),
});

/** Whether a report listing one capability with `status` and `reason` decodes. */
const decodesWith = (status: string, reason: string): boolean =>
  Exit.isSuccess(
    Schema.decodeUnknownExit(ServerReport)({
      version: "0.9.0",
      activeStreams: 0,
      runsAwaitingExit: 0,
      startedAt: 1,
      transcoding: {
        build: null,
        devices: [],
        capabilities: [
          {
            key: "encode.qsv:h264/8/cbr",
            domain: "qsv",
            status,
            source: "probe",
            checkedAt: 1,
            reason,
            quarantineEndsAt: null,
          },
        ],
      },
    }),
  );

describe("ServerReport", () => {
  it("comes back over the wire as it went, with its transcoding report", () => {
    fc.assert(
      fc.property(report, (value) => {
        expect(overTheWire(ServerReport, value)).toEqual(value);
      }),
    );
  });

  it("refuses a capability status or reason outside its closed list", () => {
    expect(decodesWith("verified", "passed")).toBe(true);
    expect(decodesWith("maybe", "passed")).toBe(false);
    expect(decodesWith("verified", "rejected: Error opening /media/movie.mkv")).toBe(false);
  });
});
