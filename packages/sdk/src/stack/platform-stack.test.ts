import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "vitest";

import * as Platform from "../platform/platform";
import { createPlatform } from "../platform/promise";
import { createPlatformPerson, newPlatformPerson, stackSignIn } from "../testing/platform-people";
import { ownClientFetch } from "../testing/own-client";
import type { PlatformPerson } from "../testing/platform-people";
import { findPlatformStack } from "../testing/stack-env";
import * as TokenStorage from "../token-storage";
import type { KeyValueStore } from "../token-storage";

const stack = findPlatformStack();

const url = stack?.url ?? "";

const stackOrEmpty = stack ?? { url, adminKey: "", signInUrl: "" };

/** The Promise entry's sign-in options: the stack's boundary, as a client of its own. */
const signInOptions = () => ({ signInUrl: stackOrEmpty.signInUrl, signInFetch: ownClientFetch() });

const KEY = "media.session";

const RENEWAL_LEAD_MS = 30_000;

const decodeClaims = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ exp: Schema.Finite })),
);

const expiresAt = (token: string): number =>
  decodeClaims(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()).exp * 1000;

const memoryStore = () => {
  const items = new Map<string, string>();

  const store: KeyValueStore = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
  };

  const stored = () =>
    Option.flatMap(Option.fromNullishOr(items.get(KEY)), TokenStorage.parseStoredSession);

  /** The stored refresh token, which Convex Auth replaces on every renewal. */
  const refreshToken = (): string | null =>
    Option.match(stored(), {
      onNone: () => null,
      onSome: (session) => Redacted.value(session.refreshToken),
    });

  const token = (): string =>
    Option.match(stored(), {
      onNone: () => "",
      onSome: (session) => Redacted.value(session.token),
    });

  return { store, refreshToken, token };
};

const open = (store: KeyValueStore = memoryStore().store) =>
  Effect.map(
    Layer.build(
      Platform.layer({
        url,
        connection: "http",
        storage: TokenStorage.layerKeyValue(store, KEY),
        signIn: stackSignIn(stackOrEmpty),
      }),
    ),
    (context) => Context.get(context, Platform.Platform),
  );

