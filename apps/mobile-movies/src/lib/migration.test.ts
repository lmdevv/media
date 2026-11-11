import { ProfileId } from "@media/contracts/ids";
import {
  MigrationConnection,
  MigrationReport,
  MigrationRun,
} from "@media/contracts/models/migration";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { SKIP, userRows } from "@media/contracts/migration-plan";

import { SKIP_LABEL, choiceLabel, doneRows, phaseRows, reviewRows } from "./migration";

const summary = {
  usersMapped: 1,
  usersUnmapped: 1,
  librariesToAdd: 1,
  librariesExisting: 1,
  itemsByPath: 10,
  itemsByProviderId: 2,
  itemsAwaitingScan: 0,
  itemsUnmatched: 3,
  watched: 1842,
  inProgress: 23,
  playCounts: 0,
  favorites: 64,
  collections: 0,
  overrides: 0,
  conflicts: 0,
};

const connection = Schema.decodeSync(MigrationConnection)({
  status: "connected",
  connectionId: "c1",
  source: "jellyfin",
  serverName: "Home",
  version: "10.10.3",
  users: [
    {
      sourceUserId: "u1",
      name: "Alex",
      email: null,
      isAdmin: true,
      suggestion: { kind: "profile", userId: "acct-sam", profileId: "p-sam", matchedBy: "name" },
      history: "full",
    },
    {
      sourceUserId: "u2",
      name: "Jordan",
      email: null,
      isAdmin: false,
      suggestion: { kind: "invite" },
      history: "full",
    },
  ],
  libraries: [],
  pathMappings: [
    { from: "/data", to: "/mnt/nas", inferred: false },
    { from: "/tv", to: "/media/tv", inferred: true },
  ],
  expiresAt: 1,
});

const report = Schema.decodeSync(MigrationReport)({
  status: "ready",
  connectionId: "c1",
  source: "jellyfin",
  serverName: "Home",
  createdAt: 1,
  summary,
  users: [
    { sourceUserId: "u1", name: "Alex", profileId: "p-sam", action: "import" },
    { sourceUserId: "u2", name: "Jordan", profileId: null, action: "invite" },
  ],
  libraries: [
    {
      sourceLibraryId: "l1",
      name: "Movies",
      kind: "movies",
      roots: ["/media/movies"],
      existingLibraryId: "lib-1",
      unmappedFolders: [],
      access: { kind: "everyone" },
    },
    {
      sourceLibraryId: "l2",
      name: "Shows",
      kind: "shows",
      roots: ["/media/shows"],
      existingLibraryId: null,
      unmappedFolders: [],
      access: { kind: "everyone" },
    },
  ],
  unmatchedSamples: [],
});

const run = (
  phase: MigrationRun["phase"],
  status: MigrationRun["job"]["status"],
  done: number,
  total: number | null,
) =>
  Schema.decodeSync(MigrationRun)({
    job: {
      id: "j1",
      kind: "migration",
      status,
      payload: { kind: "migration", source: "jellyfin", serverName: "Home" },
      progress: { done, total, message: null },
      error: null,
      requestedBy: null,
      attempts: 1,
      createdAt: 1,
      startedAt: 1,
      finishedAt: null,
    },
    source: "jellyfin",
    serverName: "Home",
    phase,
    imported: {
      librariesAdded: 1,
      watched: 1842,
      inProgress: 23,
      playCounts: 0,
      favorites: 64,
      collections: 2,
      overrides: 0,
      keptLocal: 0,
      unmatched: 0,
    },
  });

describe("migration", () => {
  it("lists what a dry run found, leaving out empty collections", () => {
    expect(reviewRows(report).map((row) => [row.title, row.detail])).toStrictEqual([
      ["Libraries", "1 New"],
      ["Users", "1 of 2"],
      ["Watch History", "1,842 Items"],
      ["In Progress", "23 Items"],
      ["Favorites", "64"],
    ]);
    expect(doneRows(run("done", "succeeded", 0, null)).map((row) => row.title)).toContain(
      "Collections",
    );
  });

  it("marks each phase done, under way with its count, or waiting", () => {
    const watching = run("watchState", "running", 1252, 1842);

    expect(phaseRows(watching).map((row) => row.detail)).toStrictEqual([
      "Complete",
      "Complete",
      "1,252 of 1,842",
      "Waiting",
      "Waiting",
    ]);
  });

  it("names a skipped person's choice in Paper's title case", () => {
    const rows = userRows(
      connection,
      report,
      [{ id: Schema.decodeSync(ProfileId)("p-own"), name: "Me" }],
      [],
      SKIP_LABEL,
    );

    const jordan = rows[1];

    expect(jordan?.choice).toBe(SKIP);
    expect(jordan === undefined ? null : choiceLabel(jordan)).toBe("Don’t Import");
    expect(rows[0] === undefined ? null : choiceLabel(rows[0])).toBe("Suggested");
  });
});
