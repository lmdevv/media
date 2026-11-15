import { ConvexClient } from "convex/browser";
import type { FunctionArgs, FunctionReturnType } from "convex/server";
import { Schema } from "effect";

import type { DomainItem } from "../commands/access";
import { api, internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { runFunction } from "./admin";
import { sharedAdmin } from "./devices";
import type { Member } from "./devices";
import { movie, seedLibrary, share } from "./probe";
import type { SignedIn } from "./sign-in";
import type { CoreStack } from "./stack-env";

/** A device's report, as `core.connect.player.report` takes it. */
export type Report = FunctionArgs<typeof api.core.connect.player.report>;

/** A Connect target as `core.connect.targets.list` shows it. */
export type Target = FunctionReturnType<typeof api.core.connect.targets.list>[number];

/** What `core.connect.player.requested` answers. */
export type Requested = FunctionReturnType<typeof api.core.connect.player.requested>;

/** Items in libraries the stack's shared admin manages, and a way to let someone play them. */
export interface Shelf {
  /** A movie for everyone. */
  readonly film: DomainItem;
  /** A movie for 17 and up. */
  readonly rated: DomainItem;
  /** The first song of `album`. */
  readonly song: DomainItem;
  /** The second song of `album`. */
  readonly next: DomainItem;
  /** A song a kid's explicit filter hides. */
  readonly explicit: DomainItem;
  readonly album: DomainItem;
  /**
   * Lets `who` play every item here and answers them. Shared with each person, not the household,
   * so other suites' people never page through these songs.
   */
  readonly share: (who: Member) => Promise<Member>;
}

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// music seam answered this one through `v.id("albums")`; the backend checks it again when a call
// names it.
const isAlbumId = (value: unknown): value is Id<"albums"> => Schema.is(Schema.String)(value);

const TrackRow = Schema.NullOr(Schema.Struct({ albumId: Schema.declare(isAlbumId) }));

const at = <T>(values: ReadonlyArray<T>, index: number): T => {
  const value = values[index];

  if (value === undefined) throw new Error(`seeded no item ${index}`);

  return value;
};

const track = (id: Id<"tracks">): DomainItem => ({ domain: "music", ref: { type: "track", id } });

const shelves = new Map<string, Promise<Shelf>>();

const shelve = async (stack: CoreStack): Promise<Shelf> => {
  const admin = await sharedAdmin(stack);

  const films = await seedLibrary(stack, admin, {
    name: "Connect films",
    kind: "movies",
    items: [movie("everyone", 0), movie("rated", 17)],
  });

  const songs = await seedLibrary(stack, admin, {
    name: "Connect songs",
    kind: "music",
    items: [
      { name: "01 first", explicit: false, album: "Connect Album" },
      { name: "02 second", explicit: false, album: "Connect Album" },
      { name: "explicit", explicit: true, album: "Connect Singles" },
    ],
  });

  const first = at(songs.itemIds, 0);
  const row = await runFunction(stack, internal.music.probe.track, { trackId: first }, TrackRow);

  if (row === null) throw new Error("the seeded song is gone");

  return {
    film: { domain: "movies", ref: { type: "title", id: at(films.itemIds, 0) } },
    rated: { domain: "movies", ref: { type: "title", id: at(films.itemIds, 1) } },
    song: track(first),
    next: track(at(songs.itemIds, 1)),
    explicit: track(at(songs.itemIds, 2)),
    album: { domain: "music", ref: { type: "album", id: row.albumId } },
    share: async (who) => {
      await Promise.all(
        [films.libraryId, songs.libraryId].map(async (libraryId) =>
          share(admin, libraryId, { kind: "user", userId: who.userId }, "view"),
        ),
      );

      return who;
    },
  };
};

/** One shelf per stack for every Connect test. */
export const shelf = (stack: CoreStack): Promise<Shelf> => {
  const made = shelves.get(stack.url) ?? shelve(stack);

  shelves.set(stack.url, made);

  return made;
};

/** Playing `item` at `positionMs` on the device itself, having applied `applied`. */
export const playing = (item: DomainItem, positionMs: number, applied = 0): Report => ({
  output: { kind: "local" },
  playback: { item, playing: true, positionMs },
  applied,
});

/** Paused on `item` at `positionMs`, having applied `applied`. */
export const paused = (item: DomainItem, positionMs: number, applied = 0): Report => ({
  output: { kind: "local" },
  playback: { item, playing: false, positionMs },
  applied,
});

/** Playing nothing, having applied `applied`. */
export const idle = (applied = 0): Report => ({
  output: { kind: "local" },
  playback: null,
  applied,
});

/** Reports `sent` from the device `device` is signed in on. */
export const report = (device: SignedIn, sent: Report) =>
  device.client.mutation(api.core.connect.player.report, sent);

/** What another device asked of the one `device` is signed in on. */
export const requested = (device: SignedIn): Promise<Requested> =>
  device.client.query(api.core.connect.player.requested, {});

/** The targets `controller` may control. */
export const targets = (controller: SignedIn) =>
  controller.client.query(api.core.connect.targets.list, {});

/** The target `deviceId` in `shown`, or undefined. */
export const targetIn = (
  shown: ReadonlyArray<Target>,
  deviceId: Id<"devices">,
): Target | undefined => shown.find((target) => target.deviceId === deviceId);

export const control = (
  controller: SignedIn,
  deviceId: Id<"devices">,
  change: Omit<FunctionArgs<typeof api.core.connect.targets.control>, "deviceId">,
) => controller.client.mutation(api.core.connect.targets.control, { deviceId, ...change });

/** Asks `deviceId` to play `item` from `positionMs`, as `controller`. */
export const load = (
  controller: SignedIn,
  deviceId: Id<"devices">,
  item: DomainItem,
  positionMs?: number,
) =>
  controller.client.mutation(
    api.core.connect.targets.load,
    positionMs === undefined ? { deviceId, item } : { deviceId, item, positionMs },
  );

/** Moves what plays on `from` to `to`, as `controller`. */
export const move = (controller: SignedIn, from: Id<"devices">, to: Id<"devices">) =>
  controller.client.mutation(api.core.connect.targets.move, { from, to });

/** A websocket client signed in as `signedIn`, which pushes query updates as they commit. */
export const live = (stack: CoreStack, signedIn: SignedIn): ConvexClient => {
  const client = new ConvexClient(stack.url, { logger: false });

  client.setAuth(() => Promise.resolve(signedIn.token));

  return client;
};