const signedInAs = (person: PlatformPerson) =>
  Effect.gen(function* () {
    const platform = yield* open();

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

describe.skipIf(stack === undefined)("the platform SDK on the stack", { timeout: 60_000 }, () => {
  it("tells a Node script the server's name through the Promise entry", async () => {
    const platform = createPlatform({ url, connection: "http", ...signInOptions() });

    try {
      expect(await platform.core.server.info()).toMatchObject({ name: "[media]" });
    } finally {
      await platform.dispose();
    }
  });

  it("sets up the server's owner only while it has none", async () => {
    const answer = await scoped(
      Effect.gen(function* () {
        const accepted = yield* Effect.forEach(
          ["first", "second", "third"],
          (label) =>
            Effect.gen(function* () {
              const racer = yield* open();
              const owner = newPlatformPerson(`sdk-owner-${label}`);

              yield* racer.session.signIn(
                Platform.Credentials.Setup({
                  username: owner.username,
                  password: Redacted.make(owner.password),
                }),
              );

              return [(yield* racer.core.auth.sessions.current()).role];
            }).pipe(Effect.catchTag("Conflict", () => Effect.succeed([]))),
          { concurrency: "unbounded" },
        );

        const late = yield* open();
        const lateOwner = newPlatformPerson("sdk-owner-late");

        return {
          accepted: accepted.flat(),
          hasOwner: (yield* late.core.server.info()).hasOwner,
          late: yield* Effect.flip(
            late.session.signIn(
              Platform.Credentials.Setup({
                username: lateOwner.username,
                password: Redacted.make(lateOwner.password),
              }),
            ),
          ),
          lateStatus: yield* late.session.currentStatus,
        };
      }),
    );

    expect([[], ["owner"]]).toContainEqual(answer.accepted);
    expect(answer).toMatchObject({
      hasOwner: true,
      late: { _tag: "Conflict" },
      lateStatus: "signedOut",
    });
  });

  it("signs a newcomer in from an admin's invite, once", async () => {
    const admin = await createPlatformPerson(stackOrEmpty, "sdk-admin", "admin");

    const newcomer = newPlatformPerson("sdk-invited");

    const invite = await scoped(
      Effect.flatMap(signedInAs(admin), (platform) =>
        platform.core.accounts.invites.create({ role: "member" }),
      ),
    );

    const platform = createPlatform({ url, connection: "http", ...signInOptions() });

    try {
      await platform.session.acceptInvite({ code: invite.code, ...newcomer });

      expect(await platform.core.auth.sessions.current()).toMatchObject({
        username: newcomer.username,
        role: "member",
        kind: "password",
      });
    } finally {
      await platform.dispose();
    }

    const second = newPlatformPerson("sdk-invited-again");

    const reused = await scoped(
      Effect.flatMap(open(), (again) =>
        Effect.flip(
          again.session.signIn(
            Platform.Credentials.Invite({
              code: Redacted.make(invite.code),
              username: second.username,
              password: Redacted.make(second.password),
            }),
          ),
        ),
      ),
    );

    expect(reused).toMatchObject({ _tag: "Expired" });
  });

  it("sets a new password from a reset link and ends the old sessions", async () => {
    const admin = await createPlatformPerson(stackOrEmpty, "sdk-admin", "admin");

    const person = await createPlatformPerson(stackOrEmpty, "sdk-reset");

    const { password: newPassword } = newPlatformPerson("sdk-reset");

    const answer = await scoped(
      Effect.gen(function* () {
        const before = yield* signedInAs(person);
        const { userId } = yield* before.core.auth.sessions.current();
        const helper = yield* signedInAs(admin);
        const link = yield* helper.core.accounts.resetLinks.create({ userId });
        const after = yield* open();

        yield* after.session.signIn(
          Platform.Credentials.Reset({
            code: Redacted.make(link.code),
            password: Redacted.make(newPassword),
          }),
        );

        const oldPassword = yield* open();

        return {
          me: yield* after.core.auth.sessions.current(),
          oldSession: yield* Effect.flip(before.core.auth.sessions.current()),
          oldPassword: yield* Effect.flip(
            oldPassword.session.signIn(
              Platform.Credentials.Password({
                username: person.username,
                password: Redacted.make(person.password),
              }),
            ),
          ),
        };
      }),
    );

    expect(answer).toMatchObject({
      me: { username: person.username, kind: "password" },
      oldSession: { _tag: "Unauthenticated" },
      oldPassword: { _tag: "Unauthenticated" },
    });
  });

  it("signs in with a password, calls a scoped command, and signs out", async () => {
    const person = await createPlatformPerson(stackOrEmpty, "sdk");

    const answer = await scoped(
      Effect.gen(function* () {
        const platform = yield* signedInAs(person);
        const info = yield* platform.core.server.info();
        const me = yield* platform.core.auth.sessions.current();

        yield* platform.session.signOut;

        return {
          info,
          me: { username: me.username, kind: me.kind, scopes: me.scopes },
          status: yield* platform.session.currentStatus,
          afterSignOut: yield* Effect.flip(platform.core.auth.sessions.current()),
          infoAfterSignOut: yield* platform.core.server.info(),
        };
      }),
    );

    expect(answer).toMatchObject({
      info: { name: "[media]" },
      me: {
        username: person.username,
        kind: "password",
        scopes: [
          "account",
          "movies:read",
          "movies:play",
          "movies:edit",
          "music:read",
          "music:play",
          "music:edit",
        ],
      },
      status: "signedOut",
      afterSignOut: { _tag: "Unauthenticated" },
      infoAfterSignOut: { name: "[media]" },
    });
  });

  it("renews a token about to expire and keeps the same session", async () => {
    const person = await createPlatformPerson(stackOrEmpty, "sdk-refresh");

    const memory = memoryStore();

    const answer = await scoped(
      Effect.gen(function* () {
        const clock = yield* Layer.build(TestClock.layer());

        return yield* Effect.gen(function* () {
          yield* TestClock.setTime(Date.now());
          const platform = yield* open(memory.store);

          yield* platform.session.signIn(
            Platform.Credentials.Password({
              username: person.username,
              password: Redacted.make(person.password),
            }),
          );

          const before = yield* platform.core.auth.sessions.current();
          const signedIn = memory.refreshToken();

          yield* TestClock.setTime(expiresAt(memory.token()) - RENEWAL_LEAD_MS);

          const after = yield* platform.core.auth.sessions.current();

          return {
            renewed: memory.refreshToken() !== signedIn && memory.refreshToken() !== null,
            sameSession: after.sessionId === before.sessionId,
          };
        }).pipe(Effect.provideContext(clock));
      }),
    );

    expect(answer).toStrictEqual({ renewed: true, sameSession: true });
  });

  it("refuses a command the session lacks the scope for with Forbidden", async () => {
    const person = await createPlatformPerson(stackOrEmpty, "sdk-scope");

    const answer = await scoped(
      Effect.gen(function* () {
        const owner = yield* signedInAs(person);
        const own = yield* owner.core.auth.sessions.current();

        const created = yield* owner.core.auth.apiKeys.create({
          name: "no scopes",
          scopes: [],
        });

        const keyed = yield* open();

        yield* keyed.session.signIn(
          Platform.Credentials.ApiKey({ key: Redacted.make(created.key) }),
        );

        return {
          current: (yield* keyed.core.auth.sessions.current()).scopes,
          refused: yield* Effect.flip(keyed.core.auth.sessions.end({ sessionId: own.sessionId })),
        };
      }),
    );

    expect(answer).toMatchObject({
      current: [],
      refused: { _tag: "Forbidden", message: "This session lacks the account scope" },
    });
  });

  it("refuses a session that was ended elsewhere with Unauthenticated", async () => {
    const person = await createPlatformPerson(stackOrEmpty, "sdk-ended");

    const refused = await scoped(
      Effect.gen(function* () {
        const laptop = yield* signedInAs(person);
        const phone = yield* signedInAs(person);
        const phoneSession = yield* phone.core.auth.sessions.current();

        yield* laptop.core.auth.sessions.end({ sessionId: phoneSession.sessionId });

        return yield* Effect.flip(phone.core.auth.sessions.current());
      }),
    );

    expect(refused).toMatchObject({ _tag: "Unauthenticated" });
  });

  it("signs a device in once a signed-in session approves its code", async () => {
    const person = await createPlatformPerson(stackOrEmpty, "sdk-device");

    const answer = await scoped(
      Effect.gen(function* () {
        const approver = yield* signedInAs(person);
        const device = yield* open();
        const pending = yield* device.session.startDeviceSignIn("SDK stack test");

        yield* approver.core.auth.deviceCodes.approve({
          userCode: pending.userCode,
          scopes: ["account"],
        });
        yield* pending.complete;

        return yield* device.core.auth.sessions.current();
      }),
    );

    expect(answer).toMatchObject({ username: person.username, kind: "deviceCode" });
  });

  it("opens a person's tile on a shared device with their password", async () => {
    const admin = await createPlatformPerson(stackOrEmpty, "sdk-tv-admin", "admin");

    const person = await createPlatformPerson(stackOrEmpty, "sdk-tile");

    const answer = await scoped(
      Effect.gen(function* () {
        const host = yield* signedInAs(admin);
        const viewer = yield* signedInAs(person);
        const tv = yield* host.core.devices.registry.enroll({ name: "Living room TV" });
        const { userId } = yield* viewer.core.auth.sessions.current();

        yield* viewer.core.devices.tiles.setListed({ userId, listed: true });
        yield* host.core.devices.registry.setMode({ deviceId: tv.deviceId, mode: "shared" });

        const shared = yield* open();

        yield* shared.session.signIn(
          Platform.Credentials.Tile({
            device: Redacted.make(tv.device),
            userId,
            proof: Option.some(
              Platform.TileProof.Password({ by: userId, password: Redacted.make(person.password) }),
            ),
          }),
        );

        return yield* shared.core.auth.sessions.current();
      }),
    );

    expect(answer).toMatchObject({ username: person.username, kind: "tile" });
  });

  it("exchanges a phone's grant for each app's own session until the grant is revoked", async () => {
    const person = await createPlatformPerson(stackOrEmpty, "sdk-grant");

    const answer = await scoped(
      Effect.gen(function* () {
        const movies = yield* signedInAs(person);
        const { userId } = yield* movies.core.auth.sessions.current();
        const first = yield* movies.core.devices.registry.enroll({ name: "Movies on iPhone" });
        const issued = yield* movies.core.devices.deviceGrants.issue({ name: "iPhone" });

        const music = yield* open();

        yield* music.session.signIn(
          Platform.Credentials.Grant({ userId, grant: Redacted.make(issued.grant) }),
        );

        const second = yield* music.core.devices.registry.enroll({ name: "Music on iPhone" });
        const exchanged = yield* music.core.auth.sessions.current();

        yield* movies.core.devices.deviceGrants.revoke({ grantId: issued.grantId });

        return {
          userId,
          grant: issued.grant,
          devices: [first.deviceId, second.deviceId],
          exchanged,
          afterRevoke: yield* Effect.flip(music.core.auth.sessions.current()),
          issuerAfterRevoke: yield* Effect.flip(movies.core.auth.sessions.current()),
        };
      }),
    );

    expect(answer.exchanged).toMatchObject({ username: person.username, kind: "grant" });
    expect(answer.exchanged.device?.deviceId).toBe(answer.devices[1]);
    expect(new Set(answer.devices).size).toBe(2);
    expect(answer.afterRevoke).toMatchObject({ _tag: "Unauthenticated" });
    expect(answer.issuerAfterRevoke).toMatchObject({ _tag: "Unauthenticated" });

    const platform = createPlatform({ url, connection: "http", ...signInOptions() });

    try {
      await expect(
        platform.session.exchangeGrant({ userId: answer.userId, grant: answer.grant }),
      ).rejects.toMatchObject({ _tag: "Unauthenticated" });
      expect(await platform.session.status()).toBe("signedOut");
    } finally {
      await platform.dispose();
    }
  });
});
