import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { parseSearch, stringifySearch } from "./search-params";

describe("search params", () => {
  it("keeps numbers and booleans as strings", () => {
    expect(parseSearch("?q=2020&add=1&flag=true&empty=")).toEqual({
      q: "2020",
      add: "1",
      flag: "true",
      empty: "",
    });
  });

  it("writes nothing for an empty search and skips missing values", () => {
    expect(stringifySearch({})).toBe("");
    expect(stringifySearch({ q: undefined, add: "1" })).toBe("?add=1");
  });

  it("round-trips any string values", () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.stringMatching(/^[a-z][a-z0-9]{0,8}$/), fc.string()),
        (search) => {
          expect(parseSearch(stringifySearch(search))).toEqual({ ...search });
        },
      ),
    );
  });
});
