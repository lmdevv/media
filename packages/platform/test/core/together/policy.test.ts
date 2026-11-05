import { describe, expect, it } from "vitest";

import { roleScopes } from "../../../commands/scopes";
import type { CredentialScope, Role } from "../../../commands/scopes";
import type { Id, TableNames } from "../../../convex/_generated/dataModel";
import { can, togetherActions } from "../../../convex/core/permissions/policy";
import type { JoinSetting } from "../../../convex/core/together/model";
import type {
  Decision,
  Principal,
  TogetherAction,
  TogetherBecause,
  TogetherPlace,
  TogetherResource,
} from "../../../convex/core/permissions/policy";

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string; the
// policy only compares ids for equality and never sends one to a backend.
const isIdOf = <Table extends TableNames>(table: Table, value: string): value is Id<Table> =>
  value.startsWith(`${table}:`);

const idOf = <Table extends TableNames>(table: Table, name: string): Id<Table> => {
  const value = `${table}:${name}`;

  if (!isIdOf(table, value)) throw new Error(`${value} is not a ${table} id`);

  return value;
};

const KID = { maxMovieAge: 7, hideUnrated: true, hideExplicitMusic: true, libraries: null };

const personOf = (
  name: string,
  role: Role,
  scopes: ReadonlyArray<CredentialScope> = roleScopes[role],
  restrictions: typeof KID | null = null,
): Principal => ({ kind: "person", userId: idOf("users", name), role, scopes, restrictions });

const PEOPLE = {
  member: personOf("member", "member"),
  kid: personOf("kid", "member", roleScopes.member, KID),
  "platform guest": personOf("guest", "guest"),
  "movies-only key": personOf("key", "member", ["movies:read", "movies:play"]),
  service: { kind: "service", userId: idOf("users", "server"), scopes: [] },
} as const satisfies Readonly<Record<string, Principal>>;

const MEMBER = PEOPLE.member;

interface In {
  readonly place: TogetherPlace;
  readonly join?: JoinSetting;
  readonly control?: boolean;
  readonly add?: boolean;
  readonly live?: boolean;
  readonly addedIt?: boolean;
}

const sessionAt = (facts: In, domain: TogetherResource["domain"] = "movies"): TogetherResource => ({
  on: "together",
  domain,
  session: {
    live: facts.live ?? true,
    place: facts.place,
    settings: {
      join: facts.join ?? "open",
      control: facts.control ?? false,
      add: facts.add ?? false,
    },
    addedIt: facts.addedIt ?? false,
  },
});

const NO_SESSION: TogetherResource = { on: "together", domain: "movies", session: null };

type Outcome = "allowed" | `${"hidden" | "forbidden"} ${TogetherBecause}`;

const outcomeOf = (decision: Decision<TogetherBecause>): Outcome =>
  decision.allowed ? "allowed" : `${decision.refusal} ${decision.because}`;

const decide = (
  principal: Principal,
  action: TogetherAction,
  resource: TogetherResource,
): Outcome => outcomeOf(can(principal, action, resource));

describe("who may enter a group session", () => {
  it.each<readonly [string, TogetherAction, In, Outcome]>([
    ["an open session lets anyone with the link join", "join", { place: "outside" }, "allowed"],
    [
      "an approval session does not let them join directly",
      "join",
      { place: "outside", join: "approval" },
      "forbidden join-setting",
    ],
    [
      "an approval session lets them wait for the host",
      "ask",
      { place: "outside", join: "approval" },
      "allowed",
    ],
    ["an open session needs no waiting", "ask", { place: "outside" }, "forbidden join-setting"],
    [
      "a locked session refuses a new member",
      "join",
      { place: "outside", join: "locked" },
      "forbidden locked",
    ],
    [
      "a locked session refuses a request",
      "ask",
      { place: "outside", join: "locked" },
      "forbidden locked",
    ],
    [
      "a locked session still answers a member who joins again",
      "join",
      { place: "guest", join: "locked" },
      "allowed",
    ],
    ["a waiting person joins once the session is open", "join", { place: "pending" }, "allowed"],
    [
      "someone the host removed cannot come back by the link",
      "join",
      { place: "blocked" },
      "forbidden blocked",
    ],
    ["an ended session takes no one", "join", { place: "outside", live: false }, "forbidden ended"],
  ])("%s", (_name, action, facts, outcome) => {
    expect(decide(MEMBER, action, sessionAt(facts))).toBe(outcome);
  });

  it("lets a platform guest in only through the share link that names the session", () => {
    const guest = PEOPLE["platform guest"];

    expect(decide(guest, "join", sessionAt({ place: "outside" }))).toBe("forbidden guest");
    expect(decide(guest, "ask", sessionAt({ place: "outside", join: "approval" }))).toBe(
      "forbidden guest",
    );
    expect(decide(guest, "start", NO_SESSION)).toBe("forbidden guest");
  });

  it("lets a kid start and join, since what plays is checked item by item", () => {
    expect(decide(PEOPLE.kid, "start", NO_SESSION)).toBe("allowed");
    expect(decide(PEOPLE.kid, "join", sessionAt({ place: "outside" }))).toBe("allowed");
  });
});

