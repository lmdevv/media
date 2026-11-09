import { Context, Effect, Layer, Redacted, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it } from "vitest";

import * as Platform from "../platform/platform";
import { createPlatform } from "../platform/promise";
import { createPlatformPerson } from "../testing/platform-people";
import type { PlatformPerson } from "../testing/platform-people";
import { findPlatformStack } from "../testing/stack-env";
import type { PlatformStack } from "../testing/stack-env";
import * as TokenStorage from "../token-storage";

const stack = findPlatformStack();

const url = stack?.url ?? "";

const Seeded = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Literal("success"),
    value: Schema.Array(
      Schema.Struct({
        libraryId: Schema.String,
        titles: Schema.Array(Schema.Struct({ titleId: Schema.String })),
      }),
    ),
  }),
);

/**
 * Seeds a movies library that `managerId` manages through the core's test seam, with the admin
 * key as the server host holds it, and answers its title ids in order.
 */
const seedMovies = async (
  core: PlatformStack,
  managerId: string,
  titles: ReadonlyArray<{ readonly name: string; readonly age: number | null }>,
): Promise<ReadonlyArray<string>> => {
  const response = await fetch(`${core.url}/api/function`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Convex ${core.adminKey}` },
    body: JSON.stringify({
      path: "movies/probe:seed",
      args: {
        managerId,
        libraries: [
          {
            name: `sdk-movies-${Math.random().toString(36).slice(2, 8)}`,
            titles: titles.map((title) => ({ ...title, episodes: 0 })),
          },
        ],
      },
      format: "json",
    }),
  });

  const [library] = Schema.decodeSync(Seeded)(await response.text()).value;

  return library?.titles.map((title) => title.titleId) ?? [];
};

const signedInAs = (person: PlatformPerson) =>
  Effect.gen(function* () {
    const platform = Context.get(
      yield* Layer.build(
        Platform.layer({ url, connection: "http", storage: TokenStorage.layerMemory }),
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

describe.skipIf(stack === undefined)("platform.movies on the stack", { timeout: 60_000 }, () => {
  it("browses, plays, and keeps a list through the generated movies methods", async () => {
    if (stack === undefined) return;

    const [owner, stranger] = await Promise.all([
      createPlatformPerson(stack, "sdk-movies-owner"),
      createPlatformPerson(stack, "sdk-movies-stranger"),
    ]);

    const answer = await scoped(
      Effect.gen(function* () {
        const platform = yield* signedInAs(owner);
        const { userId } = yield* platform.core.auth.sessions.current();

        const [first, second] = yield* Effect.promise(async () =>
          seedMovies(stack, userId, [
            { name: "Elephants Dream", age: 0 },
            { name: "Cosmos Laundromat", age: 13 },
          ]),
        );

        if (first === undefined || second === undefined)
          return yield* Effect.die("no titles seeded");

        const listed = yield* platform.movies.titles.list({
          paginationOpts: { numItems: 50, cursor: null },
        });

        const titleId = listed.page.find((title) => title.name === "Elephants Dream")?.id;

        if (titleId === undefined) return yield* Effect.die("the seeded title was not listed");

        const detail = yield* platform.movies.titles.get({ titleId });

        yield* platform.movies.myList.add({ titleId });

        const myList = yield* platform.movies.myList.list({
          paginationOpts: { numItems: 10, cursor: null },
        });

        const started = yield* platform.movies.play.start({ titleId });

        const receipt = yield* platform.movies.play.report({
          fileId: started.file.id,
          positionMs: 5_000,
          durationMs: 60_000,
          event: "pause",
          startedAt: started.startedAt,
        });

        const resume = yield* platform.movies.history.continueWatching();

        const outsider = yield* signedInAs(stranger);

        const hidden = yield* outsider.movies.titles.get({ titleId }).pipe(
          Effect.as("found"),
          Effect.catchTag("NotFound", () => Effect.succeed("not found")),
        );

        return {
          names: listed.page.map((title) => title.name).toSorted(),
          detail: detail.name,
          myList: myList.page.map((title) => title.id),
          ticket: started.ticket.length > 0,
          receipt,
          resume: resume.map((item) => item.progress?.positionMs ?? null),
          hidden,
        };
      }),
    );

    expect(answer).toEqual({
      names: ["Cosmos Laundromat", "Elephants Dream"],
      detail: "Elephants Dream",
      myList: [expect.any(String)],
      ticket: true,
      receipt: { applied: true, watched: false },
      resume: [5_000],
      hidden: "not found",
    });
  });

  it("searches titles through the Promise entry", async () => {
    if (stack === undefined) return;

    const person = await createPlatformPerson(stack, "sdk-movies-search");
    const platform = createPlatform({ url, connection: "http" });

    try {
      await platform.session.signInWithPassword(person);

      const { userId } = await platform.core.auth.sessions.current();

      await seedMovies(stack, userId, [{ name: "Spring Promise", age: 0 }]);

      const found = await platform.movies.titles.search({ query: "Spring Promise" });

      expect(found.map((title) => title.name)).toEqual(["Spring Promise"]);
      expect(await platform.movies.titles.search({ query: "  " })).toEqual([]);
    } finally {
      await platform.dispose();
    }
  });
});
