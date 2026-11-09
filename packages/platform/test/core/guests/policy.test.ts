import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { levels } from "../../../commands/access";
import type { Level, LibraryId, Restrictions } from "../../../commands/access";
import { roleScopes } from "../../../commands/scopes";
import type { CredentialScope, Role } from "../../../commands/scopes";
import type { Id, TableNames } from "../../../convex/_generated/dataModel";
import { SERVER, accountTarget, can, itemOf } from "../../../convex/core/permissions/policy";
import type {
  ContentResource,
  Decision,
  Principal,
  ShareAbout,
  ShareAction,
  ShareRecordAction,
  ShareResource,
  TogetherAction,
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

type PersonPrincipal = Extract<Principal, { readonly kind: "person" }>;

const KID: Restrictions = {
  maxMovieAge: 7,
  hideUnrated: true,
  hideExplicitMusic: true,
  libraries: null,
};

const personOf = (
  name: string,
  role: Role,
  scopes: ReadonlyArray<CredentialScope> = roleScopes[role],
  restrictions: Restrictions | null = null,
): PersonPrincipal => ({
  kind: "person",
  userId: idOf("users", name),
  role,
  scopes,
  restrictions,
  sessionKind: "password",
});

const OWNER = personOf("owner", "owner");

const ADMIN = personOf("admin", "admin");

const MEMBER = personOf("member", "member");

const KID_MEMBER = personOf("kid", "member", roleScopes.member, KID);

const GUEST = personOf("guest", "guest");

const TILE = personOf("tile", "member", ["movies:read", "movies:play", "music:read", "music:play"]);

const SERVICE: Principal = { kind: "service", userId: idOf("users", "server"), scopes: [] };

const FILMS: LibraryId = idOf("libraries", "films");

const library = {
  _id: FILMS,
  _creationTime: 0,
  name: "Films",
  kind: "movies" as const,
  lastScan: null,
};

const movieAt = (level: Level | null, age = 0): ContentResource =>
  itemOf(library, level, { domain: "movies", rating: { kind: "rated", age } });

const G_AT_VIEW = movieAt("view");

const R_AT_VIEW = movieAt("view", 17);

const togetherAs = (
  place: TogetherPlace,
  facts: { readonly live?: boolean; readonly invited?: boolean } = {},
  settings: Partial<{ join: "open" | "approval" | "locked"; control: boolean; add: boolean }> = {},
): TogetherResource => ({
  on: "together",
  domain: "movies",
  session: {
    live: facts.live ?? true,
    place,
    settings: { join: "open", control: false, add: false, ...settings },
    addedIt: false,
    invited: facts.invited ?? false,
  },
});

interface Link {
  readonly switchedOn?: boolean;
  readonly maker?: PersonPrincipal;
  readonly allowed?: boolean;
  readonly backs?: boolean;
  readonly state?: "open" | "revoked" | "expired";
  readonly mine?: boolean;
}

const linkFor = (about: ShareAbout, facts: Link = {}): ShareResource => ({
  on: "share",
  switchedOn: facts.switchedOn ?? true,
  maker: {
    principal: facts.maker ?? MEMBER,
    allowed: facts.allowed ?? true,
    backs: facts.backs ?? true,
  },
  link: { state: facts.state ?? "open", mine: facts.mine ?? true },
  about,
});

const newLink = (
  maker: PersonPrincipal,
  about: ShareAbout,
  facts: Pick<Link, "switchedOn" | "allowed"> = {},
): ShareResource => ({
  on: "share",
  switchedOn: facts.switchedOn ?? true,
  maker: { principal: maker, allowed: facts.allowed ?? false, backs: true },
  link: "new",
  about,
});

const itemTarget = (content: ContentResource | null): ShareAbout => ({
  kind: "target",
  target: { kind: "item", content },
});

const sessionTarget = (session: TogetherResource): ShareAbout => ({
  kind: "target",
  target: { kind: "session", session },
});

const STANDING: ShareAbout = { kind: "standing" };

const asked = (
  content: ContentResource | null,
  facts: {
    readonly covered?: boolean;
    readonly seat?: { readonly place: TogetherPlace; readonly live: boolean };
  } = {},
): ShareAbout => ({
  kind: "item",
  covered: facts.covered ?? true,
  content,
  seat: facts.seat ?? null,
});

type Outcome = "allowed" | `${"hidden" | "forbidden"} ${string}`;

const outcomeOf = (decision: Decision): Outcome =>
  decision.allowed ? "allowed" : `${decision.refusal} ${decision.because}`;

const share = (principal: Principal, action: ShareAction, resource: ShareResource): Outcome =>
  outcomeOf(can(principal, action, resource));

const record = (maker: Id<"users"> | null) => ({ on: "shareRecord", maker }) as const;

const decideRecord = (principal: Principal, action: ShareRecordAction, maker: Id<"users"> | null) =>
  outcomeOf(can(principal, action, record(maker)));

const accountOf = (role: Role) => {
  const fields = {
    _id: idOf("users", role),
    _creationTime: 0,
    kind: "person" as const,
    username: role,
    usernameKey: role,
    sessionGeneration: 0,
    keyGeneration: 0,
  };

  return accountTarget(
    role === "guest" ? { ...fields, role, link: idOf("shareLinks", "link") } : { ...fields, role },
  );
};

const together = (principal: Principal, action: TogetherAction, resource: TogetherResource) =>
  outcomeOf(can(principal, action, resource));

describe("who may make a guest link", () => {
  it.each<readonly [string, PersonPrincipal, ShareResource, Outcome]>([
    [
      "the owner, to a movie they can play",
      OWNER,
      newLink(OWNER, itemTarget(G_AT_VIEW)),
      "allowed",
    ],
    ["an admin, without asking anyone", ADMIN, newLink(ADMIN, itemTarget(G_AT_VIEW)), "allowed"],
    [
      "a member an admin allowed",
      MEMBER,
      newLink(MEMBER, itemTarget(G_AT_VIEW), { allowed: true }),
      "allowed",
    ],
    [
      "not a member no admin allowed",
      MEMBER,
      newLink(MEMBER, itemTarget(G_AT_VIEW)),
      "forbidden not-allowed",
    ],
    [
      "nobody while guest links are off, the owner included",
      OWNER,
      newLink(OWNER, itemTarget(G_AT_VIEW), { switchedOn: false }),
      "forbidden switched-off",
    ],
    [
      "not a member allowed but switched off",
      MEMBER,
      newLink(MEMBER, itemTarget(G_AT_VIEW), { switchedOn: false, allowed: true }),
      "forbidden switched-off",
    ],
    ["never a guest", GUEST, newLink(GUEST, itemTarget(G_AT_VIEW)), "forbidden guest"],
    [
      "not from a session without the account scope, such as a shared-device tile",
      TILE,
      newLink(TILE, itemTarget(G_AT_VIEW), { allowed: true }),
      "forbidden scope",
    ],
    [
      "not to something the maker has no grant on",
      OWNER,
      newLink(OWNER, itemTarget(movieAt(null))),
      "hidden no-grant",
    ],
    [
      "not to something a kid's restrictions hide from them",
      KID_MEMBER,
      newLink(KID_MEMBER, itemTarget(R_AT_VIEW), { allowed: true }),
      "hidden restricted",
    ],
    [
      "not to an item that does not exist",
      OWNER,
      newLink(OWNER, itemTarget(null)),
      "hidden missing",
    ],
    [
      "the host, to their live group session",
      OWNER,
      newLink(OWNER, sessionTarget(togetherAs("host"))),
      "allowed",
    ],
    [
      "not a guest of someone else's session",
      OWNER,
      newLink(OWNER, sessionTarget(togetherAs("guest"))),
      "forbidden not-host",
    ],
    [
      "not to a session that ended",
      OWNER,
      newLink(OWNER, sessionTarget(togetherAs("host", { live: false }))),
      "forbidden ended",
    ],
    [
      "not to a session they are not in",
      OWNER,
      newLink(OWNER, sessionTarget(togetherAs("outside"))),
      "hidden outside",
    ],
  ])("%s", (_name, principal, resource, outcome) => {
    expect(share(principal, "make", resource)).toBe(outcome);
  });

  it("refuses a service as if links did not exist", () => {
    expect(share(SERVICE, "make", newLink(OWNER, itemTarget(G_AT_VIEW)))).toBe("hidden service");
  });

  it("refuses an API key, whatever its scopes, both making a link and offering to", () => {
    const viaKey: PersonPrincipal = { ...OWNER, sessionKind: "apiKey" };

    expect(share(viaKey, "make", newLink(viaKey, itemTarget(G_AT_VIEW)))).toBe("forbidden api-key");
    expect(share(viaKey, "offer", newLink(viaKey, STANDING))).toBe("forbidden api-key");
    expect(share(OWNER, "offer", newLink(OWNER, STANDING))).toBe("allowed");
  });

  it("decides a new link only for its own maker", () => {
    expect(() => can(ADMIN, "make", newLink(OWNER, itemTarget(G_AT_VIEW)))).toThrow();
    expect(() => can(OWNER, "make", linkFor(itemTarget(G_AT_VIEW), { maker: OWNER }))).toThrow();
  });
});

describe("whether a link still holds for its guests", () => {
  it.each<readonly [string, ShareResource, Outcome]>([
    ["an open link, made while guest links were on", linkFor(STANDING), "allowed"],
    [
      "a revoked link stops before it expires",
      linkFor(STANDING, { state: "revoked" }),
      "forbidden revoked",
    ],
    ["an expired link", linkFor(STANDING, { state: "expired" }), "forbidden expired"],
    [
      "guest links turned off, or off and on again since it was made",
      linkFor(STANDING, { switchedOn: false }),
      "forbidden switched-off",
    ],
    [
      "a maker an admin stopped letting share",
      linkFor(STANDING, { allowed: false }),
      "forbidden not-allowed",
    ],
    [
      "a maker who signed out everywhere, was demoted, or lost the right in between",
      linkFor(STANDING, { backs: false }),
      "forbidden unbacked",
    ],
    [
      "an admin maker needs no permission of their own",
      linkFor(STANDING, { maker: ADMIN, allowed: false }),
      "allowed",
    ],
    ["another link's guest", linkFor(STANDING, { mine: false }), "hidden not-yours"],
  ])("%s", (_name, resource, outcome) => {
    expect(share(GUEST, "hold", resource)).toBe(outcome);
  });

  it("holds only for a guest, never for a household person or a service", () => {
    expect(share(MEMBER, "hold", linkFor(STANDING))).toBe("hidden not-yours");
    expect(share(SERVICE, "hold", linkFor(STANDING))).toBe("hidden service");
  });

  it.each<readonly [string, ShareResource, Outcome]>([
    ["what the maker can still play", linkFor(itemTarget(G_AT_VIEW)), "allowed"],
    [
      "not once the maker lost their grant on it",
      linkFor(itemTarget(movieAt(null))),
      "hidden no-grant",
    ],
    [
      "not what a kid maker's restrictions hide",
      linkFor(itemTarget(R_AT_VIEW), { maker: KID_MEMBER }),
      "hidden restricted",
    ],
    [
      "the group session its maker still hosts",
      linkFor(sessionTarget(togetherAs("host"))),
      "allowed",
    ],
    [
      "not a group session that ended",
      linkFor(sessionTarget(togetherAs("host", { live: false }))),
      "forbidden ended",
    ],
    [
      "not a revoked link",
      linkFor(itemTarget(G_AT_VIEW), { state: "revoked" }),
      "forbidden revoked",
    ],
  ])("opens to %s", (_name, resource, outcome) => {
    expect(share(GUEST, "open", resource)).toBe(outcome);
  });

  it("decides each action only on the facts it reads", () => {
    expect(() => can(GUEST, "hold", linkFor(itemTarget(G_AT_VIEW)))).toThrow();
    expect(() => can(GUEST, "open", linkFor(STANDING))).toThrow();
    expect(() => can(GUEST, "play", linkFor(STANDING))).toThrow();
  });
});

describe("what a guest may play", () => {
  it.each<readonly [string, PersonPrincipal, ShareResource, Outcome]>([
    [
      "what the link names, while the maker can play it",
      GUEST,
      linkFor(asked(G_AT_VIEW)),
      "allowed",
    ],
    [
      "nothing else, not even in the same library",
      GUEST,
      linkFor(asked(G_AT_VIEW, { covered: false })),
      "hidden not-shared",
    ],
    ["nothing that does not exist", GUEST, linkFor(asked(null)), "hidden not-shared"],
    ["nothing the maker lost access to", GUEST, linkFor(asked(movieAt(null))), "hidden no-grant"],
    [
      "nothing a kid maker's restrictions hide",
      GUEST,
      linkFor(asked(R_AT_VIEW), { maker: KID_MEMBER }),
      "hidden restricted",
    ],
    [
      "nothing once the link is revoked",
      GUEST,
      linkFor(asked(G_AT_VIEW), { state: "revoked" }),
      "forbidden revoked",
    ],
    [
      "nothing without the domain's play scope",
      personOf("guest", "guest", ["music:play"]),
      linkFor(asked(G_AT_VIEW)),
      "forbidden scope",
    ],
    [
      "a session's item once the host let them in",
      GUEST,
      linkFor(asked(G_AT_VIEW, { seat: { place: "guest", live: true } })),
      "allowed",
    ],
    [
      "nothing in a session while they wait for the host",
      GUEST,
      linkFor(asked(G_AT_VIEW, { seat: { place: "pending", live: true } })),
      "forbidden pending",
    ],
    [
      "nothing in a session the host removed them from",
      GUEST,
      linkFor(asked(G_AT_VIEW, { seat: { place: "blocked", live: true } })),
      "hidden outside",
    ],
    [
      "nothing in a session that ended",
      GUEST,
      linkFor(asked(G_AT_VIEW, { seat: { place: "guest", live: false } })),
      "forbidden ended",
    ],
  ])("%s", (_name, principal, resource, outcome) => {
    expect(share(principal, "play", resource)).toBe(outcome);
  });

  it("never plays what its maker could not, whatever the maker's level and restrictions", () => {
    const restrictions: fc.Arbitrary<Restrictions | null> = fc.option(
      fc.record({
        maxMovieAge: fc.option(fc.integer({ min: 0, max: 21 }), { nil: null }),
        hideUnrated: fc.boolean(),
        hideExplicitMusic: fc.boolean(),
        libraries: fc.option(fc.subarray([FILMS, idOf("libraries", "records")]), { nil: null }),
      }),
      { nil: null },
    );

    fc.assert(
      fc.property(
        restrictions,
        fc.option(fc.constantFrom(...levels), { nil: null }),
        fc.option(fc.integer({ min: 0, max: 21 }), { nil: null }),
        (limits, level, age) => {
          const maker = personOf("maker", "member", roleScopes.member, limits);

          const content = itemOf(library, level, {
            domain: "movies",
            rating: age === null ? { kind: "unrated" } : { kind: "rated", age },
          });

          const guestPlays = can(GUEST, "play", linkFor(asked(content), { maker })).allowed;
          const makerPlays = can(maker, "play", content).allowed;

          return !guestPlays || makerPlays;
        },
      ),
    );
  });

  it("gives a guest nothing through grants: no browsing, searching, or editing", () => {
    for (const action of ["view", "play", "edit", "manage"] as const) {
      expect(outcomeOf(can(GUEST, action, movieAt(null)))).toBe("hidden no-grant");
    }
  });
});

describe("who may read and revoke a link", () => {
  it.each<readonly [string, Principal, ShareRecordAction, Id<"users"> | null, Outcome]>([
    ["its maker reads its activity", MEMBER, "audit", MEMBER.userId, "allowed"],
    ["its maker revokes it", MEMBER, "revoke", MEMBER.userId, "allowed"],
    ["its maker sees what it names", MEMBER, "see", MEMBER.userId, "allowed"],
    ["an admin reads anyone's activity", ADMIN, "audit", MEMBER.userId, "allowed"],
    ["an admin revokes anyone's", ADMIN, "revoke", MEMBER.userId, "allowed"],
    [
      "an admin never sees what someone else's names",
      ADMIN,
      "see",
      MEMBER.userId,
      "hidden not-yours",
    ],
    ["an admin lists everyone's", ADMIN, "audit", null, "allowed"],
    ["a member cannot read someone else's", MEMBER, "audit", ADMIN.userId, "hidden not-yours"],
    ["a member cannot revoke someone else's", MEMBER, "revoke", ADMIN.userId, "hidden not-yours"],
    ["a member cannot list everyone's", MEMBER, "audit", null, "hidden not-yours"],
    ["a guest reads no link", GUEST, "audit", GUEST.userId, "hidden guest"],
    ["a service reads no link", SERVICE, "audit", null, "hidden service"],
    [
      "its maker needs the account scope",
      personOf("member", "member", ["movies:play"]),
      "revoke",
      MEMBER.userId,
      "forbidden scope",
    ],
  ])("%s", (_name, principal, action, maker, outcome) => {
    expect(decideRecord(principal, action, maker)).toBe(outcome);
  });
});

describe("the admin switch and the permission", () => {
  it("lets only an admin turn guest links on or off", () => {
    expect(outcomeOf(can(ADMIN, "configureGuests", SERVER))).toBe("allowed");
    expect(outcomeOf(can(OWNER, "configureGuests", SERVER))).toBe("allowed");
    expect(outcomeOf(can(MEMBER, "configureGuests", SERVER))).toBe("forbidden scope");
    expect(outcomeOf(can(GUEST, "configureGuests", SERVER))).toBe("forbidden scope");
  });

  it.each<readonly [string, Principal, Role, Outcome]>([
    ["an admin allows a member", ADMIN, "member", "allowed"],
    ["the owner allows a member", OWNER, "member", "allowed"],
    ["no one allows an admin, who always may", OWNER, "admin", "forbidden target-role"],
    ["no one allows a guest", ADMIN, "guest", "forbidden target-role"],
    ["a member allows no one", MEMBER, "member", "forbidden scope"],
  ])("%s", (_name, principal, role, outcome) => {
    expect(outcomeOf(can(principal, "allowSharing", accountOf(role)))).toBe(outcome);
  });
});

describe("guests in group sessions", () => {
  it.each<readonly [string, "join" | "ask", TogetherResource, Outcome]>([
    [
      "joins an open session their link names",
      "join",
      togetherAs("outside", { invited: true }),
      "allowed",
    ],
    [
      "waits for the host of an approval session their link names",
      "ask",
      togetherAs("outside", { invited: true }, { join: "approval" }),
      "allowed",
    ],
    [
      "cannot enter a locked session, link or not",
      "join",
      togetherAs("outside", { invited: true }, { join: "locked" }),
      "forbidden locked",
    ],
    [
      "cannot come back once the host removed them",
      "join",
      togetherAs("blocked", { invited: true }),
      "forbidden blocked",
    ],
    ["never joins by a join link", "join", togetherAs("outside"), "forbidden guest"],
  ])("a guest %s", (_name, action, resource, outcome) => {
    expect(together(GUEST, action, resource)).toBe(outcome);
  });

  it("lets a guest control playback when the host allows it, and never queue", () => {
    expect(together(GUEST, "control", togetherAs("guest", {}, { control: true }))).toBe("allowed");
    expect(together(GUEST, "control", togetherAs("guest"))).toBe("forbidden no-control");
    expect(together(GUEST, "add", togetherAs("guest", {}, { add: true }))).toBe("forbidden guest");
    expect(together(GUEST, "remove", togetherAs("guest", {}, { add: true }))).toBe(
      "forbidden guest",
    );
    expect(together(MEMBER, "add", togetherAs("guest", {}, { add: true }))).toBe("allowed");
  });
});
