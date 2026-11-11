import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { MOBILE_DATA_OPTIONS } from "../preferences";
import { mobileDataStep } from "./mobile-data";

const preference = fc.constantFrom(...MOBILE_DATA_OPTIONS.map((option) => option.value));

describe("mobile data", () => {
  it("plays off mobile data, and when the network can't be told, whatever the setting", () => {
    fc.assert(
      fc.property(
        preference,
        fc.constantFrom("other" as const, "unknown" as const),
        (choice, net) => {
          expect(mobileDataStep(choice, net)).toBe("play");
        },
      ),
    );
  });

  it("on mobile data asks first, refuses for Wi-Fi only, and plays when allowed", () => {
    expect(mobileDataStep("askFirst", "cellular")).toBe("ask");
    expect(mobileDataStep("wifiOnly", "cellular")).toBe("wifiOnly");
    expect(mobileDataStep("allowStreaming", "cellular")).toBe("play");
  });
});
