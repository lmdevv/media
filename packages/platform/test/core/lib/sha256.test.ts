import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sha256Hex } from "../../../convex/core/lib/sha256";

const expected = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

describe("sha256Hex", () => {
  it("matches node:crypto across block boundaries and wide characters", () => {
    const lengths = [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000, 100_000];

    const texts = [
      ...lengths.map((length) => "a".repeat(length)),
      ...lengths.map((length) => "€".repeat(length)),
      "name:\u{1F3AC} été",
    ];

    for (const text of texts) expect(sha256Hex(text)).toBe(expected(text));
  });
});
