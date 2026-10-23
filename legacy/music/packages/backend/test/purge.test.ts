/**
 * Removing a person leaves no row that names them. The tables come from the schema: a new table
 * with a `userId` field fails to compile here until it has a seeder, and fails the test until the
 * removal deletes its rows.
 */
import { DeviceId, UserId } from "@music/commands/ids";
import type { LibraryId, TrackId } from "@music/commands/ids";
import { describe, expect, it } from "vitest";

import type { DataModel, Doc, Id, TableNames } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { inOrder } from "../convex/lib/sequence";
import { allTracks, drainScheduled, makeBackend, signUp, upsertFiles } from "./backend";
import type { Backend, User } from "./backend";

/** Tables whose rows belong to the person their `userId` names. */
type PersonTable = {
  [Table in TableNames]: "userId" extends keyof DataModel[Table]["document"] ? Table : never;
}[TableNames];

type Ctx = Parameters<Parameters<Backend["run"]>[0]>[0];

/** What every seeder may use: the person, someone else on the server, and their catalog. */
interface World {
  readonly backend: Backend;
  readonly person: User;
  readonly owner: User;
  readonly libraryId: LibraryId;
  readonly trackId: TrackId;
  readonly jamCode: string;
}

const DEVICE = DeviceId.make("person-phone");

/** Gives the person at least one row in a table, the way the app would where that is cheap. */
type Seeders = {
  readonly [Table in PersonTable]: (world: World) => Promise<void>;
};

/** Writes rows straight to the database as the person, for tables no cheap command fills. */
const insert = async (
  world: World,
  write: (ctx: Ctx, userId: Id<"users">) => Promise<void>,
): Promise<void> => {
  await world.backend.run(async (ctx) => write(ctx, world.person.id));
};

/** The person's song as a document. */
const songOf = async (ctx: Ctx, world: World): Promise<Doc<"tracks">> => {
  const id = ctx.db.normalizeId("tracks", world.trackId);
  const track = id === null ? null : await ctx.db.get(id);

  if (track === null) throw new Error("The song is gone");

  return track;
};

const SEEDERS: Seeders = {
  // `signUp` opened a session already.
  authSessions: async () => {},
  authAccounts: (world) =>
    insert(world, async (ctx, userId) => {
      await ctx.db.insert("authAccounts", { userId, provider: "password", providerAccountId: "p" });
    }),
  passwordResets: (world) =>
    insert(world, async (ctx, userId) => {
      await ctx.db.insert("passwordResets", {
        userId,
        hash: "reset",
        expiresAt: Date.now() + 60_000,
      });
    }),
  apiKeys: (world) =>
    insert(world, async (ctx, userId) => {
      await ctx.db.insert("apiKeys", { userId, name: "agent", prefix: "mk_test", hash: "key" });
    }),
  libraryAccess: async (world) => {
    await world.owner.music.run("libraries.grant", {
      libraryId: world.libraryId,
      userId: UserId.make(world.person.id),
    });
  },
  playlistShares: async (world) => {
    const { playlistId } = await world.owner.music.run("playlists.create", { name: "Shared" });

    await world.owner.music.run("playlists.share", {
      playlistId,
      userId: UserId.make(world.person.id),
    });
  },
  likes: (world) =>
    insert(world, async (ctx, userId) => {
      await ctx.db.insert("likes", { userId, trackId: (await songOf(ctx, world))._id });
    }),
  history: (world) =>
    insert(world, async (ctx, userId) => {
      const track = await songOf(ctx, world);

      await ctx.db.insert("history", {
        userId,
        trackId: track._id,
        albumId: track.albumId,
        deviceId: DEVICE,
      });
    }),
  devices: async (world) => {
    await world.person.music.run("devices.heartbeat", {
      deviceId: DEVICE,
      name: "Phone",
      kind: "phone",
    });
  },
  playbackSessions: async (world) => {
    await world.person.music.run("playback.play", { trackIds: [world.trackId], deviceId: DEVICE });
  },
  // `playback.play` saved their queue too.
  playbackQueues: async () => {},
  jamMembers: async (world) => {
    await world.person.music.run("jam.join", { code: world.jamCode });
  },
  downloadPins: async (world) => {
    await world.person.music.run("downloads.add", {
      deviceId: DEVICE,
      kind: "track",
      id: world.trackId,
    });
  },
};

/** The tables the schema gives a `userId` field, read from its validators. */
const personTables = (): ReadonlyArray<string> =>
  Object.entries(schema.tables).flatMap(([name, table]) =>
    "userId" in table.validator.fields ? [name] : [],
  );

const isPersonTable = (name: string): name is PersonTable => Object.hasOwn(SEEDERS, name);

/** How many rows of each person table name `userId`. */
const rowsOf = (backend: Backend, userId: Id<"users">) =>
  backend.run(async (ctx) =>
    Object.fromEntries(
      await Promise.all(
        personTables()
          .filter(isPersonTable)
          .map(async (table) => {
            const rows = await ctx.db.query(table).collect();

            return [table, rows.filter((row) => row.userId === userId).length] as const;
          }),
      ),
    ),
  );

describe("removing a person", () => {
  it("deletes their rows from every table that has a userId", async () => {
    const backend = makeBackend();
    const owner = await signUp(backend, "owner");
    const person = await signUp(backend, "member");

    // Restricted, so granting the person access writes a row.
    const { libraryId } = await owner.music.run("libraries.create", {
      name: "Rock",
      path: "/music/rock",
      visibility: "restricted",
    });

    await upsertFiles(backend, libraryId, [{ path: "Rock/One.flac", title: "One" }]);
    const [trackId] = (await allTracks(owner)).map((track) => track.id);

    if (trackId === undefined) throw new Error("The library has no songs");

    await owner.music.run("devices.heartbeat", {
      deviceId: DeviceId.make("host"),
      name: "Mac",
      kind: "web",
    });
    await owner.music.run("playback.play", {
      trackIds: [trackId],
      deviceId: DeviceId.make("host"),
    });

    const { code } = await owner.music.run("jam.start", {});
    const world: World = { backend, person, owner, libraryId, trackId, jamCode: code };

    expect([...personTables()].toSorted()).toEqual(Object.keys(SEEDERS).toSorted());

    await inOrder(Object.values(SEEDERS), (seed) => seed(world));

    const seeded = await rowsOf(backend, person.id);

    expect(Object.entries(seeded).filter(([, count]) => count === 0)).toEqual([]);

    await owner.music.run("people.remove", { userId: UserId.make(person.id) });
    await drainScheduled(backend);

    expect(
      Object.entries(await rowsOf(backend, person.id)).filter(([, count]) => count > 0),
    ).toEqual([]);
  });
});
