import type { HouseholdUser } from "@media/mobile-core/accounts";
import { ImportConnection, ImportReport } from "@media/contracts/models/migration";
import { Brand, Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  SKIP,
  choiceLabel,
  doneRows,
  importFraction,
  mappingsFor,
  phaseRows,
  reviewRows,
  userRows,
} from "./migration";
import type { ImportRun } from "./owner";

const coreUserId = Brand.nominal<HouseholdUser["userId"]>();

const importId = Brand.nominal<ImportRun["importId"]>();

const jobId = Brand.nominal<ImportRun["job"]["jobId"]>();

const lucia: HouseholdUser = {
  userId: coreUserId("u1"),
  username: "lucia",
  displayName: null,
  role: "owner",
};

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

const connection = Schema.decodeSync(ImportConnection)({
  status: "connected",
  connectionId: "c1",
  source: "jellyfin",
  serverName: "Den",
  version: "10.10.0",
  users: [
    {
      sourceUserId: "s1",
      name: "Lucía",
      email: null,
      isAdmin: true,
      suggestion: { kind: "user", userId: "u1", matchedBy: "name" },
      history: "full",
    },
    {
      sourceUserId: "s2",
      name: "Kid",
      email: null,
      isAdmin: false,
      suggestion: { kind: "user", userId: "u9", matchedBy: "name" },
      history: "full",
    },
  ],
  libraries: [],
  pathMappings: [],
  expiresAt: 0,
});

const report = Schema.decodeSync(ImportReport)({
  status: "ready",
  connectionId: "c1",
  source: "jellyfin",
  serverName: "Den",
  createdAt: 0,
  summary,
  users: [
    { sourceUserId: "s1", name: "Lucía", userId: "u1", action: "import" },
    { sourceUserId: "s2", name: "Kid", userId: null, action: "skip" },
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
  fields: Partial<Omit<ImportRun, "job">> & { readonly job?: Partial<ImportRun["job"]> },
): ImportRun => {
  const base: ImportRun = {
    importId: importId("i1"),
    source: "jellyfin",
    serverName: "Den",
    createdAt: 0,
    phase: "watchState",
    users: 2,
    imported: {
      librariesAdded: 1,
      watched: 1842,
      inProgress: 23,
      favorites: 64,
      collections: 2,
      overrides: 0,
      keptLocal: 0,
      unmatched: 0,
    },
    job: {
      jobId: jobId("j1"),
      status: "running",
      done: 1252,
      total: 1842,
      message: null,
      error: null,
      startedAt: 1,
      attempt: 1,
      canceling: false,
      finishedAt: null,
    },
  };

  return { ...base, ...fields, job: { ...base.job, ...fields.job } };
};

describe("migration", () => {
  it("lists what a dry run found, leaving out empty collections", () => {
    expect(reviewRows(report).map((row) => [row.title, row.detail])).toStrictEqual([
      ["Libraries", "1 New"],
      ["Users", "1 of 2"],
      ["Watch History", "1,842 Items"],
      ["In Progress", "23 Items"],
      ["Favorites", "64"],
    ]);
    expect(
      doneRows(run({ phase: "done", job: { status: "succeeded" } })).map((row) => row.title),
    ).toContain("Collections");
  });

  it("marks each phase done, under way with its count, or waiting", () => {
    expect(phaseRows(run({})).map((row) => row.detail)).toStrictEqual([
      "Complete",
      "Complete",
      "1,252 of 1,842",
      "Waiting",
      "Waiting",
    ]);
    expect(phaseRows(run({ job: { status: "queued" } }))[2]?.detail).toBe("Waiting");
  });

  it("weighs each phase and counts a finished import as complete", () => {
    expect(importFraction(run({ job: { done: 50, total: 100 } }))).toBeCloseTo(0.3 + 0.55 * 0.5);
    expect(importFraction(run({ phase: "done" }))).toBe(1);
    expect(importFraction(run({ job: { status: "succeeded" } }))).toBe(1);
  });

  it("offers every person here, a suggestion not listed, and skipping in Paper's title case", () => {
    const rows = userRows(connection, report, [lucia]);

    expect(rows.map((row) => row.choice)).toStrictEqual(["u1", SKIP]);
    expect(rows[1]?.options.map((option) => option.label)).toStrictEqual([
      "Suggested",
      "lucia",
      "Don’t Import",
    ]);
    expect(rows[0] === undefined ? null : choiceLabel(rows[0])).toBe("lucia");
    expect(rows[1] === undefined ? null : choiceLabel(rows[1])).toBe("Don’t Import");
  });

  it("maps a changed choice and keeps the rest", () => {
    const rows = userRows(connection, report, [lucia]);

    expect(mappingsFor(rows, { sourceUserId: "s1", choice: SKIP })).toStrictEqual([
      { sourceUserId: "s1", userId: null },
      { sourceUserId: "s2", userId: null },
    ]);
  });
});
