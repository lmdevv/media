import type { PlatformSdk } from "@media/sdk/promise";
import { describe, expect, it } from "vitest";

import { canQueryGuestLinks, guestExpiryDays, guestLinksAllowed } from "./guest-links";

type Me = Awaited<ReturnType<PlatformSdk["core"]["auth"]["sessions"]["current"]>>;

describe("guest sharing", () => {
  it("does not ask account queries from tiles, guests, keys, or sessions without account scope", () => {
    const me: Pick<Me, "kind" | "role" | "scopes"> = {
      kind: "password",
      role: "member",
      scopes: ["account"],
    };

    expect(canQueryGuestLinks(undefined)).toBe(false);
    expect(canQueryGuestLinks(me)).toBe(true);

    for (const kind of ["tile", "guest", "apiKey"] as const)
      expect(canQueryGuestLinks({ ...me, kind })).toBe(false);
    expect(canQueryGuestLinks({ ...me, scopes: [] })).toBe(false);
    expect(canQueryGuestLinks({ ...me, role: "guest" })).toBe(false);
  });

  it("shows sharing only with both the server switch and leave", () => {
    expect(guestLinksAllowed(undefined)).toBe(false);

    for (const enabled of [false, true])
      for (const mayShare of [false, true]) {
        expect(guestLinksAllowed({ enabled, mayShare, address: "http://guest.test" })).toBe(
          enabled && mayShare,
        );
      }
  });

  it("accepts only whole expiry days from one through thirty", () => {
    expect(guestExpiryDays("7")).toBe(7);
    expect(guestExpiryDays("1")).toBe(1);
    expect(guestExpiryDays("30")).toBe(30);

    for (const value of ["", "0", "31", "1.5", "NaN", "Infinity"])
      expect(guestExpiryDays(value)).toBeNull();
  });
});
