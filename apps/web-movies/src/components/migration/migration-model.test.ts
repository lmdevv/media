import { ImportConnection, ImportReport } from "@media/contracts/models/migration";
import { Brand, Schema } from "effect";
import { describe, expect, it } from "vitest";

import type { ImportRun, Person } from "@/components/admin/types";

import { SKIP, importFraction, importMinutesLeft, mappingsFor, userRows } from "./migration-model";

const coreUserId = Brand.nominal<Person["userId"]>();

const importId = Brand.nominal<ImportRun["importId"]>();

const jobId = Brand.nominal<ImportRun["job"]["jobId"]>();

const lucia: Person = {
  userId: coreUserId("u1"),
  username: "lucia",
  displayName: null,
  role: "owner",
};

const visitor: Person = {
  userId: coreUserId("u2"),
  username: "visitor",
  displayName: null,
  role: "guest",
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
  summary: {
    usersMapped: 1,
    usersUnmapped: 1,
    librariesToAdd: 0,
    librariesExisting: 0,
    itemsByPath: 0,
    itemsByProviderId: 0,
    itemsAwaitingScan: 0,
    itemsUnmatched: 0,
    watched: 0,
    inProgress: 0,
    playCounts: 0,
    favorites: 0,
    collections: 0,
    overrides: 0,
    conflicts: 0,
  },
  users: [
    { sourceUserId: "s1", name: "Lucía", userId: "u1", action: "import" },
    { sourceUserId: "s2", name: "Kid", userId: null, action: "skip" },
  ],
  libraries: [],
  unmatchedSamples: [],
});

describe("userRows", () => {
  const rows = userRows(connection, report, [lucia, visitor], "Don’t import");

  it("starts from the dry run's choices", () => {
    expect(rows.map((row) => row.choice)).toEqual(["u1", SKIP]);
  });

  it("offers every user here but guests, a suggestion not listed, and skipping", () => {
    expect(rows[0]?.options.map((option) => option.label)).toEqual(["lucia", "Don’t import"]);
    expect(rows[1]?.options.map((option) => option.label)).toEqual([
      "Suggested",
      "lucia",
      "Don’t import",
    ]);
  });

  it("maps a changed choice and keeps the rest", () => {
    expect(mappingsFor(rows, { sourceUserId: "s1", choice: SKIP })).toEqual([
      { sourceUserId: "s1", userId: null },
      { sourceUserId: "s2", userId: null },
    ]);
  });
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
      librariesAdded: 0,
      watched: 0,
      inProgress: 0,
      favorites: 0,
      collections: 0,
      overrides: 0,
      keptLocal: 0,
      unmatched: 0,
    },
    job: {
      jobId: jobId("j1"),
      status: "running",
      done: 50,
      total: 100,
      message: null,
      error: null,
      startedAt: 60 * 60_000,
      attempt: 1,
      canceling: false,
      finishedAt: null,
    },
  };

  return { ...base, ...fields, job: { ...base.job, ...fields.job } };
};

describe("importFraction", () => {
  it("weighs each phase and counts a finished import as complete", () => {
    expect(importFraction(run({}))).toBeCloseTo(0.3 + 0.55 * 0.5);
    expect(importFraction(run({ phase: "done" }))).toBe(1);
    expect(importFraction(run({ job: { status: "succeeded" } }))).toBe(1);
  });

  it("estimates minutes left from the pace since the job started, not since it was made", () => {
    expect(importMinutesLeft(run({}), 0.5, 70 * 60_000)).toBe(10);
    expect(importMinutesLeft(run({}), 0.01, 70 * 60_000)).toBeNull();
    expect(importMinutesLeft(run({}), 1, 70 * 60_000)).toBeNull();
    expect(
      importMinutesLeft(run({ job: { status: "queued", startedAt: null } }), 0.5, 70 * 60_000),
    ).toBeNull();
  });
});
