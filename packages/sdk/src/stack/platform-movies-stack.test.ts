import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import * as Platform from "../platform/platform";
import { createPlatform } from "../platform/promise";
import { createPlatformPerson, stackSignIn } from "../testing/platform-people";
import { ownClientFetch } from "../testing/own-client";
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
      Schema.Struct({
        libraryId: Schema.String,
        titles: Schema.Array(Schema.Struct({ titleId: Schema.String })),
      }),
    ),
  }),
);

const seedMovies = async (
  core: PlatformStack,
  managerId: string,
  titles: ReadonlyArray<{ readonly name: string; readonly age: number | null }>,
  genre = "sdk",
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
            titles: titles.map((title) => ({ ...title, episodes: 0, genres: [genre] })),
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

interface Listed {
  readonly id: Platform.Id<"titles">;
  readonly name: string;
}

const scoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

describe.skipIf(stack === undefined)("platform.movies on the stack", { timeout: 60_000 }, () => {
  it("signs a guest in from a link, renews the same identity, and ends it when revoked", async () => {
    if (stack === undefined) return;

    const admin = await createPlatformPerson(stack, "sdk-guest-admin", "admin");
    const maker = await createPlatformPerson(stack, "sdk-guest-maker");

    const answer = await scoped(
      Effect.gen(function* () {
        const host = yield* signedInAs(admin);
        const sharing = yield* signedInAs(maker);
        const { userId } = yield* sharing.core.auth.sessions.current();

        yield* Effect.promise(() => seedMovies(stack, userId, [{ name: "Shared film", age: 0 }]));

        const { page } = yield* sharing.movies.titles.list({
          paginationOpts: { numItems: 10, cursor: null },
        });

        const titleId = page[0]?.id;

        if (titleId === undefined) return yield* Effect.die("the shared title was not listed");

        yield* host.core.guests.configure({
          enabled: true,
          address: "https://guests.example.ts.net",
        });
        yield* host.core.guests.allow({ userId, allowed: true });

        const target = {
          kind: "item",
          item: { domain: "movies", ref: { type: "title", id: titleId } },
        } as const;

        const link = yield* sharing.core.guests.links.create({ target });
        const code = link.url.slice(link.url.indexOf("#") + 1);
        const values = new Map<string, string>();
        const key = "media.session";
        const clock = yield* Layer.build(TestClock.layer());

        return yield* Effect.gen(function* () {
          yield* TestClock.setTime(Date.now());

          const context = yield* Layer.build(
            Platform.layer({
              url,
              connection: "http",
              signIn: stackSignIn(stack),
              storage: TokenStorage.layerKeyValue(
                {
                  getItem: (name) => values.get(name) ?? null,
                  setItem: (name, value) => {
                    values.set(name, value);
                  },
                  removeItem: (name) => {
                    values.delete(name);
                  },
                },
                key,
              ),
            }),
          );

          const guest = Context.get(context, Platform.Platform);

          yield* guest.session.signInAsGuest({ code: Redacted.make(code), name: "  Sam  " });
          const before = yield* guest.core.auth.sessions.current();
          const shared = yield* guest.core.guests.current();
          const stored = Option.getOrThrow(TokenStorage.parseStoredSession(values.get(key) ?? ""));

          const claims = yield* Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ exp: Schema.Finite })),
          )(Option.getOrThrow(TokenStorage.tokenPayload(Redacted.value(stored.token))));

          yield* TestClock.setTime(claims.exp * 1000 - 30_000);
          const after = yield* guest.core.auth.sessions.current();
          const renewed = Option.getOrThrow(TokenStorage.parseStoredSession(values.get(key) ?? ""));
          yield* TestClock.setTime(Date.now());

          const sharedAfterRefresh = yield* guest.core.guests.current();

          yield* sharing.core.guests.links.revoke({ linkId: link.linkId });
          const refused = yield* Effect.flip(guest.core.guests.current());
          const sessionAfterRevoke = yield* Effect.flip(guest.core.auth.sessions.current());
          const currentAfterRevoke = yield* Effect.flip(guest.core.guests.current());

          const reused = yield* Effect.flip(
            guest.session.signInAsGuest({ code: Redacted.make(code), name: "Again" }),
          );

          return {
            before,
            sameIdentity: before.userId === after.userId && before.sessionId === after.sessionId,
            refreshed: Redacted.value(stored.refreshToken) !== Redacted.value(renewed.refreshToken),
            shared,
            sharedAfterRefresh,
            target,
            sharedBy: maker.username,
            refused,
            sessionAfterRevoke,
            currentAfterRevoke,
            reused,
          };
        }).pipe(Effect.provideContext(clock));
      }),
    );

    expect(answer).toMatchObject({
      before: {
        username: "Sam",
        role: "guest",
        kind: "guest",
        scopes: ["movies:play", "music:play"],
      },
      sameIdentity: true,
      refreshed: true,
      shared: { name: "Sam", sharedBy: answer.sharedBy, target: answer.target },
      refused: { _tag: "Unauthenticated" },
      sessionAfterRevoke: { _tag: "Unauthenticated" },
      currentAfterRevoke: { _tag: "Unauthenticated" },
      reused: { _tag: "Expired" },
    });
    expect(answer.sharedAfterRefresh).toStrictEqual(answer.shared);
  });

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

        const genre = `sdk ${userId}`;

        const [first, second] = yield* Effect.promise(async () =>
          seedMovies(
            stack,
            userId,
            [
              { name: "Elephants Dream", age: 0 },
              { name: "Cosmos Laundromat", age: 13 },
            ],
            genre,
          ),
        );

        if (first === undefined || second === undefined)
          return yield* Effect.die("no titles seeded");

        const listAll = (
          cursor: string | null,
          titles: ReadonlyArray<Listed>,
        ): Effect.Effect<ReadonlyArray<Listed>, Platform.PlatformError> =>
          Effect.flatMap(
            platform.movies.titles.list({ paginationOpts: { numItems: 50, cursor }, genre }),
            (page) => {
              const next = [...titles, ...page.page];

              return page.isDone ? Effect.succeed(next) : listAll(page.continueCursor, next);
            },
          );

        const listed = (yield* listAll(null, [])).filter(
          (title) => title.id === first || title.id === second,
        );

        const titleId = listed.find((title) => title.name === "Elephants Dream")?.id;

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
          playbackId: started.playbackId,
        });

        const resume = yield* platform.movies.history.continueWatching();

        const outsider = yield* signedInAs(stranger);

        const hidden = yield* outsider.movies.titles.get({ titleId }).pipe(
          Effect.as("found"),
          Effect.catchTag("NotFound", () => Effect.succeed("not found")),
        );

        return {
          names: listed.map((title) => title.name).toSorted(),
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
    const platform = createPlatform({ url, connection: "http", ...signInOptions() });

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
