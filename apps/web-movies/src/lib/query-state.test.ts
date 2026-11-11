import { TransportError } from "@media/sdk/effect";
import { describe, expect, it } from "vitest";

import { listOrLoading, orSkip } from "./query-state";

describe("listOrLoading", () => {
  it("gives the rows of a loaded list, null while loading, and nothing for a failure", () => {
    expect(listOrLoading({ status: "success", data: [1, 2] })).toEqual([1, 2]);
    expect(listOrLoading({ status: "loading" })).toBeNull();
    expect(
      listOrLoading<number>({
        status: "error",
        error: new TransportError({
          operation: "titles.episodes",
          message: "offline",
          cause: new Error("offline"),
        }),
        retry: () => undefined,
      }),
    ).toEqual([]);
  });
});

describe("orSkip", () => {
  it("passes arguments on, and waits without them", () => {
    expect(orSkip({ query: "up" })).toEqual([{ query: "up" }]);
    expect(orSkip(null)).toEqual(["skip"]);
  });
});
