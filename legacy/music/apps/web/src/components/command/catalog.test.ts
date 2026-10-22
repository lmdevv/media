import { describe, expect, it } from "vitest";

import { offeredScreens } from "./catalog";

describe("offeredScreens", () => {
  it("hides screens whose query is for admins from everyone else", () => {
    const member = offeredScreens("member").map((screen) => screen.name);
    const admin = offeredScreens("admin").map((screen) => screen.name);
    const owner = offeredScreens("owner").map((screen) => screen.name);
    const guest = offeredScreens("guest").map((screen) => screen.name);

    expect(owner).toEqual(admin);
    expect(guest).not.toContain("keys.list");
    expect(member).toContain("keys.list");

    expect(admin).toContain("people.list");
    expect(member).not.toContain("people.list");
    expect(member).toContain("library.home");
    expect(admin.slice(0, 2)).toEqual(["library.home", "search"]);
  });
});
