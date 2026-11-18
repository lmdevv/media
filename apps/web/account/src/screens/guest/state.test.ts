import { describe, expect, it } from "vitest";

import { guestFailure, guestGate } from "./state";

describe("guest entrance refusals", () => {
  it("never tells why a link ended", () => {
    for (const message of ["expired", "revoked", "turned off", "maker stopped"]) {
      expect(guestFailure({ _tag: "Expired", message })).toEqual({ kind: "unavailable" });
    }
  });
  it("keeps full, invalid names, and rate limiting distinct", () => {
    expect(guestFailure({ _tag: "Conflict" })).toEqual({ kind: "full" });
    expect(guestFailure({ _tag: "InvalidArgs" })).toEqual({
      kind: "failed",
      message: "Choose another display name.",
    });
    expect(guestFailure({ _tag: "RateLimited" })).toEqual({
      kind: "failed",
      message: "Too many tries. Wait a few minutes, then try again.",
    });
  });
  it("does not render unexpected diagnostics", () => {
    expect(guestFailure(new Error("a secret"))).toEqual({
      kind: "failed",
      message: "Can't reach the server. Try again.",
    });
  });
});

describe("guest entrance gate", () => {
  const input = {
    status: "signedOut",
    role: "loading",
    hasCode: true,
    opened: false,
    confirmed: false,
    submitting: false,
  } as const;

  it("waits for identity and asks before replacing a member or tile", () => {
    expect(guestGate({ ...input, status: "loading" })).toBe("loading");
    expect(guestGate({ ...input, status: "signedIn" })).toBe("loading");
    expect(guestGate({ ...input, status: "signedIn", role: "household" })).toBe("confirm");
    expect(guestGate({ ...input, status: "signedIn", role: "household", confirmed: true })).toBe(
      "name",
    );
  });

  it("takes only a name when signed out, and never invents a preview", () => {
    expect(guestGate(input)).toBe("name");
    expect(guestGate({ ...input, hasCode: false })).toBe("unavailable");
  });

  it("resumes on reload or redemption, but asks before a fresh link replaces a guest", () => {
    expect(guestGate({ ...input, status: "signedIn", role: "guest", hasCode: false })).toBe(
      "resume",
    );
    expect(guestGate({ ...input, status: "signedIn", role: "guest", opened: true })).toBe("resume");
    expect(guestGate({ ...input, status: "signedIn", role: "guest" })).toBe("confirm");
  });
});
