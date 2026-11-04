import { normalizeFolder } from "@media/contracts/library-folder";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { normalizeRoot } from "../convex/lib/roots";

describe("normalizeRoot", () => {
  it("agrees with the web app's normalizeFolder", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string(),
          fc
            .array(fc.constantFrom("/", " ", "a", "!", ".", "\t"), { maxLength: 30 })
            .map((parts) => parts.join("")),
        ),
        (folder) => {
          expect(normalizeRoot(folder)).toBe(normalizeFolder(folder));
        },
      ),
      { numRuns: 5000 },
    );
  });
});
