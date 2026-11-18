import { describe, expect, it } from "vitest";

import { linkStateOf } from "./link-page";

const retry = () => undefined;

const failed = (tag: string) =>
  linkStateOf({ status: "error", error: { _tag: tag, message: tag }, retry });

describe("linkStateOf", () => {
  it("opens the link the lookup found", () => {
    expect(linkStateOf({ status: "success", data: { username: "kim" } })).toEqual({
      kind: "open",
      link: { username: "kim" },
    });
  });

  it("ends a link the core refuses as expired or unknown", () => {
    expect(failed("Expired")).toEqual({ kind: "ended" });
    expect(failed("NotFound")).toEqual({ kind: "ended" });
  });

  it("offers a retry for any other failure", () => {
    expect(failed("TransportError")).toEqual({ kind: "unreachable", retry });
  });
});
