import { describe, expect, it } from "vitest";

import { monogram } from "./avatars";

describe("avatars", () => {
  it("writes the name's first character as the monogram", () => {
    expect(monogram("  alex ")).toBe("A");
    expect(monogram("")).toBe("");
    expect(monogram("🎬 Movie Night")).toBe("🎬");
  });
});