describe("what a member may do in a group session", () => {
  it.each<readonly [string, TogetherAction, In, Outcome]>([
    [
      "a guest without control cannot change playback",
      "control",
      { place: "guest" },
      "forbidden no-control",
    ],
    [
      "a guest the host lets control changes playback",
      "control",
      { place: "guest", control: true },
      "allowed",
    ],
    ["the host always controls", "control", { place: "host" }, "allowed"],
    ["a guest without add cannot add items", "add", { place: "guest" }, "forbidden no-add"],
    ["a guest the host lets add adds", "add", { place: "guest", add: true }, "allowed"],
    ["the host always adds", "add", { place: "host" }, "allowed"],
    [
      "a guest who may add takes out what they queued",
      "remove",
      { place: "guest", add: true, addedIt: true },
      "allowed",
    ],
    [
      "a guest who may add cannot take out what others queued",
      "remove",
      { place: "guest", add: true },
      "forbidden not-yours",
    ],
    [
      "a guest who may not add cannot take out even their own",
      "remove",
      { place: "guest", addedIt: true },
      "forbidden no-add",
    ],
    ["the host takes out anything", "remove", { place: "host" }, "allowed"],
    ["a guest cannot let people in", "admit", { place: "guest" }, "forbidden not-host"],
    ["the host lets people in", "admit", { place: "host", join: "approval" }, "allowed"],
    [
      "the host cannot let anyone into a locked session",
      "admit",
      { place: "host", join: "locked" },
      "forbidden locked",
    ],
    ["a guest cannot change the settings", "manage", { place: "guest" }, "forbidden not-host"],
    ["the host changes the settings", "manage", { place: "host" }, "allowed"],
    ["a waiting person sees their own place", "see", { place: "pending" }, "allowed"],
    ["a waiting person cannot read the queue", "view", { place: "pending" }, "forbidden pending"],
    [
      "a waiting person cannot control even when guests may",
      "control",
      { place: "pending", control: true },
      "forbidden pending",
    ],
    ["a waiting person can stop waiting", "leave", { place: "pending" }, "allowed"],
    ["someone outside learns nothing", "see", { place: "outside" }, "hidden outside"],
    ["someone removed learns nothing", "view", { place: "blocked" }, "hidden outside"],
    [
      "nobody controls an ended session",
      "control",
      { place: "host", live: false },
      "forbidden ended",
    ],
    ["a member still sees an ended session", "see", { place: "guest", live: false }, "allowed"],
    ["a member leaves an ended session", "leave", { place: "guest", live: false }, "allowed"],
  ])("%s", (_name, action, facts, outcome) => {
    expect(decide(MEMBER, action, sessionAt(facts))).toBe(outcome);
  });

  it("lets a platform guest control inside their session only when the host allows it", () => {
    const guest = PEOPLE["platform guest"];

    expect(decide(guest, "control", sessionAt({ place: "guest" }))).toBe("forbidden no-control");
    expect(decide(guest, "control", sessionAt({ place: "guest", control: true }))).toBe("allowed");
    expect(decide(guest, "manage", sessionAt({ place: "guest", control: true }))).toBe(
      "forbidden not-host",
    );
  });

  it("needs the domain's play scope for every action", () => {
    const key = PEOPLE["movies-only key"];

    expect(decide(key, "control", sessionAt({ place: "host" }, "movies"))).toBe("allowed");

    for (const action of togetherActions) {
      const resource = action === "start" ? { ...NO_SESSION, domain: "music" as const } : null;

      expect(decide(key, action, resource ?? sessionAt({ place: "host" }, "music"))).toBe(
        "forbidden scope",
      );
    }
  });

  it("lets a credential without the play scope still leave, with the account scope", () => {
    const keeper = personOf("keeper", "member", ["account"]);

    expect(decide(keeper, "leave", sessionAt({ place: "host" }))).toBe("allowed");
    expect(decide(keeper, "see", sessionAt({ place: "host" }))).toBe("forbidden scope");
    expect(decide(keeper, "control", sessionAt({ place: "host" }))).toBe("forbidden scope");
  });

  it("answers a service as if no session existed, whatever it asks", () => {
    for (const action of togetherActions) {
      expect(decide(PEOPLE.service, action, sessionAt({ place: "host" }))).toBe("hidden service");
    }
  });

  it("answers someone in no session as if there were none, except to start one", () => {
    for (const action of togetherActions) {
      expect(decide(MEMBER, action, NO_SESSION)).toBe(
        action === "start" ? "allowed" : "hidden outside",
      );
    }
  });
});
