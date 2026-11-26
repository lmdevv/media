import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { coverCopy } from "./cover-copy.ts";
import { PNG } from "./testing/music-fixtures.ts";

const COVERS = join(import.meta.dirname, "..", "testing", "fixtures", "covers");

const cover = (name: string) => new Uint8Array(readFileSync(join(COVERS, name)));

describe("coverCopy", () => {
  it("copies a cover with transparency as a PNG and an opaque one as a JPEG", () => {
    expect(coverCopy(cover("transparent.png"))).toBe("png");
    expect(coverCopy(cover("palette.png"))).toBe("png");
    expect(coverCopy(cover("alpha.webp"))).toBe("png");
    expect(coverCopy(PNG)).toBe("png");
    expect(coverCopy(cover("profiled.jpg"))).toBe("jpeg");
    expect(coverCopy(cover("rotated.jpg"))).toBe("jpeg");
  });

  it("serves the original of a cover a copy would not show the same", () => {
    for (const name of ["cmyk.jpg", "gamma.png", "animated.png", "animated.gif", "animated.webp"]) {
      expect([name, coverCopy(cover(name))]).toEqual([name, "original"]);
    }
  });

  it("serves the original when the headers it needs are cut off or unknown", () => {
    expect(coverCopy(cover("profiled.jpg").subarray(0, 200))).toBe("original");
    expect(coverCopy(cover("transparent.png").subarray(0, 20))).toBe("original");
    expect(coverCopy(cover("alpha.webp").subarray(0, 16))).toBe("original");
    expect(coverCopy(new Uint8Array([0x42, 0x4d, 0, 0]))).toBe("original");
    expect(coverCopy(new Uint8Array())).toBe("original");
  });
});
