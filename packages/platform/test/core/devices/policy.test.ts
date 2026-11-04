import { describe, expect, it } from "vitest";

import type { Restrictions } from "../../../commands/access";
import { roleScopes } from "../../../commands/scopes";
import type { CredentialScope, Role } from "../../../commands/scopes";
import type { Doc, Id, TableNames } from "../../../convex/_generated/dataModel";
import {
  accountTarget,
  can,
  heldScopes,
  lockOf,
  principalOf,
} from "../../../convex/core/permissions/policy";
import type {
  ApprovalIntent,
  Decision,
  DeviceRelation,
  Principal,
  Prover,
  TileAction,
  TileResource,
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

const rows = {
  owner: person("owner", "owner"),
  admin: person("admin", "admin"),
  dad: person("dad", "member"),
  mom: person("mom", "member"),
  lily: person("lily", "member", true),
  max: person("max", "member", true),
  guest: person("guest", "guest"),
};

const service: Principal = { kind: "service", userId: idOf("users", "server"), scopes: [] };

const prover = (user: Doc<"users">, listed = true): Prover => {
  const principal = principalOf(user);

  if (principal.kind !== "person") throw new Error("a prover is a person");

  return {
    userId: principal.userId,
    role: principal.role,
    kid: principal.restrictions !== null,
    listed,
  };
};

interface TileFacts {
  readonly lockRequired?: boolean;
  readonly kidListed?: boolean;
  readonly holder?: Doc<"users">;
  readonly proof?: Prover;
}

const tile = (user: Doc<"users">, facts: TileFacts = {}): TileResource => ({
  on: "tile",
  person: { ...prover(user), lockRequired: facts.lockRequired ?? false },
  kidListed: facts.kidListed ?? false,
  holder: facts.holder?._id ?? null,
  proof: facts.proof ?? null,
});

const opens = (user: Doc<"users">, facts: TileFacts = {}): Decision =>
  can(principalOf(user), "open", tile(user, facts));

const ALLOWED: Decision = { allowed: true };

const refused = (refusal: "hidden" | "forbidden", because: string) => ({
  allowed: false,
  refusal,
  because,
});

const decide = (actor: Doc<"users">, action: TileAction, target: TileResource): Decision =>
  can(principalOf(actor), action, target);

const answers = (
  answerer: Doc<"users">,
  intent: ApprovalIntent,
  userId: Id<"users">,
  listed = true,
  scopes?: ReadonlyArray<CredentialScope>,
): Decision =>
  can(principalOf(answerer, scopes), "answer", {
    on: "approval",
    intent,
    userId,
    answererListed: listed,
  });

const controls = (user: Doc<"users">, relation: DeviceRelation): Decision =>
  can(principalOf(user), "control", { on: "device", relation });

const lists = (actor: Doc<"users">, target: Doc<"users">): Decision =>
  can(principalOf(actor), "listOnSharedDevices", accountTarget(target));

const tileSession = (user: Doc<"users">): Doc<"authSessions"> => ({
  _id: idOf("authSessions", `${user._id}-tile`),
  _creationTime: 0,
  userId: user._id,
  expirationTime: 1,
  generation: 0,
  kind: "tile",
  device: { id: idOf("devices", "tv"), generation: 0 },
});

describe("a tile's lock", () => {
  it("is open with no kid listed and no admin rule", () => {
    expect(lockOf(tile(rows.dad))).toEqual({ state: "open" });
    expect(lockOf(tile(rows.lily))).toEqual({ state: "open" });
  });

  it("locks every adult tile while a kid is listed, and opens only to its own person", () => {
    for (const adult of [rows.owner, rows.admin, rows.dad]) {
      expect(lockOf(tile(adult, { kidListed: true }))).toEqual({
        state: "locked",
        because: ["kid-listed"],
        opensWith: "self",
      });
    }

    expect(lockOf(tile(rows.lily, { kidListed: true }))).toEqual({ state: "open" });
  });

  it("locks the tile an admin rule names, which an adult may open for a kid", () => {
    expect(lockOf(tile(rows.dad, { lockRequired: true }))).toEqual({
      state: "locked",
      because: ["admin-rule"],
      opensWith: "self",
    });
    expect(lockOf(tile(rows.lily, { lockRequired: true }))).toEqual({
      state: "locked",
      because: ["admin-rule"],
      opensWith: "self-or-adult",
    });
  });

  it("locks every other tile while a kid holds the device, and leaving needs an adult", () => {
    const held = { kidListed: true, holder: rows.lily };

    expect(lockOf(tile(rows.lily, held))).toEqual({ state: "open" });
    expect(lockOf(tile(rows.max, held))).toEqual({
      state: "locked",
      because: ["kid-holds-device"],
      opensWith: "adult",
    });
    expect(lockOf(tile(rows.dad, held))).toEqual({
      state: "locked",
      because: ["kid-listed", "kid-holds-device"],
      opensWith: "self",
    });
    expect(lockOf(tile(rows.max, { ...held, lockRequired: true }))).toEqual({
      state: "locked",
      because: ["admin-rule", "kid-holds-device"],
      opensWith: "adult",
    });
  });
});

describe("opening a tile", () => {
  it("opens an open tile without a proof", () => {
    expect(opens(rows.dad)).toEqual(ALLOWED);
    expect(opens(rows.lily, { kidListed: true })).toEqual(ALLOWED);
  });

  it("opens a locked adult tile only with that adult's own proof", () => {
    const facts = { kidListed: true };

    expect(opens(rows.dad, facts)).toEqual(refused("forbidden", "locked"));
    expect(opens(rows.dad, { ...facts, proof: prover(rows.dad) })).toEqual(ALLOWED);
    expect(opens(rows.dad, { ...facts, proof: prover(rows.mom) })).toEqual(
      refused("forbidden", "locked"),
    );
    expect(opens(rows.dad, { ...facts, proof: prover(rows.owner) })).toEqual(
      refused("forbidden", "locked"),
    );
    expect(opens(rows.dad, { lockRequired: true, proof: prover(rows.admin) })).toEqual(
      refused("forbidden", "locked"),
    );
  });

  it("lets a kid leave a held device only with an adult's proof", () => {
    const held = { kidListed: true, holder: rows.lily };

    expect(opens(rows.max, held)).toEqual(refused("forbidden", "locked"));
    expect(opens(rows.max, { ...held, proof: prover(rows.max) })).toEqual(
      refused("forbidden", "locked"),
    );
    expect(opens(rows.max, { ...held, proof: prover(rows.lily) })).toEqual(
      refused("forbidden", "locked"),
    );
    expect(opens(rows.max, { ...held, proof: prover(rows.mom) })).toEqual(ALLOWED);
    expect(opens(rows.dad, { ...held, proof: prover(rows.dad) })).toEqual(ALLOWED);
    expect(opens(rows.lily, held)).toEqual(ALLOWED);
  });

  it("takes vouching only from an adult the shared devices list, or an admin", () => {
    const held = { kidListed: true, holder: rows.lily };

    expect(opens(rows.max, { ...held, proof: prover(rows.mom, false) })).toEqual(
      refused("forbidden", "locked"),
    );
    expect(opens(rows.max, { ...held, proof: prover(rows.admin, false) })).toEqual(ALLOWED);
    expect(opens(rows.max, { ...held, proof: prover(rows.guest) })).toEqual(
      refused("forbidden", "locked"),
    );
  });

  it("hides the tile of someone the shared devices do not list, and of a guest", () => {
    const unlisted: TileResource = {
      ...tile(rows.dad),
      person: { ...prover(rows.dad, false), lockRequired: false },
    };

    expect(can(principalOf(rows.dad), "open", unlisted)).toEqual(refused("hidden", "unlisted"));
    expect(opens(rows.guest)).toEqual(refused("hidden", "unlisted"));
    expect(can(service, "open", tile(rows.dad))).toEqual(refused("hidden", "service"));
    expect(can(principalOf(rows.mom), "open", tile(rows.dad))).toEqual(
      refused("forbidden", "actor"),
    );
  });
});

describe("an admin's tile lock", () => {
  it("locks anyone's tile but a guest's, their own included, and only as an admin", () => {
    for (const target of [rows.owner, rows.admin, rows.dad, rows.lily]) {
      expect(decide(rows.admin, "lock", tile(target))).toEqual(ALLOWED);
    }

    expect(decide(rows.admin, "lock", tile(rows.guest))).toEqual(
      refused("forbidden", "target-role"),
    );
    expect(decide(rows.dad, "lock", tile(rows.mom))).toEqual(refused("forbidden", "scope"));
  });

  it("cannot lift the lock a listed kid puts on an adult's tile", () => {
    expect(decide(rows.admin, "unlock", tile(rows.dad, { kidListed: true }))).toEqual(
      refused("forbidden", "kid-lock"),
    );
    expect(decide(rows.owner, "unlock", tile(rows.admin, { kidListed: true }))).toEqual(
      refused("forbidden", "kid-lock"),
    );
    expect(decide(rows.admin, "unlock", tile(rows.lily, { kidListed: true }))).toEqual(ALLOWED);
    expect(decide(rows.admin, "unlock", tile(rows.dad, { lockRequired: true }))).toEqual(ALLOWED);
  });
});

describe("answering a shared device's approval", () => {
  it("lets only the tile's own person approve opening it", () => {
    expect(answers(rows.dad, "open", rows.dad._id)).toEqual(ALLOWED);
    expect(answers(rows.mom, "open", rows.dad._id)).toEqual(refused("hidden", "not-yours"));
    expect(answers(rows.owner, "open", rows.dad._id)).toEqual(refused("hidden", "not-yours"));
  });

  it("lets a listed adult or an admin let a kid leave, and no kid", () => {
    expect(answers(rows.mom, "leave", rows.lily._id)).toEqual(ALLOWED);
    expect(answers(rows.admin, "leave", rows.lily._id, false)).toEqual(ALLOWED);
    expect(answers(rows.mom, "leave", rows.lily._id, false)).toEqual(
      refused("forbidden", "not-adult"),
    );
    expect(answers(rows.max, "leave", rows.lily._id)).toEqual(refused("forbidden", "not-adult"));
  });

  it("needs a session that holds account, which a tile on a shared device never does", () => {
    const media = roleScopes.member.filter((scope) => scope !== "account");

    expect(answers(rows.dad, "open", rows.dad._id, true, media)).toEqual(
      refused("forbidden", "scope"),
    );
    expect(
      can(service, "answer", {
        on: "approval",
        intent: "open",
        userId: rows.dad._id,
        answererListed: true,
      }),
    ).toEqual(refused("hidden", "service"));
  });
});

describe("controlling a device", () => {
  it("reaches one's own personal device always and another person's never", () => {
    expect(controls(rows.dad, { mode: "personal", signedInHere: true })).toEqual(ALLOWED);
    expect(controls(rows.owner, { mode: "personal", signedInHere: false })).toEqual(
      refused("hidden", "not-signed-in-here"),
    );
  });

  it("reaches a shared device for anyone it lists, kids included", () => {
    expect(controls(rows.lily, { mode: "shared", listed: true })).toEqual(ALLOWED);
    expect(controls(rows.admin, { mode: "shared", listed: false })).toEqual(
      refused("hidden", "unlisted"),
    );
  });

  it("refuses guests and services until guest sessions exist", () => {
    expect(controls(rows.guest, { mode: "shared", listed: true })).toEqual(
      refused("hidden", "guest"),
    );
    expect(
      can(service, "control", { on: "device", relation: { mode: "personal", signedInHere: true } }),
    ).toEqual(refused("hidden", "service"));
  });
});

describe("listing on shared devices", () => {
  it("is each adult's own choice", () => {
    for (const adult of [rows.owner, rows.admin, rows.dad]) {
      expect(lists(adult, adult)).toEqual(ALLOWED);
    }

    expect(lists(rows.admin, rows.dad)).toEqual(refused("forbidden", "unrestricted-target"));
    expect(lists(rows.owner, rows.admin)).toEqual(refused("forbidden", "target-role"));
  });

  it("is an admin's choice for a kid, which the kid cannot change", () => {
    expect(lists(rows.admin, rows.lily)).toEqual(ALLOWED);
    expect(lists(rows.lily, rows.lily)).toEqual(refused("forbidden", "scope"));
    expect(lists(rows.dad, rows.lily)).toEqual(refused("forbidden", "scope"));
  });
});

describe("resetting an unlock code", () => {
  it("is an admin's, for anyone in the household", () => {
    for (const target of [rows.owner, rows.admin, rows.dad, rows.lily]) {
      expect(can(principalOf(rows.admin), "resetUnlockCode", accountTarget(target))).toEqual(
        ALLOWED,
      );
    }

    expect(can(principalOf(rows.dad), "resetUnlockCode", accountTarget(rows.dad))).toEqual(
      refused("forbidden", "scope"),
    );
  });
});

describe("a tile session's scopes", () => {
  it("are its person's content scopes, never account or admin", () => {
    const content = roleScopes.member.filter((scope) => scope !== "account");

    for (const user of [rows.owner, rows.admin, rows.dad, rows.lily]) {
      expect(heldScopes(tileSession(user), user)).toEqual(content);
    }

    expect(heldScopes(tileSession(rows.guest), rows.guest)).toEqual(roleScopes.guest);
  });
});
