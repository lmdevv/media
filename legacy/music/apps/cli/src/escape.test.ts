import { assert, jsonValue, property, string } from "fast-check";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { escapeControlCharacters, terminalSafe } from "./escape";
import { lineOutput } from "./output";

describe("escaping control characters", () => {
  it("writes out every control character, or all but the line breaks and tabs", () => {
    expect(escapeControlCharacters("a\u001b[2J\n\tb\u009b\u007f")).toBe(
      String.raw`a\u001b[2J\u000a\u0009b\u009b\u007f`,
    );
    expect(terminalSafe("a\u001b[2J\n\tb\u009b")).toBe("a\\u001b[2J\n\tb\\u009b");
    // Format characters and separators too, a character beyond U+FFFF as its two code units.
    expect(escapeControlCharacters("x\u202Ey\u2028z\u{E0041}👩\u200D💻")).toBe(
      String.raw`x\u202ey\u2028z\udb40\udc41` + "👩\u200D💻",
    );
  });

  it("leaves nothing a terminal would act on", () => {
    assert(
      property(
        string({ unit: "binary" }),
        (text) => !/\p{Cc}/u.test(terminalSafe(text).replaceAll(/[\n\t]/gu, "")),
      ),
    );
  });

  it("guards every line the CLI writes to the terminal", () => {
    const lines: Array<string> = [];
    const output = lineOutput({ out: (line) => lines.push(line), err: (line) => lines.push(line) });

    Effect.runSync(output.out("a\u001b]0;x\u0007\nb"));
    Effect.runSync(output.err("\u009b2J"));

    expect(lines).toEqual(["a\\u001b]0;x\\u0007\nb\n", "\\u009b2J\n"]);
  });

  it("keeps JSON valid and meaning the same", () => {
    assert(
      property(jsonValue(), (value) => {
        const text = JSON.stringify(value, null, 2);

        expect(JSON.parse(terminalSafe(text))).toStrictEqual(JSON.parse(text));
      }),
    );
  });
});
