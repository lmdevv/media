import { describe, expect, it } from "vitest";

import { qualityLabel } from "./settings";

describe("download quality", () => {
  it("names each choice", () => {
    expect(qualityLabel("high")).toBe("High");
    expect(qualityLabel("standard")).toBe("Standard");
  });
});
