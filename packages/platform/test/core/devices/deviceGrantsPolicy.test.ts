import { describe, expect, it } from "vitest";

import { roleScopes } from "../../../commands/scopes";
import type { CredentialScope, Role } from "../../../commands/scopes";
import type { Doc, Id, TableNames } from "../../../convex/_generated/dataModel";
import { can, heldScopes } from "../../../convex/core/permissions/policy";
import type { GrantAction, Principal } from "../../../convex/core/permissions/policy";

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string; the
// policy only compares ids for equality and never sends one to a backend.
const isIdOf = <Table extends TableNames>(table: Table, value: string): value is Id<Table> =>
  value.startsWith(`${table}:`);

const idOf = <Table extends TableNames>(table: Table, name: string): Id<Table> => {
  const value = `${table}:${name}`;

  if (!isIdOf(table, value)) throw new Error(`${value} is not a ${table} id`);

  return value;
};

const userId = (name: string): Id<"users"> => idOf("users", name);

const AIKO = userId("aiko");

type SessionKind = Doc<"authSessions">["kind"];

const aiko = (
  sessionKind: SessionKind | null,
  role: Role = "member",
  scopes: ReadonlyArray<CredentialScope> = roleScopes[role],
): Principal => ({ kind: "person", userId: AIKO, role, scopes, restrictions: null, sessionKind });

const decide = (principal: Principal, action: GrantAction, owner = AIKO) =>
  can(principal, action, { on: "deviceGrant", owner });

describe("device grant policy", () => {
  it("issues only from a password session of the grant's own person", () => {
    expect(decide(aiko("password"), "issue")).toEqual({ allowed: true });
    expect(decide(aiko("grant"), "issue")).toMatchObject({ because: "needs-password" });
    expect(decide(aiko("deviceCode"), "issue")).toMatchObject({ because: "needs-password" });
    expect(decide(aiko("apiKey"), "issue")).toMatchObject({ because: "api-key" });
    expect(decide(aiko("tile", "member", []), "issue")).toMatchObject({ because: "scope" });
  });

  it("lists and revokes from any session with account, never someone else's", () => {
    for (const kind of ["password", "grant", "deviceCode", "apiKey"] as const) {
      expect(decide(aiko(kind), "list")).toEqual({ allowed: true });
      expect(decide(aiko(kind), "revoke")).toEqual({ allowed: true });
    }

    expect(decide(aiko("password", "owner"), "revoke", userId("bo"))).toEqual({
      allowed: false,
      refusal: "hidden",
      because: "not-yours",
    });
    expect(decide(aiko("guest", "guest"), "list")).toMatchObject({ because: "guest" });
    expect(decide({ kind: "service", userId: AIKO, scopes: [] }, "list")).toMatchObject({
      refusal: "hidden",
    });
  });

  it("gives an exchanged session its person's role scopes, as a password session", () => {
    const user: Doc<"users"> = {
      _id: AIKO,
      _creationTime: 0,
      kind: "person",
      username: "aiko",
      usernameKey: "aiko",
      sessionGeneration: 0,
      keyGeneration: 0,
      role: "member",
    };

    const session = (kind: "grant" | "password"): Doc<"authSessions"> =>
      kind === "grant"
        ? {
            _id: idOf("authSessions", "grant"),
            _creationTime: 0,
            userId: AIKO,
            expirationTime: 1,
            generation: 0,
            kind,
            grant: idOf("deviceGrants", "phone"),
          }
        : {
            _id: idOf("authSessions", "password"),
            _creationTime: 0,
            userId: AIKO,
            expirationTime: 1,
            generation: 0,
            kind,
          };

    expect(heldScopes(session("grant"), user)).toEqual(heldScopes(session("password"), user));
    expect(heldScopes(session("grant"), user)).toEqual([...roleScopes.member]);
  });
});
