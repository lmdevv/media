import { Schema } from "effect";
import { Scrypt } from "lucia";
import { describe, expect, it } from "vitest";

import { roleScopes } from "../../../commands/scopes";
import { api, internal } from "../../../convex/_generated/api";
import { runFunction } from "../../admin";
import { createPerson, refusal, signIn, signInAs, unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";

const stack = coreStackFromEnvFile();

const claimsOf = (token: string): { readonly iat: number; readonly exp: number } => {
  const payload = token.split(".")[1] ?? "";

  return Schema.decodeUnknownSync(Schema.Struct({ iat: Schema.Finite, exp: Schema.Finite }))(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  );
};

const inSequence = <T>(count: number, task: () => Promise<T>): Promise<ReadonlyArray<T>> =>
  Array.from({ length: count }).reduce<Promise<ReadonlyArray<T>>>(
    async (earlier) => [...(await earlier), await task()],
    Promise.resolve([]),
  );

describe.skipIf(stack === undefined)("password sign-in", { timeout: 120_000 }, () => {
  it("signs a user in with any case of the username, as the same user", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack, "Case");

    const callers = await Promise.all(
      [person.username, person.username.toLowerCase(), person.username.toUpperCase()].map(
        async (username) => {
          const signedIn = await signIn(stack, "password", { username, password: person.password });

          return signedIn.client.query(api.core.auth.sessions.current, {});
        },
      ),
    );

    expect(new Set(callers.map((caller) => caller.userId)).size).toBe(1);
    expect(callers[0]).toMatchObject({
      username: person.username,
      role: "member",
      kind: "password",
      scopes: roleScopes.member,
      device: null,
    });
    expect(Object.keys(callers[0] ?? {}).toSorted()).toEqual([
      "device",
      "kind",
      "role",
      "scopes",
      "sessionId",
      "userId",
      "username",
    ]);
  });

  it("issues JWTs that last ten minutes", async () => {
    if (stack === undefined) return;
    const { token } = await signInAs(stack, await createPerson(stack));
    const claims = claimsOf(token);

    expect(claims.exp - claims.iat).toBe(600);
  });

  it("answers a wrong password and an unknown username alike", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);

    expect(
      await refusal(
        signIn(stack, "password", { username: person.username, password: "wrong-password" }),
      ),
    ).toBe("unauthenticated");

    expect(
      await refusal(
        signIn(stack, "password", { username: `${person.username}x`, password: "anything" }),
      ),
    ).toBe("unauthenticated");

    // Malformed params fail the core's argument check, which the boundary relays as `internal`.
    expect(await refusal(signIn(stack, "password", { username: person.username }))).toBe(
      "internal",
    );
  });

  it("limits a username to ten wrong tries an hour, known or not", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);

    const wrongTries = (username: string) =>
      inSequence(11, () =>
        refusal(signIn(stack, "password", { username, password: "wrong-password" })),
      );

    const tenWrongThenLimited = [
      ...Array.from({ length: 10 }, () => "unauthenticated"),
      "rate_limited",
    ];

    expect(await wrongTries(person.username)).toEqual(tenWrongThenLimited);
    expect(await refusal(signInAs(stack, person))).toBe("rate_limited");
    expect(await wrongTries(`nobody-${person.username}`)).toEqual(tenWrongThenLimited);
  });

  it("lets no more than ten wrong tries through when they all arrive at once", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);

    const tries = await Promise.all(
      Array.from({ length: 20 }, () =>
        refusal(
          signIn(stack, "password", { username: person.username, password: "wrong-password" }),
        ),
      ),
    );

    // Twenty writers on one bucket row can exhaust Convex's retries, which refuses that try with a
    // server error instead of `rate_limited`; either way it never reaches the password check.
    expect(tries.filter((code) => code === "unauthenticated")).toHaveLength(10);
    expect(tries.filter((code) => code === "accepted")).toHaveLength(0);
  });

  it("takes a password set when the rule counted UTF-16 units, to sign in and to change it", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);
    const password = "\uFB03".repeat(100);

    await runFunction(
      stack,
      internal.core.accounts.host.storeReset,
      { username: person.username, hash: await new Scrypt().hash(password) },
      Schema.Struct({ username: Schema.String }),
    );

    const signedIn = await signInAs(stack, { ...person, password });

    expect(
      await refusal(
        signedIn.client.action(api.core.accounts.me.changePassword, {
          currentPassword: password,
          newPassword: `password-${unique()}`,
        }),
      ),
    ).toBe("accepted");
  });

  it("gives back the try a successful sign-in took", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);

    await inSequence(12, () => signInAs(stack, person));

    expect(
      await refusal(
        signIn(stack, "password", { username: person.username, password: "wrong-password" }),
      ),
    ).toBe("unauthenticated");
  });
});
