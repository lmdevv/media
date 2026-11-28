import { Deferred, Effect, Option, Predicate, Schema } from "effect";
import type { Scope } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { QueryState } from "../query-watch";
import * as FakeConvex from "../testing/fake-convex";
import { jwtIssuedAt, Reply } from "../testing/fake-convex";
import type { KeyValueStore } from "../token-storage";
import { createPlatform } from "./promise";
import type { PlatformSdk } from "./promise";
import type { SaveAnswers } from "./saved-answers";

const ADA = "user-1|session-1";

const GRACE = "user-2|session-2";

const tokenOf = (subject: string): string => jwtIssuedAt(Date.now(), 3600, subject);

const SERVER_THEN = { name: "Lar", version: "0.9.0", hasOwner: true };

const SERVER_NOW = { name: "Lar at home", version: "0.10.0", hasOwner: true };

const meOf = (userId: string, sessionId: string, username: string) => ({
  userId,
  username,
  displayName: null,
  role: "owner",
  sessionId,
  kind: "password",
  scopes: ["account"],
  device: null,
});

const ADA_ME = meOf("user-1", "session-1", "ada");

const RELEASE = "1.4.0";

const INFO = "core.server.info";

const ME = "core.auth.sessions.current";

const memoryFile = (text: string | null, readGate: Promise<void> = Promise.resolve()) => {
  const state = { text, writes: 0, removes: 0 };

  return {
    state,
    file: {
      read: async () => {
        await readGate;

        return state.text;
      },
      write: async (next: string) => {
        state.text = next;
        state.writes += 1;
      },
      remove: async () => {
        state.text = null;
        state.removes += 1;
      },
    },
  };
};

const storeHolding = (subject: string | null): KeyValueStore => {
  const items = new Map<string, string>();

  if (subject !== null) {
    items.set("media.session", JSON.stringify({ token: tokenOf(subject), refreshToken: "r-1" }));
  }

  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };
};

const until = (check: () => boolean): Promise<void> =>
  vi.waitFor(() => expect(check()).toBe(true), { timeout: 5000, interval: 10 });

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isLive = <A>(state: QueryState<A>): boolean => state.status === "success" && !state.saved;

const decodeClaims = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ sub: Schema.String })),
);

const subjectOf = (request: { readonly authorization: string | undefined }): string | undefined => {
  const payload = request.authorization?.split(".")[1];

  return payload === undefined
    ? undefined
    : decodeClaims(Buffer.from(payload, "base64url").toString()).pipe(
        Option.map((claims) => claims.sub),
        Option.getOrUndefined,
      );
};

const parseWritten = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      release: Schema.String,
      server: Schema.String,
      session: Schema.String,
      answers: Schema.Array(
        Schema.Struct({ query: Schema.String, args: Schema.String, value: Schema.Unknown }),
      ),
    }),
  ),
);

const queriesIn = (file: { readonly answers: ReadonlyArray<{ readonly query: string }> }) =>
  file.answers.map((answer) => answer.query);

const heldRead = () => {
  const held = { finish: (): void => undefined };

  const done = new Promise<void>((resolve) => {
    held.finish = resolve;
  });

  return { done, finish: () => held.finish() };
};

const gate = () => Deferred.makeUnsafe<void>();

const letThrough = (deferred: Deferred.Deferred<void>) =>
  Effect.runPromise(Deferred.succeed(deferred, undefined));

const follow = <A>(watch: {
  subscribe: (f: () => void) => () => void;
  getSnapshot: () => QueryState<A>;
}) => {
  const seen: Array<QueryState<A>> = [watch.getSnapshot()];
  const stop = watch.subscribe(() => seen.push(watch.getSnapshot()));

  return { seen, stop, now: () => watch.getSnapshot() };
};

interface Launch {
  readonly subject: string | null;
  readonly file: ReturnType<typeof memoryFile>["file"];
  readonly queries?: ReadonlyArray<string>;
  readonly release?: string;
  readonly maxLength?: number;
}

const open = (fake: FakeConvex.FakeConvex, launch: Launch): PlatformSdk => {
  const saved: SaveAnswers = {
    file: launch.file,
    release: launch.release ?? RELEASE,
    queries: launch.queries ?? [INFO, ME],
    maxAge: "7 days",
    maxLength: launch.maxLength ?? 100_000,
  };

  return createPlatform({
    url: fake.url,
    signInUrl: fake.signInUrl,
    connection: "websocket",
    storage: storeHolding(launch.subject),
    saved,
  });
};

