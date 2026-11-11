import { User } from "@media/contracts/models/account";
import { LibraryDetail } from "@media/contracts/models/catalog";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { accessRows, canChange, expiryLine, grantsOf, householdOf, sameGrants } from "./household";

const user = (id: string, role: User["role"]): User =>
  Schema.decodeSync(User)({
    id,
    email: `${id}@example.com`,
    name: id,
    role,
    disabled: false,
    createdAt: 1,
  });

const library = (id: string, access: "everyone" | "restricted", granted: ReadonlyArray<string>) =>
  Schema.decodeSync(LibraryDetail)({
    id,
    name: id,
    kind: "movies",
    titleCount: 0,
    lastScanAt: null,
    scanning: false,
    roots: ["/media"],
    access,
    grantedUserIds: granted,
    trickplay: true,
    createdAt: 1,
  });

const libraries = [library("Movies", "everyone", []), library("Family", "restricted", ["sam"])];

describe("household", () => {
  it("leaves out the media service and protects the owner and oneself", () => {
    const owner = user("alex", "owner");
    const sam = user("sam", "member");

    expect(householdOf([owner, sam, user("media", "service")])).toStrictEqual([owner, sam]);
    expect(canChange(owner, null)).toBe(false);
    expect(canChange(sam, sam.id)).toBe(false);
    expect(canChange(sam, owner.id)).toBe(true);
  });

  it("lets members' restricted libraries change and shows everyone else's access as it is", () => {
    const sam = user("sam", "member");
    const granted = grantsOf(sam.id, libraries);

    expect(
      accessRows(sam.role, libraries, granted).map((row) => [row.detail, row.changeable]),
    ).toStrictEqual([
      ["Everyone", false],
      ["Allowed", true],
    ]);
    expect(accessRows(sam.role, libraries, [])[1]?.detail).toBe("Not Allowed");
    expect(accessRows("admin", libraries, []).every((row) => row.allowed)).toBe(true);
    expect(sameGrants(granted, [...granted])).toBe(true);
    expect(sameGrants(granted, [])).toBe(false);
  });

  it("says how long an invite lasts", () => {
    expect(expiryLine(7)).toBe("Expires in 7 days");
    expect(expiryLine(1)).toBe("Expires in 1 day");
  });
});
