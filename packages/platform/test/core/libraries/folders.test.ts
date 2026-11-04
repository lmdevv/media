import { ConvexError } from "convex/values";
import { Schema } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  isInside,
  parseFolder,
  parseFolders,
  selfAndAncestors,
} from "../../../convex/core/folders";

const decodeCode = Schema.decodeUnknownSync(Schema.Struct({ code: Schema.String }));

const refusalOf = (run: () => void): string => {
  try {
    run();

    return "accepted";
  } catch (cause) {
    return cause instanceof ConvexError ? decodeCode(cause.data).code : `threw ${String(cause)}`;
  }
};

const segment = fc
  .array(fc.constantFrom("a", "b", "c", "-", " ", ".", "é"), { minLength: 1, maxLength: 4 })
  .map((chars) => chars.join(""))
  .filter((name) => name.trim() === name && name !== "." && name !== "..");

const segments = fc.array(segment, { minLength: 1, maxLength: 6 });

const folder = segments.map((names) => `/${names.join("/")}`);

const pair = fc
  .tuple(segments, segments, fc.nat(6), fc.constantFrom("holds", "prefix", "apart"))
  .map(([names, others, depth, relation]) => {
    const held = `/${names.slice(0, Math.min(Math.max(depth, 1), names.length)).join("/")}`;
    const other = { holds: held, prefix: `${held}x`, apart: `/${others.join("/")}` }[relation];

    return [`/${names.join("/")}`, other] as const;
  });

describe("library folders", () => {
  it("are written down one way, and parsing one again changes nothing", () => {
    expect(parseFolder("  /srv//films/ ")).toBe("/srv/films");
    expect(parseFolder("/srv/films///")).toBe("/srv/films");

    fc.assert(
      fc.property(folder, fc.constantFrom("", "/", "//", " "), (typed, tail) => {
        const parsed = parseFolder(`${typed}${tail}`);

        expect(parseFolder(parsed)).toBe(parsed);
      }),
      { numRuns: 2000 },
    );
  });

  it("refuse relative paths, dot segments, control characters, the whole disk, and deep paths", () => {
    for (const typed of ["srv/films", "/srv/../etc", "/srv/./films", "/srv/\u0000x", "/", "  "]) {
      expect(refusalOf(() => parseFolder(typed))).toBe("invalid_args");
    }

    expect(refusalOf(() => parseFolder(`/${"a".repeat(1024)}`))).toBe("invalid_args");
    expect(refusalOf(() => parseFolder("/a".repeat(33)))).toBe("invalid_args");
    expect(parseFolder("/a".repeat(32))).toBe("/a".repeat(32));
  });

  it("hold 1 to 16 folders per library, none inside another", () => {
    expect(parseFolders(["/srv/b", "/srv/a/", "/srv/b"])).toEqual(["/srv/a", "/srv/b"]);
    expect(refusalOf(() => parseFolders([]))).toBe("invalid_args");
    expect(refusalOf(() => parseFolders(["/srv", "/srv/films"]))).toBe("invalid_args");
    expect(refusalOf(() => parseFolders(Array.from({ length: 17 }, (_, n) => `/srv/${n}`)))).toBe(
      "invalid_args",
    );
    expect(parseFolders(["/srv/film", "/srv/films"])).toEqual(["/srv/film", "/srv/films"]);
  });

  it("find every folder that holds a path among its own ancestors", () => {
    expect(selfAndAncestors("/srv/media/films")).toEqual([
      "/srv",
      "/srv/media",
      "/srv/media/films",
    ]);

    fc.assert(
      fc.property(pair, ([left, right]) => {
        const path = parseFolder(left);
        const other = parseFolder(right);

        expect(isInside(path, other)).toBe(selfAndAncestors(path).includes(other));
      }),
      { numRuns: 5000 },
    );
  });
});
