import { Context, Effect, Layer, Redacted, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import * as Platform from "../platform/platform";
import { createPlatform } from "../platform/promise";
import { ownClientFetch } from "../testing/own-client";
import { createPlatformPerson, stackSignIn } from "../testing/platform-people";
import type { PlatformPerson } from "../testing/platform-people";
import { findPlatformStack } from "../testing/stack-env";
import type { PlatformStack } from "../testing/stack-env";
import * as TokenStorage from "../token-storage";

const stack = findPlatformStack();

const url = stack?.url ?? "";

const stackOrEmpty = stack ?? { url, adminKey: "", signInUrl: "" };

/** The Promise entry's sign-in options: the stack's boundary, as a client of its own. */
const signInOptions = () => ({ signInUrl: stackOrEmpty.signInUrl, signInFetch: ownClientFetch() });

const Seeded = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Literal("success"),
    value: Schema.Array(
      Schema.Struct({ libraryId: Schema.String, itemIds: Schema.Array(Schema.String) }),
    ),
  }),
);

/** Seeds a music library `managerId` manages with songs on `album`, shared to view with `viewerIds`. */
const seedMusic = async (
  core: PlatformStack,
  managerId: string,
  album: string,
  names: ReadonlyArray<string>,
  viewerIds: ReadonlyArray<string> = [],
): Promise<ReadonlyArray<string>> => {
  const response = await fetch(`${core.url}/api/function`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Convex ${core.adminKey}` },
    body: JSON.stringify({
      path: "music/probe:seed",
      args: {
        managerId,
        viewers: viewerIds,
        libraries: [
          {
            name: `sdk-music-${Math.random().toString(36).slice(2, 8)}`,
            items: names.map((name) => ({ name, explicit: false, album })),
          },
        ],
      },
      format: "json",
    }),
  });

  const text = await response.text();

  const [library] = Schema.decodeSync(Seeded)(text).value;

  return library?.itemIds ?? [];
};

const signedInAs = (person: PlatformPerson) =>
  Effect.gen(function* () {
    const platform = Context.get(
      yield* Layer.build(
        Platform.layer({
          url,
          connection: "http",
          storage: TokenStorage.layerMemory,
          signIn: stackSignIn(stackOrEmpty),
        }),
      ),
      Platform.Platform,
    );

    yield* platform.session.signIn(
      Platform.Credentials.Password({
        username: person.username,
        password: Redacted.make(person.password),
      }),
    );

    return platform;
  });

const scoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

describe.skipIf(stack === undefined)("platform.music on the stack", { timeout: 60_000 }, () => {
  it("browses, plays, likes, queues, and shares through the generated music methods", async () => {
    if (stack === undefined) return;

    const [owner, friend, stranger] = await Promise.all([
      createPlatformPerson(stack, "sdk-music-owner"),
      createPlatformPerson(stack, "sdk-music-friend"),
      createPlatformPerson(stack, "sdk-music-stranger"),
    ]);

    const answer = await scoped(
      Effect.gen(function* () {
        const platform = yield* signedInAs(owner);
        const pal = yield* signedInAs(friend);
        const outsider = yield* signedInAs(stranger);
        const { userId } = yield* platform.core.auth.sessions.current();
        const { userId: friendId } = yield* pal.core.auth.sessions.current();
        const album = `SDK Album ${userId}`;

        const songs = yield* Effect.promise(async () =>
          seedMusic(stack, userId, album, ["Sunrise", "Noon", "Dusk"]),
        );

        const albums = yield* platform.music.albums.list({
          paginationOpts: { numItems: 200, cursor: null },
        });

        const albumId = albums.page.find((card) => card.title === album)?.id;

        if (albumId === undefined) return yield* Effect.die("the seeded album was not listed");

        const tracks = yield* platform.music.albums.tracks({
          albumId,
          paginationOpts: { numItems: 10, cursor: null },
        });

        const sunrise = tracks.page.find((track) => track.title === "Sunrise")?.id;

        if (sunrise === undefined) return yield* Effect.die("the seeded song was not listed");

        const started = yield* platform.music.play.start({ trackId: sunrise });

        const recorded = yield* platform.music.play.report({
          trackId: sunrise,
          playbackId: started.playbackId,
        });

        yield* platform.music.likes.set({ trackId: sunrise, liked: true });

        const liked = yield* platform.music.likes.list({
          paginationOpts: { numItems: 10, cursor: null },
        });

        yield* platform.music.queue.autoplay({ on: false });

        const { current } = yield* platform.music.queue.play({
          trackIds: tracks.page.map((track) => track.id),
        });

        const queue = yield* platform.music.queue.get();

        const { playlistId } = yield* platform.music.playlists.create({
          name: "SDK mix",
          trackIds: [sunrise],
        });

        yield* platform.music.playlists.share({ playlistId, userId: friendId });

        const shared = yield* pal.music.playlists.shared({
          paginationOpts: { numItems: 10, cursor: null },
        });

        const hidden = yield* outsider.music.playlists.get({ playlistId }).pipe(
          Effect.as("found"),
          Effect.catchTag("NotFound", () => Effect.succeed("not found")),
        );

        return {
          songs: songs.length,
          titles: tracks.page.map((track) => track.title).toSorted(),
          ticket: started.ticket.length > 0,
          recorded,
          liked: liked.page.map((track) => track.id),
          queue: { current: queue.current === current, count: queue.count },
          shared: shared.page.map((playlist) => playlist.id),
          playlistId,
          hidden,
        };
      }),
    );

    expect(answer).toMatchObject({
      songs: 3,
      titles: ["Dusk", "Noon", "Sunrise"],
      ticket: true,
      recorded: { recorded: true },
      queue: { current: true, count: 3 },
      hidden: "not found",
    });
    expect(answer.liked).toHaveLength(1);
    expect(answer.shared).toEqual([answer.playlistId]);
  });

  it("searches music through the Promise entry", async () => {
    if (stack === undefined) return;

    const person = await createPlatformPerson(stack, "sdk-music-search");
    const platform = createPlatform({ url, connection: "http", ...signInOptions() });

    try {
      await platform.session.signInWithPassword(person);

      const { userId } = await platform.core.auth.sessions.current();
      const word = `sdkword${userId.slice(-6)}`;

      await seedMusic(stack, userId, `${word} album`, [`${word} song`]);

      const found = await platform.music.library.search({ query: word });

      expect(found.tracks.map((track) => track.title)).toEqual([`${word} song`]);
      expect(found.albums.map((card) => card.title)).toEqual([`${word} album`]);
      expect(await platform.music.library.search({ query: "  " })).toEqual({
        tracks: [],
        albums: [],
        artists: [],
      });
    } finally {
      await platform.dispose();
    }
  });
});
