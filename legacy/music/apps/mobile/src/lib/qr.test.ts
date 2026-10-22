import { describe, expect, it } from "vitest";

import { qrPath } from "./qr";

describe("qrPath", () => {
  it("draws a Jam link as a square code with its quiet border left blank", () => {
    const { size, path } = qrPath("http://100.94.55.81:8091/jam/k3j9xabcdefghmnpqrst");

    // Paper's 33-module grid (version 4) plus a two-module border on each side.
    expect(size).toBe(37);
    // The top-left finder pattern starts right inside the border.
    expect(path.startsWith("M2 2h1v1h-1z")).toBe(true);
    expect(path).not.toContain("M0 0");
  });

  it("gives the same code for the same link", () => {
    expect(qrPath("music://jam/abc")).toEqual(qrPath("music://jam/abc"));
  });
});