const withFake = <A>(body: (fake: FakeConvex.FakeConvex) => Effect.Effect<A, never, Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const fake = yield* FakeConvex.make;

        yield* fake.handle("auth:signIn", (request) =>
          Effect.succeed(
            Reply.Success({
              value: {
                tokens: {
                  token: tokenOf(Predicate.hasProperty(request.args, "refreshToken") ? ADA : GRACE),
                  refreshToken: "r-2",
                },
              },
            }),
          ),
        );

        return yield* body(fake);
      }),
    ),
  );

const savedByLastLaunch = (fake: FakeConvex.FakeConvex) =>
  Effect.gen(function* () {
    const disk = memoryFile(null);

    yield* fake.reply("core/server:info", Reply.Success({ value: SERVER_THEN }));
    yield* fake.reply("core/auth/sessions:current", Reply.Success({ value: ADA_ME }));

    const platform = open(fake, { subject: ADA, file: disk.file });

    return yield* Effect.promise(async () => {
      const info = follow(platform.core.server.info.watch());
      const me = follow(platform.core.auth.sessions.current.watch());

      await until(() => disk.state.writes > 0 && me.now().status === "success");
      await pause(1200);
      info.stop();
      me.stop();
      await platform.dispose();

      if (disk.state.text === null) throw new Error("Nothing was saved");

      return disk.state.text;
    });
  });

const fileText = (fields: {
  readonly release?: string;
  readonly server: string;
  readonly session?: string;
  readonly savedAt?: number;
  readonly query?: string;
  readonly value?: unknown;
}) =>
  JSON.stringify({
    release: fields.release ?? RELEASE,
    server: fields.server,
    session: fields.session ?? ADA,
    answers: [
      {
        query: fields.query ?? INFO,
        args: "{}",
        savedAt: fields.savedAt ?? Date.now() - 60_000,
        value: fields.value ?? SERVER_THEN,
      },
    ],
  });

