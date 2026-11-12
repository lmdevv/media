import { describe, expect, it } from "vitest";

import { roleScopes } from "../../../commands/scopes";
import type { CredentialScope, Role } from "../../../commands/scopes";
import type { Doc, Id, TableNames } from "../../../convex/_generated/dataModel";
import { can } from "../../../convex/core/permissions/policy";
import type { CredentialAction, Principal } from "../../../convex/core/permissions/policy";

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string; the
// policy only compares ids for equality and never sends one to a backend.
const isIdOf = <Table extends TableNames>(table: Table, value: string): value is Id<Table> =>
  value.startsWith(`${table}:`);

const idOf = <Table extends TableNames>(table: Table, name: string): Id<Table> => {
  const value = `${table}:${name}`;

  if (!isIdOf(table, value)) throw new Error(`${value} is not a ${table} id`);

  return value;
};

const AIKO = idOf("users", "aiko");

type SessionKind = Doc<"authSessions">["kind"];

const aiko = (
  sessionKind: SessionKind | null,
  role: Role = "member",
  scopes: ReadonlyArray<CredentialScope> = roleScopes[role],
): Principal => ({ kind: "person", userId: AIKO, role, scopes, restrictions: null, sessionKind });

const decide = (principal: Principal, action: CredentialAction, owner = AIKO) =>
  can(principal, action, { on: "credential", owner });

describe("own credential policy", () => {
  it("lists and ends a person's own sessions and keys from any session with account", () => {
    for (const kind of ["password", "grant", "deviceCode", "apiKey"] as const) {
      for (const action of ["list", "end"] as const) {
        expect(decide(aiko(kind), action)).toEqual({ allowed: true });
      }
    }
  });

  it("hides everyone else's, admins and the owner included", () => {
    for (const role of ["member", "admin", "owner"] as const) {
      expect(decide(aiko("password", role), "end", idOf("users", "bo"))).toEqual({
        allowed: false,
        refusal: "hidden",
        because: "not-yours",
      });
    }
  });

  it("refuses a session without account, a guest, and a service", () => {
    expect(decide(aiko("tile", "member", ["movies:read"]), "list")).toEqual({
      allowed: false,
      refusal: "forbidden",
      because: "scope",
    });
    expect(decide(aiko("guest", "guest"), "list")).toMatchObject({ because: "guest" });
    expect(decide({ kind: "service", userId: AIKO, scopes: [] }, "end")).toMatchObject({
      refusal: "hidden",
      because: "service",
    });
  });
});
