import { Schema } from "effect";
import { assert, property, string } from "fast-check";
import { describe, expect, it } from "vitest";

import { Description, Name, cleanText } from "./text";

const decodeName = Schema.decodeUnknownSync(Name);

describe("typed text", () => {
  it("drops C0, DEL, and C1 controls, and turns line breaks and tabs into spaces", () => {
    expect(cleanText("\u001b[31mRed\u001b[0m")).toBe("[31mRed[0m");
    expect(cleanText("a\u0000b\u007fc\u0080d\u009be")).toBe("abcde");
    expect(cleanText("one\ntwo\r\nthree\tfour\u0085five")).toBe("one two  three four five");
    expect(cleanText("  Café ☕ 東京  ")).toBe("Café ☕ 東京");
    // Bidi overrides, isolates, and marks, zero-width spaces, the Arabic letter mark, and
    // invisible tags go; line and paragraph separators become spaces; joiners inside emoji stay.
    expect(cleanText("Admin\u202Egnp.exe\u2066x\u2069")).toBe("Admingnp.exex");
    expect(cleanText("a\u200Bb\u200Cc\u200Ed\u200Fe\u061Cf\u{E0041}g")).toBe("abcdefg");
    expect(cleanText("one\u2028two\u2029three")).toBe("one two three");
    expect(cleanText("👩\u200D💻")).toBe("👩\u200D💻");
  });

  it("never leaves a control character, whatever goes in", () => {
    assert(property(string({ unit: "binary" }), (text) => !/\p{Cc}/u.test(cleanText(text))));
  });

  it("cleans names and descriptions as they decode, then checks their length", () => {
    expect(decodeName(" \u001b[1mMix\u0007 ")).toBe("[1mMix");
    expect(() => decodeName("\u001b\u0007")).toThrow();
    // Fillers and blanks draw nothing, so a name of only them is refused.
    expect(() => decodeName("\u3164\u115F\u1160\uFFA0 \u3000")).toThrow("Name can't be blank");
    expect(() => decodeName("\u2800\u2800")).toThrow("Name can't be blank");
    expect(() => decodeName("\u034F\u0301")).toThrow("Name can't be blank");
    expect(decodeName("e\u0301")).toBe("e\u0301");
    expect(decodeName("\u3164Ann")).toBe("\u3164Ann");
    expect(() => decodeName("x".repeat(121))).toThrow();
    expect(Schema.decodeSync(Description)("Notes\u009b")).toBe("Notes");
  });
});
