import * as fc from "fast-check";
import { Option, Order, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { Release, ReleaseOrder } from "./release";

const parse = Schema.decodeUnknownOption(Release);

const part = fc.integer({ min: 0, max: 10_000 });

const parts = fc.tuple(part, part, part);

const text = ([major, minor, patch]: readonly [number, number, number]) =>
  `${String(major)}.${String(minor)}.${String(patch)}`;

describe("Release", () => {
  it("reads major.minor.patch", () => {
    fc.assert(
      fc.property(parts, (release) => {
        expect(Option.isSome(parse(text(release)))).toBe(true);
      }),
    );
  });

  it("refuses anything else a server or build could report", () => {
    for (const refused of ["", "0.9", "0.9.0.1", "v0.9.0", "01.9.0", "0.9.0-rc.1", " 0.9.0", 9]) {
      expect(parse(refused)).toEqual(Option.none());
    }
  });
});

describe("ReleaseOrder", () => {
  it("compares each part as a number", () => {
    const greater = Order.isGreaterThan(ReleaseOrder);

    expect(greater(Release.make("0.10.0"), Release.make("0.9.0"))).toBe(true);
    expect(greater(Release.make("1.0.0"), Release.make("0.99.99"))).toBe(true);
    expect(greater(Release.make("0.9.1"), Release.make("0.9.0"))).toBe(true);
    expect(ReleaseOrder(Release.make("0.9.0"), Release.make("0.9.0"))).toBe(0);
  });

  it("agrees with comparing the parts in order", () => {
    fc.assert(
      fc.property(parts, parts, (left, right) => {
        const byParts = Order.Tuple([Order.Number, Order.Number, Order.Number])(left, right);

        expect(ReleaseOrder(Release.make(text(left)), Release.make(text(right)))).toBe(byParts);
      }),
    );
  });
});
