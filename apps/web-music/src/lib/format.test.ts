import { describe, expect, it } from "vitest";

import { initial } from "./format";

describe("initial", () => {
  it("takes a name's first character, a whole emoji too", () => {
    expect(initial("lucía")).toBe("L");
    expect(initial("  Aiko Tanaka")).toBe("A");
    expect(initial("🎸 Mateo")).toBe("🎸");
    expect(initial("   ")).toBe("?");
  });
});
