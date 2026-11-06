import { describe, expect, it } from "vitest";

import type { Restrictions } from "../../../commands/access";
import type { ContentDomain, CredentialScope, Role } from "../../../commands/scopes";
import type { Doc, Id, TableNames } from "../../../convex/_generated/dataModel";
import { can, principalOf } from "../../../convex/core/permissions/policy";
import type {
  Because,
  Decision,
  DeviceRelation,
  DeviceResource,
  Principal,
  SessionMembership,
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

const KID: Restrictions = {
  maxMovieAge: 7,
  hideUnrated: false,
  hideExplicitMusic: true,
  libraries: null,
};

const person = (name: string, role: Role, kid = false): Doc<"users"> => {
  const fields = {
    _id: idOf("users", name),
    _creationTime: 0,
    kind: "person" as const,
    username: name,
    usernameKey: name,
    sessionGeneration: 0,
    keyGeneration: 0,
  };

  if (role !== "member") return { ...fields, role };

  return kid ? { ...fields, role, restrictions: KID } : { ...fields, role };
};

const TILE: ReadonlyArray<CredentialScope> = [
  "movies:read",
  "movies:play",
  "movies:edit",
  "music:read",
  "music:play",
  "music:edit",
];

const as = {
  owner: principalOf(person("owner", "owner")),
  admin: principalOf(person("admin", "admin")),
  member: principalOf(person("dad", "member")),
  kid: principalOf(person("lily", "member", true)),
  tile: principalOf(person("mom", "member"), TILE),
  musicKey: principalOf(person("dad", "member"), ["music:play"]),
  readKey: principalOf(person("dad", "member"), ["movies:read", "music:read"]),
  guest: principalOf(person("guest", "guest")),
  service: principalOf({
    _id: idOf("users", "server"),
    _creationTime: 0,
    kind: "service",
    name: "media server",
    sessionGeneration: 0,
    keyGeneration: 0,
  }),
} satisfies Record<string, Principal>;

const own: DeviceRelation = { mode: "personal", signedInHere: true };

const someoneElses: DeviceRelation = { mode: "personal", signedInHere: false };

const listed: DeviceRelation = { mode: "shared", listed: true };

const unlisted: DeviceRelation = { mode: "shared", listed: false };

const CONTROL: SessionMembership = { control: true };

const NO_CONTROL: SessionMembership = { control: false };

const device = (
  relation: DeviceRelation,
  domain: ContentDomain | null = "movies",
  session: SessionMembership | null = null,
): DeviceResource => ({ on: "device", relation, domain, session });

const ALLOWED: Decision = { allowed: true };

const refused = (refusal: "hidden" | "forbidden", because: Because): Decision => ({
  allowed: false,
  refusal,
  because,
});

interface Row {
  readonly name: string;
  readonly principal: Principal;
  readonly device: DeviceResource;
  readonly expected: Decision;
}

const rows: ReadonlyArray<Row> = [
  {
    name: "lane 1: a person controls their own personal device",
    principal: as.member,
    device: device(own),
    expected: ALLOWED,
  },
  {
    name: "a kid controls their own personal device",
    principal: as.kid,
    device: device(own, "music"),
    expected: ALLOWED,
  },
  {
    name: "lane 2: a person controls a shared device that lists them",
    principal: as.member,
    device: device(listed),
    expected: ALLOWED,
  },
  {
    name: "a listed kid controls a shared device, whoever's tile plays on it",
    principal: as.kid,
    device: device(listed),
    expected: ALLOWED,
  },
  {
    name: "a tile on a shared device controls another shared device that lists its person",
    principal: as.tile,
    device: device(listed, "music"),
    expected: ALLOWED,
  },
  {
    name: "lane 3: a shared device that does not list the person stays hidden",
    principal: as.member,
    device: device(unlisted),
    expected: refused("hidden", "unlisted"),
  },
  {
    name: "an admin does not reach a shared device that does not list them",
    principal: as.admin,
    device: device(unlisted),
    expected: refused("hidden", "unlisted"),
  },
  {
    name: "lane 4: another person's personal device stays hidden",
    principal: as.member,
    device: device(someoneElses),
    expected: refused("hidden", "not-signed-in-here"),
  },
  {
    name: "the owner never reaches another person's personal device",
    principal: as.owner,
    device: device(someoneElses),
    expected: refused("hidden", "not-signed-in-here"),
  },
  {
    name: "lane 5: a guest controls a device playing their session when the host allows it",
    principal: as.guest,
    device: device(someoneElses, "movies", CONTROL),
    expected: ALLOWED,
  },
  {
    name: "lane 6: a guest is refused in a session whose host does not allow control",
    principal: as.guest,
    device: device(listed, "music", NO_CONTROL),
    expected: refused("forbidden", "no-control"),
  },
  {
    name: "a guest outside any session reaches no device, even one that would list them",
    principal: as.guest,
    device: device(listed),
    expected: refused("hidden", "guest"),
  },
  {
    name: "a guest controls nothing the session does not play",
    principal: as.guest,
    device: device(own),
    expected: refused("hidden", "guest"),
  },
  {
    name: "a person's own device follows the household rule, whatever a session allows",
    principal: as.member,
    device: device(own, "movies", NO_CONTROL),
    expected: ALLOWED,
  },
  {
    name: "a session does not open another person's personal device to a person",
    principal: as.member,
    device: device(someoneElses, "movies", CONTROL),
    expected: refused("hidden", "not-signed-in-here"),
  },
  {
    name: "a credential needs the play scope of what the device plays",
    principal: as.musicKey,
    device: device(own, "movies"),
    expected: refused("forbidden", "scope"),
  },
  {
    name: "the matching play scope is enough",
    principal: as.musicKey,
    device: device(listed, "music"),
    expected: ALLOWED,
  },
  {
    name: "a device playing nothing needs a play scope in any domain",
    principal: as.musicKey,
    device: device(own, null),
    expected: ALLOWED,
  },
  {
    name: "read scopes control nothing, even an idle device",
    principal: as.readKey,
    device: device(own, null),
    expected: refused("forbidden", "scope"),
  },
  {
    name: "a hidden device stays hidden before the scope is checked",
    principal: as.readKey,
    device: device(someoneElses),
    expected: refused("hidden", "not-signed-in-here"),
  },
  {
    name: "a service controls no device",
    principal: as.service,
    device: device(own),
    expected: refused("hidden", "service"),
  },
];

describe("who reports a device's playback", () => {
  it("is a session on the device that may play what it reports", () => {
    expect(can(as.tile, "report", device(listed, "music"))).toEqual(ALLOWED);
    expect(can(as.member, "report", device(own, null))).toEqual(ALLOWED);
  });

  it("refuses a report of a domain the session cannot play", () => {
    expect(can(as.musicKey, "report", device(own, "movies"))).toEqual(
      refused("forbidden", "scope"),
    );
  });

  it("refuses guests and services, whose devices are no players", () => {
    expect(can(as.guest, "report", device(own))).toEqual(refused("hidden", "guest"));
    expect(can(as.service, "report", device(own))).toEqual(refused("hidden", "service"));
  });
});

describe("who controls a device", () => {
  it.each(rows)("$name", ({ principal, device: resource, expected }) => {
    expect(can(principal, "control", resource)).toEqual(expected);
  });

  it("never lets a household person reach another person's personal device", () => {
    const people = [as.owner, as.admin, as.member, as.kid, as.tile, as.musicKey];
    const sessions = [null, CONTROL, NO_CONTROL];
    const domains = [null, "movies", "music"] as const;

    const decisions = people.flatMap((principal) =>
      sessions.flatMap((session) =>
        domains.map((domain) => can(principal, "control", device(someoneElses, domain, session))),
      ),
    );

    expect(decisions.every((decision) => !decision.allowed)).toBe(true);
  });
});
