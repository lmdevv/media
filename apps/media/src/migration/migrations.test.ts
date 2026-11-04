import { ProfileId, UserId } from "@media/contracts/ids";
import type { SourceUser } from "@media/contracts/models/migration";
import type { MigrationTarget } from "@media/contracts/models/migration-service";
import { assert, describe, it } from "@effect/vitest";

import { resolveUsers, suggestProfile } from "./migrations.ts";

const target = (
  name: string,
  email: string | null,
  profiles: ReadonlyArray<string>,
): MigrationTarget => ({
  userId: UserId.make(`user-${name}`),
  name,
  email,
  profiles: profiles.map((profile) => ({
    profileId: ProfileId.make(`${name}-${profile}`),
    name: profile,
  })),
});

const TARGETS: ReadonlyArray<MigrationTarget> = [
  target("Alice", "alice@example.com", ["Alice", "Kids"]),
  target("Robert", null, ["Bob"]),
  target("Empty", "empty@example.com", []),
];

const sourceUser = (
  sourceUserId: string,
  name: string,
  suggestion: SourceUser["suggestion"],
): SourceUser => ({
  sourceUserId,
  name,
  email: null,
  isAdmin: false,
  suggestion,
  history: "full",
});

describe("suggestProfile", () => {
  it("matches an account by email first, then by account name, then by a profile's name", () => {
    assert.deepStrictEqual(
      suggestProfile({ name: "Someone Else", email: " ALICE@example.com " }, TARGETS),
      {
        kind: "profile",
        userId: UserId.make("user-Alice"),
        profileId: ProfileId.make("Alice-Alice"),
        matchedBy: "email",
      },
    );
    assert.deepStrictEqual(suggestProfile({ name: "robert", email: null }, TARGETS), {
      kind: "profile",
      userId: UserId.make("user-Robert"),
      profileId: ProfileId.make("Robert-Bob"),
      matchedBy: "name",
    });
    assert.deepStrictEqual(suggestProfile({ name: "Kids", email: null }, TARGETS), {
      kind: "profile",
      userId: UserId.make("user-Alice"),
      profileId: ProfileId.make("Alice-Kids"),
      matchedBy: "name",
    });
  });

  it("proposes an invite instead of creating an account", () => {
    assert.deepStrictEqual(suggestProfile({ name: "Stranger", email: null }, TARGETS), {
      kind: "invite",
    });
    assert.deepStrictEqual(suggestProfile({ name: "x", email: "empty@example.com" }, TARGETS), {
      kind: "invite",
    });
  });
});

describe("resolveUsers", () => {
  it("follows suggestions unless the admin chose a profile or skipped the user", () => {
    const users = [
      sourceUser("1", "alice", {
        kind: "profile",
        userId: UserId.make("user-Alice"),
        profileId: ProfileId.make("Alice-Alice"),
        matchedBy: "name",
      }),
      sourceUser("2", "stranger", { kind: "invite" }),
      sourceUser("3", "kid", { kind: "invite" }),
      sourceUser("4", "guest", {
        kind: "profile",
        userId: UserId.make("user-Robert"),
        profileId: ProfileId.make("Robert-Bob"),
        matchedBy: "name",
      }),
    ];

    const resolved = resolveUsers(users, [
      { sourceUserId: "3", profileId: ProfileId.make("Alice-Kids") },
      { sourceUserId: "4", profileId: null },
    ]);

    assert.deepStrictEqual(
      resolved.map((user) => [user.sourceUserId, user.action, user.profileId]),
      [
        ["1", "import", "Alice-Alice"],
        ["2", "invite", null],
        ["3", "import", "Alice-Kids"],
        ["4", "skip", null],
      ],
    );
  });
});
