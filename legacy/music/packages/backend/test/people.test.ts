/**
 * People management at a scale one mutation cannot hold: someone who signed in, made keys, or
 * liked songs without limit can still be suspended and removed, and the rest is cleaned up in
 * batches. Runs in memory with Convex's transaction limits tightened.
 */
import { UserId } from "@music/commands/ids";
import { describe, expect, it, vi } from "vitest";

import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { drainScheduled, makeBackend, signUp } from "./backend";
import type { Backend } from "./backend";
import { failureCode } from "./harness";

/** Writes per mutation in these tests: far fewer than the rows each person owns. */
const LIMIT = 150;

/** Rows each person gets, several times what one mutation may write. */
const MANY = 400;

/** Inserts `count` rows, a limit-sized batch per transaction. */
const insertMany = async (
  backend: Backend,
  count: number,
  insert: (ctx: Parameters<Parameters<Backend["run"]>[0]>[0], index: number) => Promise<void>,
): Promise<void> => {
  const from = async (start: number): Promise<void> => {
    if (start >= count) return;

    await backend.run(async (ctx) => {
      const indexes = Array.from({ length: Math.min(40, count - start) }, (_, i) => start + i);

      await Promise.all(indexes.map((index) => insert(ctx, index)));
    });

    await from(start + 40);
  };

  await from(0);
};

const countOf = (
  backend: Backend,
  table: "authSessions" | "apiKeys",
  userId: Id<"users">,
): Promise<number> =>
  backend.run(async (ctx) =>
    table === "authSessions"
      ? (
          await ctx.db
            .query("authSessions")
            .withIndex("userId", (q) => q.eq("userId", userId))
            .collect()
        ).length
      : (
          await ctx.db
            .query("apiKeys")
            .withIndex("by_user", (q) => q.eq("userId", userId))
            .collect()
        ).length,
  );

