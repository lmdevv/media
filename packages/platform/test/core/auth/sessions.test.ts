import { ConvexHttpClient } from "convex/browser";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { importRows, newestRows } from "../../rows";
import { createPerson, refusal, signInAs, unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

/** More refresh tokens than a session gathers in its 30 days at one per 10-minute JWT. */
const PILED_UP = 5000;

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and these
// are the `_id`s the stack's authRefreshTokens rows hold; the backend's `v.id(...)` validators check
// each again whenever a test sends it back.
const isTokenId = (value: unknown): value is Id<"authRefreshTokens"> =>
  Schema.is(Schema.String)(value);

const TokenRow = Schema.fromJsonString(
  Schema.Struct({
    _id: Schema.declare(isTokenId),
    sessionId: Schema.String,
    expirationTime: Schema.Finite,
  }),
);

const tokenRowsOf = (sessionId: string, newest = PILED_UP + 1000) =>
  newestRows("authRefreshTokens", newest)
    .map((line) => Schema.decodeSync(TokenRow)(line))
    .filter((row) => row.sessionId === sessionId);

const tokensOf = (sessionId: string): number => tokenRowsOf(sessionId).length;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Adds one refresh token to `sessionId` and answers its id. */
const addToken = (
  sessionId: Id<"authSessions">,
  fields: { readonly expirationTime: number; readonly firstUsedTime?: number },
): Id<"authRefreshTokens"> => {
  const before = new Set(tokenRowsOf(sessionId, 10).map((row) => row._id));

  importRows("authRefreshTokens", [{ sessionId, ...fields }]);

  const added = tokenRowsOf(sessionId, 10).find((row) => !before.has(row._id));

  if (added === undefined) throw new Error("The imported refresh token is missing");

  return added._id;
};

/**
 * Imports refresh tokens in bulk, then lets a second pass: the backend writes at most 4 MiB a
 * second, and an import of thousands of rows spends the second the next call would land in.
 */
const pileUp = async (
  rows: ReadonlyArray<{
    readonly sessionId: Id<"authSessions">;
    readonly expirationTime: number;
    readonly firstUsedTime?: number;
    readonly parentRefreshTokenId?: Id<"authRefreshTokens">;
  }>,
): Promise<void> => {
  importRows("authRefreshTokens", rows);
  await new Promise((resolve) => setTimeout(resolve, 1500));
};

const refreshWith = (core: CoreStack, refreshToken: string) =>
  new ConvexHttpClient(core.url, { logger: false }).action(api.auth.signIn, { refreshToken });

describe.skipIf(stack === undefined)("the live-session check", { timeout: 120_000 }, () => {
  it("refuses a call with no session", async () => {
    if (stack === undefined) return;
    const anonymous = new ConvexHttpClient(stack.url, { logger: false });

    expect(await refusal(anonymous.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
  });

  it("refuses a signed-out session while its JWT is still unexpired", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));

    await signedIn.client.action(api.auth.signOut, {});

    expect(await refusal(signedIn.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
  });

  it("refuses to refresh a signed-out session", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));

    await signedIn.client.action(api.auth.signOut, {});

    const refreshed = await new ConvexHttpClient(stack.url, { logger: false }).action(
      api.auth.signIn,
      { refreshToken: signedIn.refreshToken },
    );

    expect(refreshed.tokens).toBeNull();
  });

  it("ends a session whose rotated refresh token comes back late, and revoke confirms it", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));
    const anonymous = () => new ConvexHttpClient(stack.url, { logger: false });
    const refresh = (refreshToken: string) => anonymous().action(api.auth.signIn, { refreshToken });

    const first = await refresh(signedIn.refreshToken);
    const second = await refresh(first.tokens?.refreshToken ?? "");

    await new Promise((resolve) => setTimeout(resolve, 11_000));

    const late = await refresh(signedIn.refreshToken);
    const issued = new ConvexHttpClient(stack.url, { logger: false });

    issued.setAuth(second.tokens?.token ?? "");

    expect({
      rotated: first.tokens !== null && second.tokens !== null,
      late: late.tokens,
      issued: await refusal(issued.query(api.core.auth.sessions.current, {})),
    }).toStrictEqual({ rotated: true, late: null, issued: "unauthenticated" });

    expect(
      await anonymous().mutation(api.core.auth.sessions.revoke, {
        refreshToken: signedIn.refreshToken,
      }),
    ).toStrictEqual({ confirmed: true });
    expect(await refusal(issued.query(api.core.auth.sessions.current, {}))).toBe("unauthenticated");
    expect((await refresh(second.tokens?.refreshToken ?? "")).tokens).toBeNull();
    expect(
      await anonymous().mutation(api.core.auth.sessions.revoke, {
        refreshToken: signedIn.refreshToken,
      }),
    ).toStrictEqual({ confirmed: true });
  }, 60_000);

  it("never revokes a session from a token of another session", async () => {
    if (stack === undefined) return;
    const victim = await signInAs(stack, await createPerson(stack));
    const attacker = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await victim.client.query(api.core.auth.sessions.current, {});
    const [attackerToken] = attacker.refreshToken.split("|");

    expect(
      await new ConvexHttpClient(stack.url, { logger: false }).mutation(
        api.core.auth.sessions.revoke,
        { refreshToken: `${attackerToken ?? ""}|${sessionId}` },
      ),
    ).toStrictEqual({ confirmed: true });
    expect(await victim.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      sessionId,
    });
  });

  it("refuses a session another session ended, and refuses to refresh it", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);
    const laptop = await signInAs(stack, person);
    const phone = await signInAs(stack, person);
    const { sessionId } = await laptop.client.query(api.core.auth.sessions.current, {});

    await phone.client.mutation(api.core.auth.sessions.end, { sessionId });

    expect(await refusal(laptop.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );

    const refreshed = await new ConvexHttpClient(stack.url, { logger: false }).action(
      api.auth.signIn,
      { refreshToken: laptop.refreshToken },
    );

    expect(refreshed.tokens).toBeNull();
    expect(await phone.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      username: person.username,
    });
  });

  it("ends every older session at once, and can keep the current one", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);
    const older = await signInAs(stack, person);
    const current = await signInAs(stack, person);

    await current.client.mutation(api.core.auth.sessions.endAll, { keepCurrent: true });

    expect(await refusal(older.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await current.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      username: person.username,
    });

    const next = await signInAs(stack, person);

    await current.client.mutation(api.core.auth.sessions.endAll, { keepCurrent: false });

    expect(await refusal(current.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await refusal(next.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await signInAs(stack, person)).toBeDefined();
  });

  it("deletes every refresh token of an ended session, however many it gathered", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await signedIn.client.query(api.core.auth.sessions.current, {});
    const expirationTime = Date.now() + 24 * 60 * 60 * 1000;

    importRows(
      "authRefreshTokens",
      Array.from({ length: PILED_UP }, () => ({ sessionId, expirationTime })),
    );

    expect(tokensOf(sessionId)).toBe(PILED_UP + 1);

    await signedIn.client.mutation(api.core.auth.sessions.revoke, {
      refreshToken: signedIn.refreshToken,
    });

    await expect.poll(() => tokensOf(sessionId), { timeout: 30_000, interval: 1_000 }).toBe(0);
  });

  it("signs out through auth:signOut however many refresh tokens the session gathered", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await signedIn.client.query(api.core.auth.sessions.current, {});

    await pileUp(
      Array.from({ length: PILED_UP }, () => ({ sessionId, expirationTime: Date.now() + DAY_MS })),
    );

    expect(await refusal(signedIn.client.action(api.auth.signOut, {}))).toBe("accepted");
    expect(await refusal(signedIn.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    await expect.poll(() => tokensOf(sessionId), { timeout: 30_000, interval: 1_000 }).toBe(0);
  });

  it("ends a session refreshed with an expired token, however many tokens it gathered", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await signedIn.client.query(api.core.auth.sessions.current, {});
    const expired = addToken(sessionId, { expirationTime: Date.now() - 1000 });

    await pileUp(
      Array.from({ length: PILED_UP }, () => ({ sessionId, expirationTime: Date.now() + DAY_MS })),
    );

    expect(await refreshWith(stack, `${expired}|${sessionId}`)).toEqual({ tokens: null });
    expect(await refusal(signedIn.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    await expect.poll(() => tokensOf(sessionId), { timeout: 30_000, interval: 1_000 }).toBe(0);
  });

  it("ends a session whose old refresh token comes back, however many tokens followed it", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await signedIn.client.query(api.core.auth.sessions.current, {});
    const usedAt = Date.now() - 60_000;
    const expirationTime = Date.now() + DAY_MS;
    const reused = addToken(sessionId, { expirationTime, firstUsedTime: usedAt });

    await pileUp(
      Array.from({ length: PILED_UP }, () => ({
        sessionId,
        expirationTime,
        firstUsedTime: usedAt,
        parentRefreshTokenId: reused,
      })),
    );

    expect(await refreshWith(stack, `${reused}|${sessionId}`)).toEqual({ tokens: null });
    expect(await refusal(signedIn.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect((await refreshWith(stack, signedIn.refreshToken)).tokens).toBeNull();
    await expect.poll(() => tokensOf(sessionId), { timeout: 30_000, interval: 1_000 }).toBe(0);
  });

  it("refreshes nothing and ends nothing for a token that names another session", async () => {
    if (stack === undefined) return;
    const mine = await signInAs(stack, await createPerson(stack));
    const theirs = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await theirs.client.query(api.core.auth.sessions.current, {});
    const [myToken = ""] = mine.refreshToken.split("|");

    expect(await refreshWith(stack, `${myToken}|${sessionId}`)).toEqual({ tokens: null });
    expect(await refusal(theirs.client.query(api.core.auth.sessions.current, {}))).toBe("accepted");
    expect(await refusal(mine.client.query(api.core.auth.sessions.current, {}))).toBe("accepted");
  });

  it("deletes the refresh tokens of the sessions a password change ends", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack);
    const kept = await signInAs(stack, person);
    const ended = await signInAs(stack, person);
    const { sessionId } = await ended.client.query(api.core.auth.sessions.current, {});
    const batches = 3;

    await pileUp(
      Array.from({ length: batches * 256 }, () => ({
        sessionId,
        expirationTime: Date.now() + DAY_MS,
      })),
    );

    await kept.client.action(api.core.accounts.me.changePassword, {
      currentPassword: person.password,
      newPassword: `password-${unique()}`,
    });

    await expect.poll(() => tokensOf(sessionId), { timeout: 30_000, interval: 1_000 }).toBe(0);
    expect(await refusal(kept.client.query(api.core.auth.sessions.current, {}))).toBe("accepted");
  });

  it("refuses to end another user's session", async () => {
    if (stack === undefined) return;
    const mine = await signInAs(stack, await createPerson(stack));
    const theirs = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await theirs.client.query(api.core.auth.sessions.current, {});

    expect(await refusal(mine.client.mutation(api.core.auth.sessions.end, { sessionId }))).toBe(
      "not_found",
    );
    expect(await theirs.client.query(api.core.auth.sessions.current, {})).toBeDefined();
  });
});
