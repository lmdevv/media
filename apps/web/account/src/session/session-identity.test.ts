import {
  Expired,
  Forbidden,
  Internal,
  NotFound,
  RateLimited,
  Unauthenticated,
} from "@media/contracts/errors";
import { describe, expect, it } from "vitest";
import { guestView, isRenewing, linkRefused, sessionAccess } from "@media/ui/lib/session-identity";

describe("session identity renewal", () => {
  it("waits for a refused session but keeps server failures visible", () => {
    expect(isRenewing(new Unauthenticated({ message: "Session renewing" }))).toBe(true);
    expect(isRenewing(new Internal({ message: "Server failed" }))).toBe(false);
  });
});

describe("guest link refusal", () => {
  it("treats a gone link or item as refused and a server failure as retryable", () => {
    expect(linkRefused(new NotFound({ message: "No such item" }))).toBe(true);
    expect(linkRefused(new Forbidden({ message: "Not shared" }))).toBe(true);
    expect(linkRefused(new Expired({ message: "Link ended" }))).toBe(true);
    expect(linkRefused(new Internal({ message: "Server failed" }))).toBe(false);
    expect(linkRefused(new RateLimited({ message: "Slow down" }))).toBe(false);
    expect(linkRefused(new Unauthenticated({ message: "Session renewing" }))).toBe(false);
  });
});

const retry = () => undefined;

describe("session access", () => {
  it("waits for a refused identity and admits the renewed household session", () => {
    expect(
      sessionAccess("signedIn", {
        status: "error",
        error: new Unauthenticated({ message: "Renewing" }),
        retry,
      }),
    ).toBe("loading");
    expect(sessionAccess("signedIn", { status: "success", data: { role: "member" } })).toBe(
      "household",
    );
  });
  it("distinguishes an unavailable server from a transition", () => {
    expect(
      sessionAccess("signedIn", {
        status: "error",
        error: new Internal({ message: "Server failed" }),
        retry,
      }),
    ).toBe("failed");
  });
  it("admits guests only to guest playback and ends access on SDK sign-out", () => {
    const me = { status: "success", data: { role: "guest" } } as const;
    expect(sessionAccess("signedIn", me)).toBe("guest");
    expect(sessionAccess("signedOut", me)).toBe("signedOut");
    expect(sessionAccess("loading", me)).toBe("loading");

    expect(sessionAccess("signedIn", { status: "loading" })).toBe("loading");

    for (const role of ["owner", "admin", "member"] as const)
      expect(sessionAccess("signedIn", { status: "success", data: { role } })).toBe("household");
  });
});

describe("guest view", () => {
  it("stays blank while a read loads or the session renews", () => {
    expect(guestView({ status: "loading" })).toEqual({ kind: "blank" });

    expect(
      guestView({ status: "error", error: new Unauthenticated({ message: "Renewing" }), retry }),
    ).toEqual({ kind: "blank" });
  });
  it("shows a refused link as unavailable and any other failure as a retry", () => {
    for (const error of [
      new NotFound({ message: "No such item" }),
      new Forbidden({ message: "Not shared" }),
      new Expired({ message: "Link ended" }),
    ])
      expect(guestView({ status: "error", error, retry })).toEqual({ kind: "unavailable" });

    expect(
      guestView({ status: "error", error: new Internal({ message: "Server failed" }), retry }),
    ).toEqual({ kind: "unreachable", retry });
  });
  it("hands over the data once the read holds it", () => {
    expect(guestView({ status: "success", data: null })).toEqual({ kind: "ready", data: null });
  });
});
