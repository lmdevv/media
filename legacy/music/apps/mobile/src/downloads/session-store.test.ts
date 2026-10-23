import { AlbumId, ArtistId, DeviceId, QueueItemId, TrackId } from "@music/commands/ids";
import type { PlaybackState } from "@music/commands/models";
import { seedLocal } from "@music/player/local-session";
import { Struct } from "effect";
import { describe, expect, it } from "vitest";

import { vaultSessions } from "./session-store";
import type { SessionDatabase } from "./session-store";

const phone = DeviceId.make("phone");

const server: PlaybackState = {
  activeDevice: { id: phone, name: "iPhone", kind: "phone", lastSeenAt: 0, online: true },
  positionMs: 42_000,
  playing: true,
  updatedAt: 1_000_000,
  volume: 0.8,
  following: false,
  queue: [
    {
      itemId: QueueItemId.make("1"),
      addedBy: null,
      autoplay: false,
      id: TrackId.make("takeoff"),
      title: "Takeoff",
      artist: "Offline Fixture",
      artistId: ArtistId.make("artist"),
      album: "Airplane Mode",
      albumId: AlbumId.make("album"),
      trackNumber: 1,
      discNumber: null,
      durationMs: 20_000,
      codec: "FLAC",
      lossless: true,
      bitrate: null,
      sampleRate: 44_100,
      bitDepth: 16,
      artUrl: null,
      liked: false,
    },
  ],
  index: 0,
  shuffle: false,
  repeat: "off",
  autoplay: true,
};

/** The server's session, `positionMs` into its song. */
const serverAt = (positionMs: number): PlaybackState => Struct.assign(server, { positionMs });

/** A database holding the session table in memory, answering the store's three statements. */
const memoryDatabase = () => {
  const rows = new Map<string, string>();

  const db: SessionDatabase = {
    getAllAsync: () => Promise.resolve(Array.from(rows, ([key, state]) => ({ key, state }))),
    runAsync: (sql, [key = "", state = ""]) => {
      if (sql.startsWith("DELETE")) rows.delete(key);
      else rows.set(key, state);

      return Promise.resolve({});
    },
  };

  return { db, rows };
};

describe("vaultSessions", () => {
  it("holds nothing at first", async () => {
    const { db } = memoryDatabase();

    expect(await vaultSessions(db).load()).toEqual({ local: null, server: null });
  });

  it("reads back the server's session and the phone's own", async () => {
    const { db } = memoryDatabase();
    const store = vaultSessions(db);
    const local = seedLocal(server, phone);

    await store.saveServer(server);
    await store.saveLocal(local);

    expect(await vaultSessions(db).load()).toEqual({ local, server });
  });

  it("forgets the phone's own session once the server took it back, and keeps the server's", async () => {
    const { db } = memoryDatabase();
    const store = vaultSessions(db);

    await store.saveServer(server);
    await store.saveLocal(seedLocal(server, phone));
    await store.saveLocal(null);

    expect(await store.load()).toEqual({ local: null, server });
  });

  it("writes the server's session one at a time, skipping to the newest", async () => {
    const { db, rows } = memoryDatabase();
    const writes: Array<string> = [];

    const counting: SessionDatabase = {
      getAllAsync: db.getAllAsync,
      runAsync: (sql, params) => {
        writes.push(params[1] ?? "");

        return db.runAsync(sql, params);
      },
    };

    const store = vaultSessions(counting);

    await Promise.all([
      store.saveServer(serverAt(1)),
      store.saveServer(serverAt(2)),
      store.saveServer(serverAt(3)),
    ]);

    expect(writes).toHaveLength(2);
    expect(JSON.parse(rows.get("server") ?? "")).toMatchObject({ positionMs: 3 });
  });

  it("still writes the newest snapshot when the write before it failed", async () => {
    const { db, rows } = memoryDatabase();
    let failures = 1;

    const flaky: SessionDatabase = {
      getAllAsync: db.getAllAsync,
      runAsync: (sql, params) => {
        if (failures === 0) return db.runAsync(sql, params);
        failures -= 1;

        return Promise.reject(new Error("The disk is full"));
      },
    };

    const store = vaultSessions(flaky);

    const saved = await Promise.allSettled([
      store.saveServer(serverAt(1)),
      store.saveServer(serverAt(2)),
    ]);

    expect(saved.map((result) => result.status)).toEqual(["rejected", "rejected"]);
    expect(JSON.parse(rows.get("server") ?? "")).toMatchObject({ positionMs: 2 });
  });

  it("reads a row it can't parse as nothing stored", async () => {
    const { db, rows } = memoryDatabase();

    rows.set("local", "{not json");
    rows.set("server", JSON.stringify(server).replace(`"index":0`, `"index":-1`));

    expect(await vaultSessions(db).load()).toEqual({ local: null, server: null });
  });
});
