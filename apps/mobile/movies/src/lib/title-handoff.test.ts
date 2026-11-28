import { createPlatform } from "@media/sdk/promise";
import type { PlatformSdk } from "@media/sdk/promise";
import * as FakeConvex from "@media/sdk/testing/fake-convex";
import { Reply } from "@media/sdk/testing/fake-convex";
import { Effect, Option, Schema } from "effect";
import type { Scope } from "effect";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { asTitleId } from "./catalog";
import type { TitleCard, TitleId } from "./catalog";
import { createTitleHandoff, HELD_CARDS } from "./title-handoff";

const GET = "movies/titles:get";

const card = (id: string, name = `Title ${id}`): TitleCard => ({
  id: asTitleId(id),
  kind: "movie",
  name,
  year: 2008,
  certification: null,
  ageRating: null,
  runtimeMs: 90_000,
  genres: [],
  artwork: { poster: null, backdrop: null, logo: null },
  available: true,
  addedAt: 0,
});

/** `titles.get`'s answer for title `id`, as the core sends it. */
const detailOf = (id: string) => ({
  ...card(id),
  libraryId: "library",
  sortName: `Title ${id}`,
  overview: null,
  tagline: null,
  externalIds: { tmdb: null, imdb: null, tvdb: null },
  matchStatus: "matched",
  originalName: null,
  releaseDate: null,
  status: null,
  originalLanguage: null,
  studios: [],
  countries: [],
  tags: [],
  ratings: { tmdb: null, imdb: null, rottenTomatoes: null, metacritic: null },
  trailer: null,
  collection: null,
  cast: [],
  crew: [],
  seasons: [],
  files: [],
  versions: [],
  progress: null,
  nextEpisode: null,
  inMyList: false,
});

const decodeTitleArgs = Schema.decodeUnknownOption(Schema.Struct({ titleId: Schema.String }));

/** The title a call to `titles.get` asked for. */
const titleIdOf = (args: Schema.Json): string | null =>
  Option.getOrNull(Option.map(decodeTitleArgs(args), ({ titleId }) => titleId));

/** Waits until `ready` holds, checking every 20 ms for up to 5 s. */
const until = (ready: () => boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    for (let tries = 0; tries < 250 && !ready(); tries += 1) yield* Effect.sleep("20 millis");
  });

/**
 * A platform over a fake core whose `titles.get` answers each title with its detail, after
 * `delayOf(titleId)`.
 */
const platformAnswering = (
  delayOf: (titleId: string) => number,
): Effect.Effect<{ platform: PlatformSdk; fake: FakeConvex.FakeConvex }, never, Scope.Scope> =>
  Effect.gen(function* () {
    const fake = yield* FakeConvex.make;

    yield* fake.handle(GET, (request) => {
      const titleId = titleIdOf(request.args) ?? "";

      return Effect.as(
        Effect.sleep(`${delayOf(titleId)} millis`),
        Reply.Success({ value: detailOf(titleId) }),
      );
    });

    const platform = createPlatform({
      url: fake.url,
      signInUrl: fake.signInUrl,
      connection: "http",
    });

    yield* Effect.addFinalizer(() => Effect.promise(() => platform.dispose()));

    return { platform, fake };
  });

/** What the page of title `titleId` reads from the SDK as it renders. */
const pageAnswer = (platform: PlatformSdk, titleId: TitleId) =>
  platform.movies.titles.get.watch({ titleId }).getSnapshot();

describe("a press on a title", () => {
  it("asks for the title as the finger goes down, so its page reads the answer as it mounts", async () => {
    const asked = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const { platform, fake } = yield* platformAnswering(() => 0);
          const handoff = createTitleHandoff(platform.movies.titles.get);
          const pressed = card("caminandes", "Caminandes");

          handoff.pressing(pressed);

          // Nothing has mounted the page yet: only the press follows the query.
          yield* until(() => pageAnswer(platform, pressed.id).status === "success");
          const answer = pageAnswer(platform, pressed.id);

          expect(answer.status === "success" ? answer.data.id : answer.status).toBe("caminandes");
          expect(handoff.cardFor(pressed.id)).toEqual(pressed);

          return (yield* fake.requestsTo(GET)).map((request) => titleIdOf(request.args));
        }),
      ),
    );

    expect(new Set(asked)).toEqual(new Set(["caminandes"]));
  });

  it("never hands a page another title's card or answer, even when that answer comes last", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // A's answer arrives well after B's.
          const { platform } = yield* platformAnswering((titleId) => (titleId === "a" ? 400 : 0));
          const handoff = createTitleHandoff(platform.movies.titles.get);
          const a = asTitleId("a");
          const b = asTitleId("b");

          handoff.pressing(card("a"));
          handoff.pressing(card("b"));

          yield* until(() => pageAnswer(platform, b).status === "success");
          const onB = pageAnswer(platform, b);

          expect(onB.status === "success" ? onB.data.id : onB.status).toBe("b");
          expect(handoff.cardFor(b)?.id).toBe("b");

          yield* until(() => pageAnswer(platform, a).status === "success");
          const afterA = pageAnswer(platform, b);

          expect(afterA.status === "success" ? afterA.data.id : afterA.status).toBe("b");
          expect(handoff.cardFor(b)?.id).toBe("b");
          expect(handoff.cardFor(asTitleId("c"))).toBeNull();
        }),
      ),
    );
  });
});

describe("the handoff's cards", () => {
  it("hold each title's last pressed card, for the last presses of up to its limit of titles", () => {
    const ids = fc.constantFrom(
      ...Array.from({ length: HELD_CARDS + 5 }, (_, index) => `t${index}`),
    );

    const press = fc.record({ id: ids, name: fc.string() });

    fc.assert(
      fc.property(fc.array(press, { maxLength: 80 }), (presses) => {
        const preloaded: Array<TitleId> = [];

        const handoff = createTitleHandoff({
          preload: ({ titleId }) => {
            preloaded.push(titleId);

            return Promise.resolve();
          },
        });

        for (const { id, name } of presses) handoff.pressing(card(id, name));

        // Every press asks for its own title.
        expect(preloaded).toEqual(presses.map(({ id }) => id));

        // The titles pressed most recently, newest first, up to the limit.
        const recent = new Set(
          [...new Set(presses.map(({ id }) => id).toReversed())].slice(0, HELD_CARDS),
        );

        for (let index = 0; index < HELD_CARDS + 5; index += 1) {
          const id = asTitleId(`t${index}`);
          const last = presses.findLast((pressed) => pressed.id === id);
          const held = handoff.cardFor(id);

          if (last === undefined || !recent.has(id)) expect(held).toBeNull();
          else expect(held).toEqual(card(id, last.name));
        }
      }),
    );
  });
});
