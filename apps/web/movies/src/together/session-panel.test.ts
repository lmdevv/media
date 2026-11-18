import { Brand } from "effect";
import { describe, expect, it } from "vitest";

import { driftLabel, memberRows } from "./session-panel";
import type { SessionMember } from "./session";

const brand = <B extends Brand.Brand<string>>() => Brand.nominal<B>();

const member = (userId: string, role: SessionMember["role"], present = true): SessionMember => ({
  userId: brand<SessionMember["userId"]>()(userId),
  username: userId,
  displayName: null,
  role,
  present,
  linkGuest: false,
});

describe("memberRows", () => {
  const members = [
    member("mateo", "guest"),
    member("aiko", "guest", false),
    member("lucia", "host"),
  ];

  it("puts the host first, then the viewer, then everyone else as they joined", () => {
    expect(
      memberRows(members, brand<SessionMember["userId"]>()("aiko"), false, null),
    ).toStrictEqual([
      { id: "lucia", name: "lucia", detail: "Host", status: null },
      { id: "aiko", name: "aiko", detail: "You", status: { kind: "away" } },
      { id: "mateo", name: "mateo", detail: null, status: null },
    ]);
  });

  it("shows the viewer catching up, then how far off they are past a second", () => {
    const self = brand<SessionMember["userId"]>()("mateo");

    expect(memberRows(members, self, true, null)[1]?.status).toStrictEqual({ kind: "syncing" });
    expect(memberRows(members, self, false, 800)[1]?.status).toBeNull();
    expect(memberRows(members, self, false, -2_400)[1]?.status).toStrictEqual({
      kind: "drift",
      label: "-2.4s",
    });
  });
});

describe("driftLabel", () => {
  it("signs and rounds to a tenth of a second", () => {
    expect(driftLabel(1_250)).toBe("+1.3s");
    expect(driftLabel(-400)).toBe("-0.4s");
  });
});
