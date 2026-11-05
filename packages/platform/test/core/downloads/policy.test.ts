import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { levels } from "../../../commands/access";
import type { Level, LibraryId, Restrictions } from "../../../commands/access";
import { credentialScopes, roleScopes } from "../../../commands/scopes";
import type { ContentDomain, CredentialScope, Role } from "../../../commands/scopes";
import type { Id, TableNames } from "../../../convex/_generated/dataModel";
import { can } from "../../../convex/core/permissions/policy";
import type {
  ContentFacts,
  ContentResource,
  DeviceMode,
  Principal,
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

const LIBRARIES: ReadonlyArray<LibraryId> = ["films", "records"].map((name) =>
  idOf("libraries", name),
);

const library = fc.constantFrom(...LIBRARIES);

const restrictions: fc.Arbitrary<Restrictions> = fc.record({
  maxMovieAge: fc.option(fc.integer({ min: 0, max: 21 }), { nil: null }),
  hideUnrated: fc.boolean(),
  hideExplicitMusic: fc.boolean(),
  libraries: fc.option(fc.subarray([...LIBRARIES]), { nil: null }),
});

const scopes = (role: Role): fc.Arbitrary<ReadonlyArray<CredentialScope>> =>
  fc.oneof(fc.constant(roleScopes[role]), fc.subarray([...credentialScopes]));

const person = (role: Role): fc.Arbitrary<Principal> =>
  fc.record({
    kind: fc.constant("person" as const),
    userId: fc.constant(idOf("users", role)),
    role: fc.constant(role),
    scopes: scopes(role),
    restrictions: role === "member" ? fc.option(restrictions, { nil: null }) : fc.constant(null),
  });

const people = (allowed: ReadonlyArray<Role>): fc.Arbitrary<Principal> =>
  fc.constantFrom(...allowed).chain(person);

const facts = (domain: ContentDomain): fc.Arbitrary<ContentFacts> =>
  domain === "movies"
    ? fc.record({
        domain: fc.constant(domain),
        rating: fc.oneof(
          fc.constant({ kind: "unrated" as const }),
          fc.record({ kind: fc.constant("rated" as const), age: fc.integer({ min: 0, max: 21 }) }),
        ),
      })
    : fc.record({ domain: fc.constant(domain), explicit: fc.boolean() });

const item: fc.Arbitrary<ContentResource> = fc
  .tuple(
    fc.constantFrom<ContentDomain>("movies", "music"),
    fc.option(fc.constantFrom<Level>(...levels), { nil: null }),
    library,
  )
  .chain(([domain, level, libraryId]) =>
    facts(domain).map((found): ContentResource => ({
      on: "content",
      domain,
      level,
      placement: { in: "item", library: libraryId, facts: found },
    })),
  );

const device = fc.constantFrom<DeviceMode | null>("personal", "shared", null);

const ADULTS_AND_KIDS: ReadonlyArray<Role> = ["owner", "admin", "member"];

const keep = (principal: Principal, mode: DeviceMode | null, thing: ContentResource) =>
  can(principal, "keep", { on: "download", device: mode, item: thing });

describe("the download rule in can", () => {
  it("lets a person keep on a personal device exactly what they may play", () => {
    fc.assert(
      fc.property(people(ADULTS_AND_KIDS), item, (principal, thing) => {
        expect(keep(principal, "personal", thing)).toEqual(can(principal, "play", thing));
      }),
    );
  });

  it("keeps nothing on a shared device, for any person and item", () => {
    fc.assert(
      fc.property(people(ADULTS_AND_KIDS), item, (principal, thing) => {
        expect(keep(principal, "shared", thing)).toEqual({
          allowed: false,
          refusal: "forbidden",
          because: "shared-device",
        });
      }),
    );
  });

  it("keeps nothing for a session on no device", () => {
    fc.assert(
      fc.property(people(ADULTS_AND_KIDS), item, (principal, thing) => {
        expect(keep(principal, null, thing)).toEqual({
          allowed: false,
          refusal: "forbidden",
          because: "no-device",
        });
      }),
    );
  });

  it("refuses a guest the same way for every item and device, even one they may play", () => {
    fc.assert(
      fc.property(people(["guest"]), item, device, (principal, thing, mode) => {
        expect(keep(principal, mode, thing)).toEqual({
          allowed: false,
          refusal: "forbidden",
          because: "guest",
        });
      }),
    );

    const guest: Principal = {
      kind: "person",
      userId: idOf("users", "guest"),
      role: "guest",
      scopes: roleScopes.guest,
      restrictions: null,
    };

    const shared: ContentResource = {
      on: "content",
      domain: "movies",
      level: "view",
      placement: {
        in: "item",
        library: idOf("libraries", "films"),
        facts: { domain: "movies", rating: { kind: "rated", age: 0 } },
      },
    };

    expect(can(guest, "play", shared)).toEqual({ allowed: true });
    expect(keep(guest, "personal", shared)).toMatchObject({ because: "guest" });
  });

  it("hides every download from a service", () => {
    const server: Principal = { kind: "service", userId: idOf("users", "server"), scopes: [] };

    fc.assert(
      fc.property(item, device, (thing, mode) => {
        expect(keep(server, mode, thing)).toEqual({
          allowed: false,
          refusal: "hidden",
          because: "service",
        });
      }),
    );
  });
});
