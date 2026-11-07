import { describe, expect, it } from "vitest";

import { NAME_MAX, requireGuestAddress, requireGuestName } from "../../../convex/core/guests/model";

describe("the name a guest gives", () => {
  it.each([
    ["  Grandma Jo  ", "Grandma Jo"],
    ["\u{1F469}‍\u{1F4BB} Dev", "\u{1F469}‍\u{1F4BB} Dev"],
    ["می‌خواهم", "می‌خواهم"],
    ["Ｓａｍ", "Sam"],
    ["x".repeat(NAME_MAX), "x".repeat(NAME_MAX)],
  ])("keeps %j as %j", (typed, kept) => {
    expect(requireGuestName(typed)).toBe(kept);
  });

  it.each([
    ["nothing", ""],
    ["only spaces", "   "],
    ["one character too many", "x".repeat(NAME_MAX + 1)],
    ["a line break", "Sam\nAdmin"],
    ["a control character", "Sam\u0000"],
    ["a right-to-left override that reorders what others see", "Sam‮nimda"],
    ["a directional isolate", "Sam⁦admin"],
    ["only zero-width spaces", "\u200B\u200B"],
    ["only a zero-width joiner", "\u200D"],
    ["only a Hangul filler", "\u3164"],
    ["only a soft hyphen and a combining mark", "\u00AD\u0301"],
    ["only blank Braille patterns", "\u2800\u2800"],
  ])("refuses %s", (_name, typed) => {
    expect(() => requireGuestName(typed)).toThrow(/printable/u);
  });
});

describe("the guest address", () => {
  it.each([
    ["https://media.example.ts.net", "https://media.example.ts.net"],
    ["https://media.example.ts.net/", "https://media.example.ts.net"],
    ["http://192.168.1.20:8080", "http://192.168.1.20:8080"],
  ])("keeps %s as the origin %s", (typed, kept) => {
    expect(requireGuestAddress(typed)).toBe(kept);
  });

  it.each([
    "media.example.ts.net",
    "ftp://media.example.ts.net",
    "https://media.example.ts.net/movies",
    "https://media.example.ts.net/?x=1",
    "https://user:pass@media.example.ts.net",
  ])("refuses %s", (typed) => {
    expect(() => requireGuestAddress(typed)).toThrow(/origin/u);
  });
});