describe("people management at scale", () => {
  it("suspends someone with more sessions than a mutation can write, then purges them", async () => {
    const backend = makeBackend({ documentsWritten: LIMIT });
    const owner = await signUp(backend, "owner");
    const person = await signUp(backend, "member");

    await insertMany(backend, MANY, async (ctx) => {
      await ctx.db.insert("authSessions", {
        userId: person.id,
        expirationTime: Date.now() + 60_000,
      });
    });

    expect(
      await failureCode(owner.music.run("people.suspend", { userId: UserId.make(person.id) })),
    ).toBe("succeeded");
    expect(await failureCode(person.music.read("account.me", {}))).toBe("unauthenticated");

    await drainScheduled(backend);
    expect(await countOf(backend, "authSessions", person.id)).toBe(0);

    await owner.music.run("people.unsuspend", { userId: UserId.make(person.id) });
    expect(await failureCode(person.music.read("account.me", {}))).toBe("unauthenticated");
  });

  it("removes someone with more keys than a mutation can write, then purges them", async () => {
    const backend = makeBackend({ documentsWritten: LIMIT });
    const owner = await signUp(backend, "owner");
    const person = await signUp(backend, "member");

    await insertMany(backend, MANY, async (ctx, index) => {
      await ctx.db.insert("apiKeys", {
        userId: person.id,
        name: `key ${String(index)}`,
        prefix: "mk_test",
        hash: `hash-${String(index)}`,
      });
    });

    expect(
      await failureCode(owner.music.run("people.remove", { userId: UserId.make(person.id) })),
    ).toBe("succeeded");
    expect(await failureCode(person.music.read("account.me", {}))).toBe("unauthenticated");

    await drainScheduled(backend);
    expect(await countOf(backend, "apiKeys", person.id)).toBe(0);
    expect(await countOf(backend, "authSessions", person.id)).toBe(0);
  });

  it("removes a library with more grants than one mutation can delete", async () => {
    const backend = makeBackend({ documentsWritten: LIMIT });
    const owner = await signUp(backend, "owner");
    const person = await signUp(backend, "member");

    const { libraryId } = await owner.music.run("libraries.create", {
      name: "Crowded",
      path: "/music/crowded",
      visibility: "restricted",
    });

    const id = await backend.run(async (ctx) => ctx.db.normalizeId("libraries", libraryId));

    if (id === null) throw new Error("The library was not created");

    await insertMany(backend, MANY, async (ctx) => {
      await ctx.db.insert("libraryAccess", {
        libraryId: id,
        userId: person.id,
        grantedBy: owner.id,
      });
    });

    expect(await failureCode(owner.music.run("libraries.delete", { libraryId }))).toBe("succeeded");
    await drainScheduled(backend);

    const left = await backend.run(
      async (ctx) =>
        (
          await ctx.db
            .query("libraryAccess")
            .withIndex("by_library", (q) => q.eq("libraryId", id))
            .collect()
        ).length,
    );

    expect(left).toBe(0);
  });

  it("gives a removed person's libraries to whoever owns the server when each batch runs", async () => {
    const backend = makeBackend();
    const first = await signUp(backend, "owner");
    const leaving = await signUp(backend, "admin");
    const next = await signUp(backend, "admin");

    await insertMany(backend, 5, async (ctx, index) => {
      await ctx.db.insert("libraries", {
        name: `Shelf ${String(index)}`,
        path: `/music/shelf-${String(index)}`,
        visibility: "private",
        ownerId: leaving.id,
        trackCount: 0,
        albumCount: 0,
        artistCount: 0,
        durationMs: 0,
      });
    });

    // Removing someone schedules their clean-up with the owner of the moment as heir. Before it
    // runs, ownership moves on and that owner is removed in turn, and their clean-up runs first.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    try {
      await first.music.run("people.remove", { userId: UserId.make(leaving.id) });
      await first.music.run("people.transfer", { userId: UserId.make(next.id) });
      await next.music.run("people.remove", { userId: UserId.make(first.id) });
    } finally {
      vi.useRealTimers();
    }

    await backend.mutation(internal.people.purgeRemovedUser, { userId: first.id, heir: next.id });
    await backend.mutation(internal.people.purgeRemovedUser, {
      userId: leaving.id,
      heir: first.id,
    });

    const owners = await backend.run(async (ctx) => [
      ...new Set((await ctx.db.query("libraries").collect()).map((library) => library.ownerId)),
    ]);

    expect(owners).toEqual([next.id]);
  });

  it("purges every ended session, one with many tokens on an early page too", async () => {
    const backend = makeBackend();
    const person = await signUp(backend, "member");

    // More sessions than a page holds; the first, on the first page, has more refresh tokens
    // than a pass deletes per session.
    await insertMany(backend, 150, async (ctx) => {
      await ctx.db.insert("authSessions", {
        userId: person.id,
        expirationTime: Date.now() + 60_000,
        generation: 0,
      });
    });

    // The first of them (signing up opened one before, which stays).
    const first = await backend.run(async (ctx) =>
      ctx.db
        .query("authSessions")
        .withIndex("userId", (q) => q.eq("userId", person.id))
        .filter((q) => q.eq(q.field("generation"), 0))
        .first(),
    );

    if (first === null) throw new Error("No session was made");

    await insertMany(backend, 15, async (ctx) => {
      await ctx.db.insert("authRefreshTokens", {
        sessionId: first._id,
        expirationTime: Date.now() + 60_000,
      });
    });

    // Every one of them ended.
    await backend.run(async (ctx) => {
      await ctx.db.patch(person.id, { sessionGeneration: 1 });
    });

    await backend.mutation(internal.people.purgeSessions, { userId: person.id, cursor: null });
    await drainScheduled(backend);

    const left = await backend.run(async (ctx) => ({
      sessions: (await ctx.db.query("authSessions").collect()).filter(
        (session) => session.userId === person.id,
      ).length,
      tokens: (await ctx.db.query("authRefreshTokens").collect()).length,
    }));

    expect(left).toEqual({ sessions: 1, tokens: 0 });
  });

  it("revokes a new guest's keys in batches", async () => {
    const backend = makeBackend({ documentsWritten: LIMIT });
    const owner = await signUp(backend, "owner");
    const person = await signUp(backend, "member");

    await insertMany(backend, MANY, async (ctx, index) => {
      await ctx.db.insert("apiKeys", {
        userId: person.id,
        name: `key ${String(index)}`,
        prefix: "mk_test",
        hash: `hash-${String(index)}`,
      });
    });

    await owner.music.run("people.role", { userId: UserId.make(person.id), role: "guest" });
    await drainScheduled(backend);

    const open = await backend.run(
      async (ctx) =>
        (
          await ctx.db
            .query("apiKeys")
            .withIndex("by_user", (q) => q.eq("userId", person.id))
            .collect()
        ).filter((key) => key.revokedAt === undefined).length,
    );

    expect(open).toBe(0);
  });
});
