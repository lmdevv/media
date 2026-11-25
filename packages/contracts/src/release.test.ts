import * as fc from "fast-check";
import { Option, Order, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { Release, ReleaseOrder } from "./release";

const parse = Schema.decodeUnknownOption(Release);

const part = fc.integer({ min: 0, max: 10_000 });

const parts = fc.tuple(part, part, part);

const text = ([major, minor, patch]: readonly [number, number, number]) =>
  `${String(major)}.${String(minor)}.${String(patch)}`;

const identifier = fc.oneof(
  part.map(String),
  fc.stringMatching(/^\d*[A-Za-z-][\dA-Za-z-]*$/u).filter((id) => id.length <= 8),
);

const release = fc
  .tuple(parts, fc.array(identifier, { maxLength: 3 }))
  .map(([numbers, prerelease]) =>
    Release.make(
      prerelease.length === 0 ? text(numbers) : `${text(numbers)}-${prerelease.join(".")}`,
    ),
  );

/** Semver 2.0's own precedence example (section 11), lowest first, then later releases. */
const ascending = [
  "0.9.0",
  "0.10.0-rc.1",
  "0.10.0",
  "1.0.0-alpha",
  "1.0.0-alpha.1",
  "1.0.0-alpha.beta",
  "1.0.0-beta",
  "1.0.0-beta.2",
  "1.0.0-beta.11",
  "1.0.0-rc.1",
  "1.0.0",
  "1.0.1-0",
  "1.0.1-0.0",
  "1.0.1-1",
  "1.0.1-99999999999999999999",
  "1.0.1--",
  "1.0.1-A",
  "1.0.1-a",
  "1.0.1",
].map((version) => Release.make(version));

describe("Release", () => {
  it("reads major.minor.patch", () => {
    fc.assert(
      fc.property(parts, (numbers) => {
        expect(Option.isSome(parse(text(numbers)))).toBe(true);
      }),
    );
  });

  it("reads every pre-release a release tag can name", () => {
    for (const read of [
      "0.10.0-rc.1",
      "0.5.0-rc.1",
      "1.0.0-alpha.beta",
      "1.0.0-0.3.7",
      "1.0.0-x-y",
    ]) {
      expect(parse(read)).toEqual(Option.some(read));
    }
  });

  it("refuses anything else a server or build could report", () => {
    for (const refused of [
      "",
      "0.9",
      "0.9.0.1",
      "v0.9.0",
      "01.9.0",
      " 0.9.0",
      "0.9.0-",
      "0.9.0-rc..1",
      "0.9.0-rc.01",
      "0.9.0-rc 1",
      "0.9.0+build.1",
      9,
    ]) {
      expect(parse(refused)).toEqual(Option.none());
    }
  });
});

describe("ReleaseOrder", () => {
  it("orders releases the way semver orders versions", () => {
    for (const [index, lower] of ascending.entries()) {
      for (const higher of ascending.slice(index + 1)) {
        expect([ReleaseOrder(lower, higher), ReleaseOrder(higher, lower)]).toEqual([-1, 1]);
      }

      expect(ReleaseOrder(lower, Release.make(String(lower)))).toBe(0);
    }
  });

  it("agrees with comparing the numbers in order", () => {
    fc.assert(
      fc.property(parts, parts, (left, right) => {
        const byParts = Order.Tuple([Order.Number, Order.Number, Order.Number])(left, right);

        expect(ReleaseOrder(Release.make(text(left)), Release.make(text(right)))).toBe(byParts);
      }),
    );
  });

  it("is a total order", () => {
    fc.assert(
      fc.property(release, release, release, (a, b, c) => {
        expect(ReleaseOrder(a, b)).toBe(-ReleaseOrder(b, a) || 0);
        expect(ReleaseOrder(a, b) === 0).toBe(a === b);

        if (ReleaseOrder(a, b) <= 0 && ReleaseOrder(b, c) <= 0) {
          expect(ReleaseOrder(a, c)).toBeLessThanOrEqual(0);
        }
      }),
    );
  });

  it("puts every pre-release before its release", () => {
    fc.assert(
      fc.property(release, (prerelease) => {
        const dash = prerelease.indexOf("-");

        fc.pre(dash !== -1);
        expect(ReleaseOrder(prerelease, Release.make(prerelease.slice(0, dash)))).toBe(-1);
      }),
    );
  });
});
