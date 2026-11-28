import { describe, expect, it } from "vitest";

import { meteredOf, transferGate } from "./transfer-gate";
import type { StartedBy, TransferGate } from "./transfer-gate";

const BOTH = [false, true] as const;

const STARTERS: ReadonlyArray<StartedBy> = ["person", "sync"];

describe("transferGate", () => {
  it("decides every combination of network, setting, Low Power Mode, and starter", () => {
    const table: Array<string> = [];

    for (const metered of BOTH) {
      for (const wifiOnly of BOTH) {
        for (const lowPower of BOTH) {
          for (const startedBy of STARTERS) {
            const gate: TransferGate = transferGate({ metered, wifiOnly, lowPower }, startedBy);

            table.push(
              `${metered ? "metered" : "free"} ${wifiOnly ? "wifi-only" : "any"} ${
                lowPower ? "low-power" : "power"
              } ${startedBy} -> ${gate}`,
            );
          }
        }
      }
    }

    expect(table).toStrictEqual([
      "free any power person -> run",
      "free any power sync -> run",
      "free any low-power person -> run",
      "free any low-power sync -> power",
      "free wifi-only power person -> run",
      "free wifi-only power sync -> run",
      "free wifi-only low-power person -> run",
      "free wifi-only low-power sync -> power",
      "metered any power person -> run",
      "metered any power sync -> run",
      "metered any low-power person -> run",
      "metered any low-power sync -> power",
      "metered wifi-only power person -> wifi",
      "metered wifi-only power sync -> wifi",
      "metered wifi-only low-power person -> wifi",
      "metered wifi-only low-power sync -> wifi",
    ]);
  });
});

describe("meteredOf", () => {
  it("counts cellular, a personal hotspot, Low Data Mode, and an unreported network", () => {
    expect(meteredOf(null)).toBe(true);
    expect(meteredOf({ connected: true, expensive: false, constrained: false })).toBe(false);
    expect(meteredOf({ connected: true, expensive: true, constrained: false })).toBe(true);
    expect(meteredOf({ connected: true, expensive: false, constrained: true })).toBe(true);
    expect(meteredOf({ connected: true, expensive: true, constrained: true })).toBe(true);
  });
});
