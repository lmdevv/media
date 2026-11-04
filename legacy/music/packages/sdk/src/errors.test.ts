import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { sessionEnd } from "./errors";

describe("sessionEnd", () => {
  it("reads why the server ended a session", () => {
    expect(
      sessionEnd(
        new ConvexError({ code: "unauthenticated", message: "Suspended", reason: "suspended" }),
      ),
    ).toBe("suspended");
    expect(
      sessionEnd(new ConvexError({ code: "unauthenticated", message: "Gone", reason: "removed" })),
    ).toBe("removed");
  });

  it("reads a refusal without a reason as a session that ended", () => {
    expect(
      sessionEnd(new ConvexError({ code: "unauthenticated", message: "This session has ended" })),
    ).toBe("ended");
    expect(
      sessionEnd(new ConvexError({ code: "unauthenticated", message: "Bye", reason: "later" })),
    ).toBe("ended");
  });

  it("is null for every other failure", () => {
    expect(sessionEnd(new ConvexError({ code: "forbidden", message: "No" }))).toBeNull();
    expect(sessionEnd(new Error("network"))).toBeNull();
  });
});
