import { JamId, UserId } from "@music/commands/ids";
import type { Jam, JamMember } from "@music/commands/models";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  contributionsOf,
  endedLine,
  guestEmail,
  jamCodeFrom,
  jamLink,
  jamScreen,
  listenerCount,
  memberStatus,
  nameList,
  peopleRow,
  quotaNotice,
  requestsRow,
  settingsChanges,
} from "./jam";
import type { SettingsDraft } from "./jam";
import { ServerOrigin } from "./server";

const origin = Schema.decodeSync(ServerOrigin)("http://100.94.55.81:8091");

const userId = (id: string) => UserId.make(id);

const settings: SettingsDraft = {
  join: "approval",
  membersCanAdd: true,
  addLimit: 10,
  membersCanControl: true,
  membersCanEdit: "own",
  listenAlong: true,
};

const member = (
  name: string,
  status: JamMember["status"],
  listening = false,
  since = 0,
): JamMember => ({ person: { id: userId(name.toLowerCase()), name }, status, listening, since });

const makeJam = (overrides: Partial<Jam> = {}): Jam => ({
  id: JamId.make("jam1"),
  code: "k3j9",
  host: { id: userId("lee"), name: "Lee" },
  status: "active",
  endedReason: null,
  settings,
  approvalAfterRemoval: false,
  role: "host",
  listening: false,
  members: [],
  createdAt: 0,
  ...overrides,
});

describe("jamScreen", () => {
  it("shows each side of a live Jam", () => {
    expect(jamScreen(undefined, null, false)).toEqual({ kind: "loading" });
    expect(jamScreen(null, null, false)).toEqual({ kind: "none" });
    expect(jamScreen(makeJam(), null, false).kind).toBe("host");
    expect(jamScreen(makeJam({ role: "member" }), null, false).kind).toBe("member");
    expect(jamScreen(makeJam({ role: "pending", code: "" }), null, false).kind).toBe("waiting");
    expect(jamScreen(makeJam({ role: "member", status: "ended" }), null, false).kind).toBe("ended");
  });

  it("says why a Jam disappeared: turned away while waiting, removed while in it", () => {
    expect(jamScreen(null, makeJam({ role: "pending" }), false)).toEqual({
      kind: "declined",
      hostName: "Lee",
    });
    expect(jamScreen(null, makeJam({ role: "member" }), false)).toEqual({
      kind: "removed",
      hostName: "Lee",
    });
    expect(jamScreen(null, makeJam(), false)).toEqual({ kind: "none" });
  });

  it("keeps showing the Jam while the person leaves it on purpose", () => {
    expect(jamScreen(null, makeJam({ role: "member" }), true).kind).toBe("member");
    expect(jamScreen(null, makeJam({ role: "member", status: "ended" }), true).kind).toBe("ended");
  });
});

describe("rows", () => {
  it("names people the way people say them", () => {
    expect(nameList(["Sam"])).toBe("Sam");
    expect(nameList(["Sam", "Alex"])).toBe("Sam & Alex");
    expect(nameList(["Sam", "Alex", "Riley"])).toBe("Sam, Alex & Riley");
    expect(nameList(["Sam", "Alex", "Riley", "Jo"])).toBe("Sam, Alex & 2 others");
  });

  it("summarizes who is in the Jam, as D02 draws it", () => {
    expect(peopleRow([member("Sam", "joined", true), member("Alex", "joined", true)])).toEqual({
      title: "Sam & Alex",
      subtitle: "Listening along · 2 people",
    });
    expect(peopleRow([member("Sam", "joined", true), member("Alex", "joined")]).subtitle).toBe(
      "1 listening along · 2 people",
    );
    expect(peopleRow([member("Riley", "pending")]).title).toBe("No one yet");
  });

  it("highlights requests only when someone waits", () => {
    expect(requestsRow([member("Sam", "joined")])).toBeNull();
    expect(requestsRow([member("Riley", "pending")])).toEqual({
      title: "1 request to join",
      subtitle: "Riley is waiting",
    });
    expect(requestsRow([member("Riley", "pending"), member("Jo", "pending")])?.subtitle).toBe(
      "Riley & Jo are waiting",
    );
  });

  it("words what a member does and how many listen", () => {
    expect(memberStatus(member("Sam", "joined", true), settings)).toBe("Listening along");
    expect(memberStatus(member("Alex", "joined"), settings)).toBe("Controlling the queue");
    expect(
      memberStatus(member("Alex", "joined"), {
        ...settings,
        membersCanAdd: false,
        membersCanControl: false,
      }),
    ).toBe("In the Jam");
    expect(
      listenerCount(
        makeJam({ members: [member("Sam", "joined", true), member("Alex", "joined")] }),
      ),
    ).toBe("2 people listening");
  });
});

describe("settingsChanges", () => {
  it("sends only what changed, and no limit as 0", () => {
    expect(settingsChanges(settings, settings)).toEqual({});
    expect(settingsChanges(settings, { ...settings, join: "open", addLimit: null })).toEqual({
      join: "open",
      addLimit: 0,
    });
  });
});

const entry = (itemId: string, by: string | null, autoplay = false) => ({
  itemId,
  addedBy: by === null ? null : { id: userId(by), name: by },
  autoplay,
});

describe("member's songs", () => {
  it("lists the member's own songs still to come", () => {
    const queue = [
      entry("a", "sam"),
      entry("b", "sam"),
      entry("c", "lee"),
      entry("d", "sam"),
      entry("e", "sam", true),
    ];

    expect(contributionsOf(queue, 1, userId("sam")).map((item) => item.itemId)).toEqual(["d"]);
  });

  it("counts against the host's limit and says what the member may edit", () => {
    expect(quotaNotice(2, makeJam())).toEqual({
      title: "2 of 10 songs added",
      subtitle: "You can edit your own additions. Lee controls the rest.",
    });
    expect(quotaNotice(1, makeJam({ settings: { ...settings, addLimit: null } })).title).toBe(
      "1 song added",
    );
  });
});

describe("links and codes", () => {
  it("builds the web link people open", () => {
    expect(jamLink(origin, "k3j9")).toBe("http://100.94.55.81:8091/jam/k3j9");
  });

  it("reads a bare code, this server's link, or the app's own link", () => {
    expect(jamCodeFrom(" k3j9 ", origin)).toEqual({ ok: true, code: "k3j9" });
    expect(jamCodeFrom("http://100.94.55.81:8091/jam/k3j9", origin)).toEqual({
      ok: true,
      code: "k3j9",
    });
    expect(jamCodeFrom("music://jam/k3j9", origin)).toEqual({ ok: true, code: "k3j9" });
  });

  it("turns away other links and other servers", () => {
    expect(jamCodeFrom("http://100.94.55.81:8091/invite/abc", origin).ok).toBe(false);
    expect(jamCodeFrom("https://music.example/jam/k3j9", origin)).toEqual({
      ok: false,
      reason: "That Jam is on another server.",
    });
    expect(jamCodeFrom("not a code!", origin).ok).toBe(false);
  });

  it("makes a guest's sign-in address from their name", () => {
    expect(guestEmail("  Riley Ó'Neil ", "k3j9")).toBe("riley-o-neil-k3j9@jam.local");
    expect(guestEmail("🎧", "k3j9")).toBe("guest-k3j9@jam.local");
  });

  it("says why a Jam ended", () => {
    expect(endedLine(makeJam({ status: "ended", endedReason: "host" }))).toBe("Lee ended the Jam.");
    expect(endedLine(makeJam({ status: "ended", endedReason: "idle" }))).toBe(
      "Nothing played for a while.",
    );
  });
});