describe("saved answers", () => {
  it("shows the answer the last launch saved until the server answers, then the server's", async () => {
    const answer = gate();

    const seen = await withFake((fake) =>
      Effect.gen(function* () {
        const lastLaunch = yield* savedByLastLaunch(fake);
        const disk = memoryFile(lastLaunch);

        yield* fake.handle("core/server:info", () =>
          Effect.as(Deferred.await(answer), Reply.Success({ value: SERVER_NOW })),
        );

        const platform = open(fake, { subject: ADA, file: disk.file });

        return yield* Effect.promise(async () => {
          const info = follow(platform.core.server.info.watch());

          await until(() => info.now().status === "success");
          await letThrough(answer);
          await until(() => isLive(info.now()));
          info.stop();
          await platform.dispose();

          return info.seen.filter((state) => state.status !== "loading");
        });
      }),
    );

    expect(seen).toStrictEqual([
      { status: "success", data: SERVER_THEN, saved: true },
      { status: "success", data: SERVER_NOW },
    ]);
  }, 20_000);

  it("saves the server's answer with the release, server, and session it belongs to", async () => {
    const { text, url } = await withFake((fake) =>
      Effect.map(savedByLastLaunch(fake), (lastLaunch) => ({ text: lastLaunch, url: fake.url })),
    );

    const file = parseWritten(text);

    expect({
      ...file,
      answers: new Map(file.answers.map((answer) => [answer.query, answer])),
    }).toStrictEqual({
      release: RELEASE,
      server: url,
      session: ADA,
      answers: new Map([
        [INFO, { query: INFO, args: "{}", value: SERVER_THEN }],
        [ME, { query: ME, args: "{}", value: ADA_ME }],
      ]),
    });
  }, 20_000);

  it("never shows another session's saved answers, and deletes them", async () => {
    const { seen, left } = await withFake((fake) =>
      Effect.gen(function* () {
        const lastLaunch = yield* savedByLastLaunch(fake);
        const disk = memoryFile(lastLaunch);

        yield* fake.handle("core/server:info", () => Effect.never);

        const platform = open(fake, { subject: GRACE, file: disk.file });

        return yield* Effect.promise(async () => {
          const info = follow(platform.core.server.info.watch());

          await until(() => disk.state.removes > 0);
          await pause(200);
          info.stop();
          await platform.dispose();

          return { seen: info.seen.map((state) => state.status), left: disk.state.text };
        });
      }),
    );

    expect({ seen, left }).toStrictEqual({ seen: ["loading"], left: null });
  }, 20_000);

  it("deletes saved answers at a launch signed out, finishing a sign-out the app didn't live through", async () => {
    const result = await withFake((fake) =>
      Effect.gen(function* () {
        const lastLaunch = yield* savedByLastLaunch(fake);
        const disk = memoryFile(lastLaunch);

        yield* fake.handle("core/server:info", () => Effect.never);

        const platform = open(fake, { subject: null, file: disk.file });

        return yield* Effect.promise(async () => {
          const info = follow(platform.core.server.info.watch());

          await until(() => disk.state.removes > 0);
          info.stop();
          await platform.dispose();

          return { left: disk.state.text, seen: info.seen.map((state) => state.status) };
        });
      }),
    );

    expect(result).toStrictEqual({ left: null, seen: ["loading"] });
  }, 20_000);

  it("takes a saved answer back when another person signs in before the server answers, and saves nothing for them", async () => {
    const adaAnswer = gate();

    const { seen, left } = await withFake((fake) =>
      Effect.gen(function* () {
        const lastLaunch = yield* savedByLastLaunch(fake);
        const disk = memoryFile(lastLaunch);

        yield* fake.handle("core/auth/sessions:current", (request) =>
          subjectOf(request) === GRACE
            ? Effect.succeed(Reply.Success({ value: meOf("user-2", "session-2", "grace") }))
            : Effect.as(Deferred.await(adaAnswer), Reply.Success({ value: ADA_ME })),
        );

        const platform = open(fake, { subject: ADA, file: disk.file });

        return yield* Effect.promise(async () => {
          const me = follow(platform.core.auth.sessions.current.watch());

          await until(() => me.now().status === "success");

          const signingIn = platform.session.signInWithPassword({
            username: "grace",
            password: "secret",
          });

          await until(() => me.now().status === "loading");
          await letThrough(adaAnswer);
          await signingIn;
          await until(() => isLive(me.now()));
          await until(() => disk.state.removes > 0);
          await pause(1500);
          me.stop();
          await platform.dispose();

          return { seen: me.seen, left: disk.state };
        });
      }),
    );

    const savedShown = seen.flatMap((state, index) =>
      state.status === "success" && state.saved === true ? [index] : [],
    );

    expect(savedShown).toHaveLength(1);
    expect(seen.slice(savedShown[0], (savedShown[0] ?? 0) + 2)).toStrictEqual([
      { status: "success", data: ADA_ME, saved: true },
      { status: "loading" },
    ]);
    expect(left).toMatchObject({ text: null, writes: 0 });
  }, 20_000);

  it("drops a saved answer read after the server answered", async () => {
    const read = heldRead();

    const seen = await withFake((fake) =>
      Effect.gen(function* () {
        const lastLaunch = yield* savedByLastLaunch(fake);
        const disk = memoryFile(lastLaunch, read.done);

        yield* fake.reply("core/server:info", Reply.Success({ value: SERVER_NOW }));

        const platform = open(fake, { subject: ADA, file: disk.file });

        return yield* Effect.promise(async () => {
          const info = follow(platform.core.server.info.watch());

          await until(() => info.now().status === "success");
          read.finish();
          await pause(300);
          info.stop();
          await platform.dispose();

          return info.seen.filter((state) => state.status !== "loading");
        });
      }),
    );

    expect(seen).toStrictEqual([{ status: "success", data: SERVER_NOW }]);
  }, 20_000);

  it("saves only the queries it names, shows no saved answer for another, and drops one from the file", async () => {
    const meAnswer = gate();

    const result = await withFake((fake) =>
      Effect.gen(function* () {
        const firstDisk = memoryFile(null);

        yield* fake.reply("core/server:info", Reply.Success({ value: SERVER_THEN }));
        yield* fake.reply("core/auth/sessions:current", Reply.Success({ value: ADA_ME }));

        const first = open(fake, { subject: ADA, file: firstDisk.file, queries: [INFO] });

        const written = yield* Effect.promise(async () => {
          const info = follow(first.core.server.info.watch());
          const me = follow(first.core.auth.sessions.current.watch());

          await until(() => firstDisk.state.writes > 0 && me.now().status === "success");
          await pause(1200);
          info.stop();
          me.stop();
          await first.dispose();

          return parseWritten(firstDisk.state.text);
        });

        const unlisted = memoryFile(fileText({ server: fake.url, query: ME, value: ADA_ME }));

        yield* fake.handle("core/auth/sessions:current", () =>
          Effect.as(Deferred.await(meAnswer), Reply.Success({ value: ADA_ME })),
        );

        const second = open(fake, { subject: ADA, file: unlisted.file, queries: [INFO] });

        const later = yield* Effect.promise(async () => {
          const me = follow(second.core.auth.sessions.current.watch());
          const info = follow(second.core.server.info.watch());

          await pause(500);

          const shown = me.seen.map((state) => state.status);

          await letThrough(meAnswer);
          await until(() => unlisted.state.writes > 0);
          me.stop();
          info.stop();
          await second.dispose();

          return { shown, rewritten: parseWritten(unlisted.state.text) };
        });

        return { written: queriesIn(written), ...later, rewritten: queriesIn(later.rewritten) };
      }),
    );

    expect(result).toStrictEqual({ written: [INFO], shown: ["loading"], rewritten: [INFO] });
  }, 20_000);

  it.each([
    ["another release saved it", { release: "1.3.0" }, true],
    ["another server saved it", { server: "http://elsewhere.home" }, true],
    ["it is past its age", { savedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 }, false],
    ["it was saved later than now", { savedAt: Date.now() + 60 * 60 * 1000 }, false],
    ["its answer no longer decodes", { value: { name: 7 } }, false],
  ] as const)(
    "reads as nothing saved when %s",
    async (_, fields, removed) => {
      const result = await withFake((fake) =>
        Effect.gen(function* () {
          const disk = memoryFile(fileText({ server: fake.url, ...fields }));

          yield* fake.handle("core/server:info", () => Effect.never);

          const platform = open(fake, { subject: ADA, file: disk.file });

          return yield* Effect.promise(async () => {
            const info = follow(platform.core.server.info.watch());

            await pause(500);
            info.stop();
            await platform.dispose();

            return {
              shown: info.seen.map((state) => state.status),
              removed: disk.state.text === null,
            };
          });
        }),
      );

      expect(result).toStrictEqual({ shown: ["loading"], removed });
    },
    20_000,
  );

  it.each([
    ["it isn't JSON", "{ release"],
    ["it isn't a saved-answers file", JSON.stringify({ hello: "there" })],
  ])(
    "reads as nothing saved and deletes the file when %s",
    async (_, text) => {
      const result = await withFake((fake) =>
        Effect.gen(function* () {
          const disk = memoryFile(text);

          yield* fake.handle("core/server:info", () => Effect.never);

          const platform = open(fake, { subject: ADA, file: disk.file });

          return yield* Effect.promise(async () => {
            const info = follow(platform.core.server.info.watch());

            await until(() => disk.state.removes > 0);
            info.stop();
            await platform.dispose();

            return info.seen.map((state) => state.status);
          });
        }),
      );

      expect(result).toStrictEqual(["loading"]);
    },
    20_000,
  );

  it("reads a file longer than its limit as nothing saved, and never writes one", async () => {
    const answer = gate();

    const result = await withFake((fake) =>
      Effect.gen(function* () {
        const lastLaunch = yield* savedByLastLaunch(fake);
        const disk = memoryFile(lastLaunch);

        yield* fake.handle("core/server:info", () =>
          Effect.as(Deferred.await(answer), Reply.Success({ value: SERVER_NOW })),
        );

        const platform = open(fake, { subject: ADA, file: disk.file, maxLength: 64 });

        return yield* Effect.promise(async () => {
          const info = follow(platform.core.server.info.watch());

          await pause(500);
          await letThrough(answer);
          await until(() => info.now().status === "success");
          await pause(1500);
          info.stop();
          await platform.dispose();

          return {
            savedShown: info.seen.some(
              (state) => state.status === "success" && state.saved === true,
            ),
            last: info.now(),
            text: disk.state.text,
            writes: disk.state.writes,
          };
        });
      }),
    );

    expect(result).toStrictEqual({
      savedShown: false,
      last: { status: "success", data: SERVER_NOW },
      text: null,
      writes: 0,
    });
  }, 20_000);

  it("deletes saved answers at sign-out, and a save due before it never lands after", async () => {
    const left = await withFake((fake) =>
      Effect.gen(function* () {
        const lastLaunch = yield* savedByLastLaunch(fake);
        const disk = memoryFile(lastLaunch);

        yield* fake.reply("core/server:info", Reply.Success({ value: SERVER_NOW }));
        yield* fake.reply("core/auth/sessions:revoke", Reply.Success({ value: null }));

        const platform = open(fake, { subject: ADA, file: disk.file });

        return yield* Effect.promise(async () => {
          const info = follow(platform.core.server.info.watch());

          await until(() => isLive(info.now()));
          await platform.session.signOut();
          await pause(1500);
          info.stop();
          await platform.dispose();

          return disk.state;
        });
      }),
    );

    expect(left).toMatchObject({ text: null, writes: 0 });
  }, 20_000);
});
