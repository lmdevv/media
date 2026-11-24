import { describe, expect, it } from "vitest";

import { artistCount, initial } from "./format";

describe("initial", () => {
  it("takes a name's first character, a whole emoji too", () => {
    expect(initial("lucía")).toBe("L");
    expect(initial("  Aiko Tanaka")).toBe("A");
    expect(initial("🎸 Mateo")).toBe("🎸");
    expect(initial("   ")).toBe("?");
  });
});

describe("artistCount", () => {
  it("counts an artist's albums, or their songs when no album credits them", () => {
    expect(artistCount({ albumCount: 2, trackCount: 14 })).toBe("2 albums");
    expect(artistCount({ albumCount: 0, trackCount: 1 })).toBe("1 song");
    expect(artistCount({ albumCount: 0 })).toBe("0 albums");
  });
});
