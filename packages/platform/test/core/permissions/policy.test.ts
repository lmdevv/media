import { describe, expect, it } from "vitest";

import { levels } from "../../../commands/access";
import type { Level, LibraryId, Restrictions } from "../../../commands/access";
import { credentialScopes, roleScopes } from "../../../commands/scopes";
import type { ContentDomain, CredentialScope, Role } from "../../../commands/scopes";
import type { Doc, Id, TableNames } from "../../../convex/_generated/dataModel";
import {
  SERVER,
  accountActions,
  accountTarget,
  can,
  contentActions,
  endsCredentials,
  heldScopes,
  isKid,
  principalOf,
  serverActions,
} from "../../../convex/core/permissions/policy";
import type {
  AccountAction,
  AccountResource,
  Because,
  ContentAction,
  ContentFacts,
  ContentResource,
  Decision,
  Principal,
  Rating,
  ServerAction,
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

const generations = { sessionGeneration: 0, keyGeneration: 0 };

const personRow = (name: string, role: Exclude<Role, "member">): Doc<"users"> => ({
  _id: idOf("users", name),
  _creationTime: 0,
  kind: "person",
  username: name,
  usernameKey: name,
  role,
  ...generations,
});

const memberRow = (name: string, restrictions?: Restrictions): Doc<"users"> => {
  const row: Extract<Doc<"users">, { readonly role: "member" }> = {
    _id: idOf("users", name),
    _creationTime: 0,
    kind: "person",
    username: name,
    usernameKey: name,
    role: "member",
    ...generations,
  };

  if (restrictions !== undefined) row.restrictions = restrictions;

  return row;
};

const serviceRow: Doc<"users"> = {
  _id: idOf("users", "media-server"),
  _creationTime: 0,
  kind: "service",
  name: "media server",
  ...generations,
};

const library1: LibraryId = idOf("libraries", "library-1");

const library2: LibraryId = idOf("libraries", "library-2");

const kidLimits: Restrictions = {
  maxMovieAge: 7,
  hideUnrated: false,
  hideExplicitMusic: true,
  libraries: null,
};

const strictLimits: Restrictions = {
  maxMovieAge: null,
  hideUnrated: true,
  hideExplicitMusic: false,
  libraries: [library1],
};

const rows = {
  owner: personRow("owner", "owner"),
  admin: personRow("admin", "admin"),
  otherAdmin: personRow("other-admin", "admin"),
  member: memberRow("member"),
  otherMember: memberRow("other-member"),
  kid: memberRow("kid", kidLimits),
  strictKid: memberRow("strict-kid", strictLimits),
  guest: personRow("guest", "guest"),
  service: serviceRow,
};

const keySession = (user: Doc<"users">, scopes: Array<CredentialScope>): Doc<"authSessions"> => ({
  _id: idOf("authSessions", `${user._id}-key`),
  _creationTime: 0,
  userId: user._id,
  expirationTime: 1,
  generation: 0,
  kind: "apiKey",
  keyId: idOf("apiKeys", `${user._id}-key`),
  scopes,
});

const deviceSession = (
  user: Doc<"users">,
  scopes: Array<CredentialScope>,
): Doc<"authSessions"> => ({
  _id: idOf("authSessions", `${user._id}-device`),
  _creationTime: 0,
  userId: user._id,
  expirationTime: 1,
  generation: 0,
  kind: "deviceCode",
  scopes,
  clientName: "tv",
});

const passwordSession = (user: Doc<"users">): Doc<"authSessions"> => ({
  _id: idOf("authSessions", `${user._id}-password`),
  _creationTime: 0,
  userId: user._id,
  expirationTime: 1,
  generation: 0,
  kind: "password",
});

const as = {
  owner: principalOf(rows.owner),
  admin: principalOf(rows.admin),
  member: principalOf(rows.member),
  kid: principalOf(rows.kid),
  strictKid: principalOf(rows.strictKid),
  guest: principalOf(rows.guest),
  service: principalOf(rows.service),
  musicPlayKey: principalOf(
    rows.member,
    heldScopes(keySession(rows.member, ["music:play"]), rows.member),
  ),
  adminAccountKey: principalOf(
    rows.admin,
    heldScopes(keySession(rows.admin, ["account"]), rows.admin),
  ),
};

const rated = (age: number): Rating => ({ kind: "rated", age });

const UNRATED: Rating = { kind: "unrated" };

const movie = (
  level: Level | null,
  rating: Rating = rated(13),
  library = library1,
): ContentResource => ({
  on: "content",
  domain: "movies",
  level,
  placement: { in: "item", library, facts: { domain: "movies", rating } },
});

const song = (level: Level | null, explicit = false, library = library1): ContentResource => ({
  on: "content",
  domain: "music",
  level,
  placement: { in: "item", library, facts: { domain: "music", explicit } },
});

const libraryAt = (
  domain: ContentDomain,
  level: Level | null,
  library = library1,
): ContentResource => ({ on: "content", domain, level, placement: { in: "library", library } });

/** A thing in no one library, such as a playlist: a container unless given facts. */
const unplaced = (
  domain: ContentDomain,
  level: Level | null,
  libraryList: "hides" | "allows",
  facts: ContentFacts | "container" = "container",
): ContentResource => ({
  on: "content",
  domain,
  level,
  placement: { in: "unplaced", libraryList, facts },
});

type Expected = "allowed" | readonly ["hidden" | "forbidden", Because];

const outcome = (decision: Decision): Expected =>
  decision.allowed ? "allowed" : [decision.refusal, decision.because];

interface Row<Action, Resource> {
  readonly name: string;
  readonly principal: Principal;
  readonly action: Action;
  readonly resource: Resource;
  readonly expected: Expected;
}

const contentRows: ReadonlyArray<Row<ContentAction, ContentResource>> = [
  {
    name: "a member views a movie shared with them",
    principal: as.member,
    action: "view",
    resource: movie("view"),
    expected: "allowed",
  },
  {
    name: "an admin gets nothing without a grant",
    principal: as.admin,
    action: "view",
    resource: movie(null),
    expected: ["hidden", "no-grant"],
  },
  {
    name: "the owner gets nothing without a grant",
    principal: as.owner,
    action: "manage",
    resource: song(null),
    expected: ["hidden", "no-grant"],
  },
  {
    name: "a service sees no content through app calls",
    principal: as.service,
    action: "view",
    resource: movie("manage"),
    expected: ["hidden", "service"],
  },
  {
    name: "a kid capped at 7 cannot see a 13 movie",
    principal: as.kid,
    action: "view",
    resource: movie("view", rated(13)),
    expected: ["hidden", "restricted"],
  },
  {
    name: "a kid capped at 7 sees a 7 movie",
    principal: as.kid,
    action: "view",
    resource: movie("view", rated(7)),
    expected: "allowed",
  },
  {
    name: "a kid who may see unrated movies sees one",
    principal: as.kid,
    action: "view",
    resource: movie("view", UNRATED),
    expected: "allowed",
  },
  {
    name: "hiding unrated hides an unrated movie",
    principal: as.strictKid,
    action: "view",
    resource: movie("view", UNRATED),
    expected: ["hidden", "restricted"],
  },
  {
    name: "hiding explicit music hides an explicit song",
    principal: as.kid,
    action: "play",
    resource: song("view", true),
    expected: ["hidden", "restricted"],
  },
  {
    name: "hiding explicit music keeps a clean song",
    principal: as.kid,
    action: "play",
    resource: song("view", false),
    expected: "allowed",
  },
  {
    name: "an allowed-libraries list hides another library",
    principal: as.strictKid,
    action: "view",
    resource: song("view", false, library2),
    expected: ["hidden", "restricted"],
  },
  {
    name: "an allowed-libraries list keeps its library",
    principal: as.strictKid,
    action: "view",
    resource: song("view", false, library1),
    expected: "allowed",
  },
  {
    name: "an allowed-libraries list keeps a library it names",
    principal: as.strictKid,
    action: "view",
    resource: libraryAt("music", "view", library1),
    expected: "allowed",
  },
  {
    name: "an allowed-libraries list hides a library it does not name",
    principal: as.strictKid,
    action: "view",
    resource: libraryAt("movies", "view", library2),
    expected: ["hidden", "restricted"],
  },
  {
    name: "ratings never hide a library",
    principal: principalOf(
      memberRow("rated-kid", {
        maxMovieAge: 0,
        hideUnrated: true,
        hideExplicitMusic: true,
        libraries: null,
      }),
    ),
    action: "view",
    resource: libraryAt("movies", "view"),
    expected: "allowed",
  },
  {
    name: "an allowed-libraries list hides an unplaced thing that it hides",
    principal: as.strictKid,
    action: "view",
    resource: unplaced("music", "view", "hides"),
    expected: ["hidden", "restricted"],
  },
  {
    name: "an allowed-libraries list keeps an unplaced thing that it allows",
    principal: as.strictKid,
    action: "view",
    resource: unplaced("music", "view", "allows"),
    expected: "allowed",
  },
  {
    name: "with no allowed-libraries list an unplaced thing that it would hide stays",
    principal: as.kid,
    action: "view",
    resource: unplaced("movies", "view", "hides"),
    expected: "allowed",
  },
  {
    name: "rating limits pass over an unplaced container",
    principal: as.kid,
    action: "play",
    resource: unplaced("movies", "view", "allows"),
    expected: "allowed",
  },
  {
    name: "a rating limit hides an unplaced movie rated above it",
    principal: as.kid,
    action: "view",
    resource: unplaced("movies", "view", "allows", { domain: "movies", rating: rated(13) }),
    expected: ["hidden", "restricted"],
  },
  {
    name: "hiding explicit music hides an unplaced explicit song",
    principal: as.kid,
    action: "play",
    resource: unplaced("music", "view", "allows", { domain: "music", explicit: true }),
    expected: ["hidden", "restricted"],
  },
  {
    name: "hiding unrated hides an unplaced unrated movie the list allows",
    principal: as.strictKid,
    action: "view",
    resource: unplaced("movies", "view", "allows", { domain: "movies", rating: UNRATED }),
    expected: ["hidden", "restricted"],
  },
  {
    name: "a music:play key cannot play a movie",
    principal: as.musicPlayKey,
    action: "play",
    resource: movie("view"),
    expected: ["forbidden", "scope"],
  },
  {
    name: "a music:play key plays a song",
    principal: as.musicPlayKey,
    action: "play",
    resource: song("view"),
    expected: "allowed",
  },
  {
    name: "a music:play key cannot browse music",
    principal: as.musicPlayKey,
    action: "view",
    resource: song("view"),
    expected: ["forbidden", "scope"],
  },
  {
    name: "a view grant does not edit",
    principal: as.member,
    action: "edit",
    resource: song("view"),
    expected: ["forbidden", "level"],
  },
  {
    name: "an edit grant does not manage",
    principal: as.member,
    action: "manage",
    resource: song("edit"),
    expected: ["forbidden", "level"],
  },
  {
    name: "a manage grant shares",
    principal: as.member,
    action: "manage",
    resource: movie("manage"),
    expected: "allowed",
  },
  {
    name: "a guest cannot browse",
    principal: as.guest,
    action: "view",
    resource: movie("view"),
    expected: ["forbidden", "scope"],
  },
  {
    name: "a guest plays what they were given",
    principal: as.guest,
    action: "play",
    resource: movie("view"),
    expected: "allowed",
  },
  {
    name: "a guest cannot edit",
    principal: as.guest,
    action: "edit",
    resource: movie("manage"),
    expected: ["forbidden", "scope"],
  },
];

const target = (user: Doc<"users">): AccountResource => accountTarget(user);

const accountRows: ReadonlyArray<Row<AccountAction, AccountResource>> = [
  {
    name: "an admin promotes a member",
    principal: as.admin,
    action: "promote",
    resource: target(rows.member),
    expected: "allowed",
  },
  {
    name: "an admin demotes another admin",
    principal: as.admin,
    action: "demote",
    resource: target(rows.otherAdmin),
    expected: "allowed",
  },
  {
    name: "nobody promotes a kid",
    principal: as.admin,
    action: "promote",
    resource: target(rows.kid),
    expected: ["forbidden", "restricted-target"],
  },
  {
    name: "an admin keeps a kid a member",
    principal: as.admin,
    action: "demote",
    resource: target(rows.kid),
    expected: "allowed",
  },
  {
    name: "no admin changes the owner's role",
    principal: as.admin,
    action: "demote",
    resource: target(rows.owner),
    expected: ["forbidden", "target-role"],
  },
  {
    name: "an admin cannot change their own role",
    principal: as.admin,
    action: "demote",
    resource: target(rows.admin),
    expected: ["forbidden", "self"],
  },
  {
    name: "the owner cannot change their own role",
    principal: as.owner,
    action: "demote",
    resource: target(rows.owner),
    expected: ["forbidden", "self"],
  },
  {
    name: "a member changes no one's role",
    principal: as.member,
    action: "demote",
    resource: target(rows.otherMember),
    expected: ["forbidden", "scope"],
  },
  {
    name: "a service never gets a role",
    principal: as.admin,
    action: "demote",
    resource: target(rows.service),
    expected: ["forbidden", "service-target"],
  },
  {
    name: "a guest's role changes only through their link",
    principal: as.admin,
    action: "demote",
    resource: target(rows.guest),
    expected: ["forbidden", "target-role"],
  },
  {
    name: "an admin restricts a member",
    principal: as.admin,
    action: "restrict",
    resource: target(rows.member),
    expected: "allowed",
  },
  {
    name: "nobody restricts an admin",
    principal: as.owner,
    action: "restrict",
    resource: target(rows.admin),
    expected: ["forbidden", "target-role"],
  },
  {
    name: "an admin cannot restrict themselves",
    principal: as.admin,
    action: "restrict",
    resource: target(rows.admin),
    expected: ["forbidden", "self"],
  },
  {
    name: "a kid cannot change their own restrictions",
    principal: as.kid,
    action: "restrict",
    resource: target(rows.kid),
    expected: ["forbidden", "scope"],
  },
  {
    name: "a kid sees their own restrictions",
    principal: as.kid,
    action: "viewRestrictions",
    resource: target(rows.kid),
    expected: "allowed",
  },
  {
    name: "a member cannot see a kid's restrictions",
    principal: as.member,
    action: "viewRestrictions",
    resource: target(rows.kid),
    expected: ["forbidden", "scope"],
  },
  {
    name: "an admin sees a kid's restrictions",
    principal: as.admin,
    action: "viewRestrictions",
    resource: target(rows.kid),
    expected: "allowed",
  },
  {
    name: "an admin sees that the owner has no restrictions",
    principal: as.admin,
    action: "viewRestrictions",
    resource: target(rows.owner),
    expected: "allowed",
  },
  {
    name: "an admin cannot hand over ownership",
    principal: as.admin,
    action: "handOverOwnership",
    resource: target(rows.member),
    expected: ["forbidden", "actor"],
  },
  {
    name: "the owner hands over to a member",
    principal: as.owner,
    action: "handOverOwnership",
    resource: target(rows.member),
    expected: "allowed",
  },
  {
    name: "the owner cannot hand over to a service",
    principal: as.owner,
    action: "handOverOwnership",
    resource: target(rows.service),
    expected: ["forbidden", "service-target"],
  },
  {
    name: "the owner cannot hand over to a kid",
    principal: as.owner,
    action: "handOverOwnership",
    resource: target(rows.kid),
    expected: ["forbidden", "restricted-target"],
  },
  {
    name: "the owner cannot hand over to themselves",
    principal: as.owner,
    action: "handOverOwnership",
    resource: target(rows.owner),
    expected: ["forbidden", "self"],
  },
  {
    name: "an admin resets a kid's password",
    principal: as.admin,
    action: "resetPassword",
    resource: target(rows.kid),
    expected: "allowed",
  },
  {
    name: "no admin resets a guest's password",
    principal: as.admin,
    action: "resetPassword",
    resource: target(rows.guest),
    expected: ["forbidden", "target-role"],
  },
  {
    name: "no admin resets the owner's password",
    principal: as.admin,
    action: "resetPassword",
    resource: target(rows.owner),
    expected: ["forbidden", "target-role"],
  },
  {
    name: "an admin adds themselves to a group",
    principal: as.admin,
    action: "joinGroup",
    resource: target(rows.admin),
    expected: "allowed",
  },
  {
    name: "a guest joins no group",
    principal: as.admin,
    action: "joinGroup",
    resource: target(rows.guest),
    expected: ["forbidden", "target-role"],
  },
  {
    name: "a key without admin manages no one",
    principal: as.adminAccountKey,
    action: "resetPassword",
    resource: target(rows.member),
    expected: ["forbidden", "scope"],
  },
];

const serverRows: ReadonlyArray<Row<ServerAction, typeof SERVER>> = [
  {
    name: "an admin key cut to account makes no invite",
    principal: as.adminAccountKey,
    action: "invite",
    resource: SERVER,
    expected: ["forbidden", "scope"],
  },
  {
    name: "an admin row alone makes invites",
    principal: as.admin,
    action: "invite",
    resource: SERVER,
    expected: "allowed",
  },
  {
    name: "a member makes no invite",
    principal: as.member,
    action: "invite",
    resource: SERVER,
    expected: ["forbidden", "scope"],
  },
  {
    name: "a member manages no groups",
    principal: as.member,
    action: "manageGroups",
    resource: SERVER,
    expected: ["forbidden", "scope"],
  },
  {
    name: "an admin points libraries at folders",
    principal: as.admin,
    action: "manageFolders",
    resource: SERVER,
    expected: "allowed",
  },
  {
    name: "a member points no library at a folder",
    principal: as.member,
    action: "manageFolders",
    resource: SERVER,
    expected: ["forbidden", "scope"],
  },
  {
    name: "an admin key cut to account points no library at a folder",
    principal: as.adminAccountKey,
    action: "manageFolders",
    resource: SERVER,
    expected: ["forbidden", "scope"],
  },
];

const domains: ReadonlyArray<ContentDomain> = ["movies", "music"];

const resourcesAt = (level: Level | null): ReadonlyArray<ContentResource> => [
  movie(level, rated(0)),
  movie(level, rated(17)),
  movie(level, UNRATED),
  song(level, true),
  song(level, false, library2),
  libraryAt("movies", level),
  libraryAt("music", level, library2),
  unplaced("movies", level, "hides"),
  unplaced("music", level, "allows"),
  unplaced("movies", level, "allows", { domain: "movies", rating: rated(17) }),
  unplaced("music", level, "hides", { domain: "music", explicit: true }),
];

const everyResource = [null, ...levels].flatMap(resourcesAt);

const restrictionSets: ReadonlyArray<Restrictions> = [
  kidLimits,
  strictLimits,
  { maxMovieAge: 0, hideUnrated: true, hideExplicitMusic: true, libraries: [] },
];

describe("can", () => {
  it.each(contentRows)("content: $name", ({ principal, action, resource, expected }) => {
    expect(outcome(can(principal, action, resource))).toEqual(expected);
  });

  it.each(accountRows)("accounts: $name", ({ principal, action, resource, expected }) => {
    expect(outcome(can(principal, action, resource))).toEqual(expected);
  });

  it.each(serverRows)("server: $name", ({ principal, action, resource, expected }) => {
    expect(outcome(can(principal, action, resource))).toEqual(expected);
  });

  it("decides content the same for a member, an admin, and the owner", () => {
    const differing = contentActions.flatMap((action) =>
      everyResource.flatMap((resource) => {
        const decisions = [as.member, as.admin, as.owner].map((principal) =>
          outcome(can(principal, action, resource)),
        );

        return decisions.every(
          (decision) => JSON.stringify(decision) === JSON.stringify(decisions[0]),
        )
          ? []
          : [{ action, resource, decisions }];
      }),
    );

    expect(differing).toEqual([]);
  });

  it("hides everything no grant reaches, from every role", () => {
    const principals = [as.owner, as.admin, as.member, as.kid, as.guest];

    const decisions = principals.flatMap((principal) =>
      contentActions.flatMap((action) =>
        resourcesAt(null).map((resource) => outcome(can(principal, action, resource))),
      ),
    );

    expect(new Set(decisions.map((decision) => JSON.stringify(decision)))).toEqual(
      new Set([JSON.stringify(["hidden", "no-grant"])]),
    );
  });

  it("lets restrictions only take away", () => {
    const granted = restrictionSets.flatMap((limits) =>
      contentActions.flatMap((action) =>
        everyResource.flatMap((resource) => {
          const kid = principalOf(memberRow("sweep-kid", limits));

          return can(kid, action, resource).allowed && !can(as.member, action, resource).allowed
            ? [{ limits, action, resource }]
            : [];
        }),
      ),
    );

    expect(granted).toEqual([]);
  });

  it("refuses a service every action", () => {
    const allowed = [
      ...contentActions.flatMap((action) =>
        everyResource.filter((resource) => can(as.service, action, resource).allowed),
      ),
      ...accountActions.filter((action) => can(as.service, action, target(rows.member)).allowed),
      ...serverActions.filter((action) => can(as.service, action, SERVER).allowed),
    ];

    expect(allowed).toEqual([]);
  });

  it("refuses a service any action that takes a scope", () => {
    const service = principalOf(rows.service, [...credentialScopes]);

    expect([
      ...accountActions.filter((action) => can(service, action, target(rows.member)).allowed),
      ...serverActions.filter((action) => can(service, action, SERVER).allowed),
      ...domains.flatMap((domain) =>
        contentActions.filter(
          (action) => can(service, action, unplaced(domain, "manage", "allows")).allowed,
        ),
      ),
    ]).toEqual([]);
  });
});

describe("server actions", () => {
  it("are an admin's and the owner's alone, managing folders included", () => {
    const allowed = serverActions.map((action) => [
      action,
      Object.entries(as).flatMap(([name, principal]) =>
        can(principal, action, SERVER).allowed ? [name] : [],
      ),
    ]);

    expect(serverActions).toContain("manageFolders");
    expect(allowed).toEqual(serverActions.map((action) => [action, ["owner", "admin"]]));
  });
});

describe("heldScopes", () => {
  const people = [rows.owner, rows.admin, rows.member, rows.guest];

  it("gives a password session every scope of the role", () => {
    expect(people.map((user) => heldScopes(passwordSession(user), user))).toEqual(
      people.map((user) => (user.kind === "person" ? [...roleScopes[user.role]] : [])),
    );
  });

  it("cuts a key's and a device's scopes to the role's", () => {
    const every = [...credentialScopes];

    expect(
      people.map((user) => [
        heldScopes(keySession(user, every), user),
        heldScopes(deviceSession(user, every), user),
      ]),
    ).toEqual(
      people.map((user) => {
        const role = user.kind === "person" ? [...roleScopes[user.role]] : [];

        return [role, role];
      }),
    );
  });

  it("gives a guest only play, and a service nothing", () => {
    expect(heldScopes(passwordSession(rows.guest), rows.guest)).toEqual([
      "movies:play",
      "music:play",
    ]);
    expect(heldScopes(passwordSession(rows.service), rows.service)).toEqual([]);
    expect(heldScopes(keySession(rows.service, [...credentialScopes]), rows.service)).toEqual([]);
  });
});

const asRole = (role: Role): Principal => ({
  kind: "person",
  userId: idOf("users", role),
  role,
  scopes: roleScopes[role],
  restrictions: null,
});

describe("endsCredentials", () => {
  const pairs = (["owner", "admin", "member", "guest"] as const).flatMap((from) =>
    (["owner", "admin", "member", "guest"] as const).map((to) => [from, to] as const),
  );

  it("ends credentials whenever a role change takes away making invites or reset links", () => {
    const missed = pairs.filter(([from, to]) => {
      const losesInvites =
        can(asRole(from), "invite", SERVER).allowed && !can(asRole(to), "invite", SERVER).allowed;

      const losesResets =
        can(asRole(from), "resetPassword", target(rows.member)).allowed &&
        !can(asRole(to), "resetPassword", target(rows.member)).allowed;

      return (losesInvites || losesResets) && !endsCredentials(from, to);
    });

    expect(missed).toEqual([]);
  });

  it("ends them for a demotion and keeps them for a promotion or a handover", () => {
    expect([
      endsCredentials("admin", "member"),
      endsCredentials("member", "admin"),
      endsCredentials("owner", "admin"),
      endsCredentials("member", "guest"),
    ]).toEqual([true, false, false, true]);
  });
});

describe("kids", () => {
  it("are members an admin restricted", () => {
    expect(
      Object.values(rows)
        .filter(isKid)
        .map((user) => user._id),
    ).toEqual([rows.kid._id, rows.strictKid._id]);
  });
});
