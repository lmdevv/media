import { ConvexHttpClient } from "convex/browser";
import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { importRows, newestRows, newestScheduledRuns } from "../../rows";
import { createPerson, refusal, signInAs, unique } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

/** More refresh tokens than a session gathers in its 30 days at one per 10-minute JWT. */
const PILED_UP = 5000;

/** Used tokens a long branch leaves above the active token once a late retry marks it. */
const MARKED_BRANCH = 1600;

/**
 * Used tokens above the active one in the 5,000-token session. Convex Auth's own search for the
 * active token, which it repeats when the store hands it a refresh, reads each of them, and one
 * call may read 4,096.
 */
const USED_ABOVE = 3500;

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
    firstUsedTime: Schema.optionalKey(Schema.Finite),
    parentRefreshTokenId: Schema.optionalKey(Schema.String),
  }),
);

/** How long after its first use a refresh token still refreshes, in Convex Auth. */
const REUSE_WINDOW_MS = 10_000;

const ScheduledRun = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    args: Schema.Tuple([Schema.Struct({ sessionId: Schema.optionalKey(Schema.String) })]),
    state: Schema.Struct({ kind: Schema.String }),
  }),
);

/** The token deletions queued or running for `sessionId`. */
const queuedDeletions = (sessionId: string): number =>
  newestScheduledRuns(500)
    .map((line) => Schema.decodeOption(ScheduledRun)(line))
    .filter(
      (run) =>
        Option.isSome(run) &&
        run.value.name.endsWith(":endRefreshTokens") &&
        run.value.args[0].sessionId === sessionId &&
        (run.value.state.kind === "pending" || run.value.state.kind === "inProgress"),
    ).length;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const tokenRowsOf = (sessionId: string, newest = PILED_UP + 1000) =>
  newestRows("authRefreshTokens", newest)
    .map((line) => Schema.decodeSync(TokenRow)(line))
    .filter((row) => row.sessionId === sessionId);

const tokensOf = (sessionId: string): number => tokenRowsOf(sessionId).length;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Adds one refresh token to `sessionId` and answers its id. */
const addToken = (
  sessionId: Id<"authSessions">,
  fields: {
    readonly expirationTime: number;
    readonly firstUsedTime?: number;
    readonly parentRefreshTokenId?: Id<"authRefreshTokens">;
  },
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
  await pause(1500);
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

  it("revokes a session from a refresh token that was rotated and invalidated since", async () => {
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
    const stillLive = await issued.query(api.core.auth.sessions.current, {});

    expect({
      rotated: first.tokens !== null && second.tokens !== null,
      late: late.tokens,
      stillLive: stillLive.sessionId.length > 0,
    }).toStrictEqual({ rotated: true, late: null, stillLive: true });

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

  it("marks every token after a reused one used, however many, and keeps the session", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await signedIn.client.query(api.core.auth.sessions.current, {});
    const expirationTime = Date.now() + DAY_MS;

    const reused = addToken(sessionId, {
      expirationTime,
      firstUsedTime: Date.now() - 6 * REUSE_WINDOW_MS,
    });

    await pileUp(
      Array.from({ length: PILED_UP }, () => ({
        sessionId,
        expirationTime,
        parentRefreshTokenId: reused,
      })),
    );

    const active = addToken(sessionId, { expirationTime });

    const stillRefreshing = (): number =>
      tokenRowsOf(sessionId).filter(
        (row) =>
          row.parentRefreshTokenId === reused &&
          (row.firstUsedTime === undefined || row.firstUsedTime > Date.now() - REUSE_WINDOW_MS),
      ).length;

    expect(stillRefreshing()).toBe(PILED_UP);
    expect(await refreshWith(stack, `${reused}|${sessionId}`)).toEqual({ tokens: null });
    await expect.poll(stillRefreshing, { timeout: 60_000, interval: 1_000 }).toBe(0);
    expect(await refusal(signedIn.client.query(api.core.auth.sessions.current, {}))).toBe(
      "accepted",
    );
    expect((await refreshWith(stack, `${active}|${sessionId}`)).tokens).not.toBeNull();
  });

  it("invalidates only a late retry's branch, so a client on another branch stays signed in", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));
    const r0 = signedIn.refreshToken;

    const tokensFrom = async (refreshToken: string) =>
      (await refreshWith(stack, refreshToken)).tokens;

    const r1 = (await tokensFrom(r0))?.refreshToken ?? "";
    const r2 = (await tokensFrom(r1))?.refreshToken ?? "";
    const r3 = await tokensFrom(r0);

    expect([r1, r2, r3?.refreshToken].every((token) => token !== undefined && token !== "")).toBe(
      true,
    );

    await pause(REUSE_WINDOW_MS + 1000);

    expect(await tokensFrom(r1)).toBeNull();
    expect(await tokensFrom(r3?.refreshToken ?? "")).not.toBeNull();
    expect(await tokensFrom(r2)).toBeNull();

    const onBranch = new ConvexHttpClient(stack.url, { logger: false });

    onBranch.setAuth(r3?.token ?? "");

    expect(await refusal(onBranch.query(api.core.auth.sessions.current, {}))).toBe("accepted");
  }, 60_000);

  it("hands a late retry the child it lost, however many newer tokens a reuse invalidated", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));
    const r0 = signedIn.refreshToken;

    const tokensFrom = async (refreshToken: string) =>
      (await refreshWith(stack, refreshToken)).tokens;

    const rotate = async (refreshToken: string, times: number): Promise<string> =>
      times === 0
        ? refreshToken
        : rotate((await tokensFrom(refreshToken))?.refreshToken ?? "", times - 1);

    const r1 = (await tokensFrom(r0))?.refreshToken ?? "";
    const r2 = (await tokensFrom(r1))?.refreshToken ?? "";
    const r3 = (await tokensFrom(r0))?.refreshToken ?? "";
    const head = await rotate(r3, 64);

    expect([r1, r2, r3, head].every((token) => token !== "")).toBe(true);

    await pause(REUSE_WINDOW_MS + 1000);

    expect(await tokensFrom(r3)).toBeNull();
    expect((await tokensFrom(r1))?.refreshToken).toBe(r2);
  }, 90_000);

  it("hands an in-window retry its active child, however many newer tokens a reuse invalidated", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));
    const r0 = signedIn.refreshToken;

    const tokensFrom = async (refreshToken: string) =>
      (await refreshWith(stack, refreshToken)).tokens;

    const rotate = async (refreshToken: string, times: number): Promise<string> =>
      times === 0
        ? refreshToken
        : rotate((await tokensFrom(refreshToken))?.refreshToken ?? "", times - 1);

    const r1 = (await tokensFrom(r0))?.refreshToken ?? "";
    const r2 = (await tokensFrom(r1))?.refreshToken ?? "";
    const branch = (await tokensFrom(r0))?.refreshToken ?? "";
    const head = (await tokensFrom(branch))?.refreshToken ?? "";

    await pause(REUSE_WINDOW_MS + 1000);

    const r2UsedAt = Date.now();
    const sibling = (await tokensFrom(r2))?.refreshToken ?? "";

    expect(await rotate(head, 64)).not.toBe("");
    expect(await tokensFrom(branch)).toBeNull();
    expect(Date.now() - r2UsedAt).toBeLessThan(REUSE_WINDOW_MS - 1000);
    expect((await tokensFrom(r2))?.refreshToken).toBe(sibling);
  }, 90_000);

  it("answers every retry as the library does in a session of 5,000 tokens", async () => {
    if (stack === undefined) return;
    const late = await signInAs(stack, await createPerson(stack));
    const inWindow = await signInAs(stack, await createPerson(stack));
    const { sessionId: lateSession } = await late.client.query(api.core.auth.sessions.current, {});

    const { sessionId: windowSession } = await inWindow.client.query(
      api.core.auth.sessions.current,
      {},
    );

    const expirationTime = Date.now() + DAY_MS;
    const longAgo = Date.now() - 6 * REUSE_WINDOW_MS;

    const used = (sessionId: Id<"authSessions">, count: number) =>
      pileUp(
        Array.from({ length: count }, () => ({
          sessionId,
          expirationTime,
          firstUsedTime: longAgo,
        })),
      );

    await used(lateSession, PILED_UP - USED_ABOVE);

    const lostChildOf = addToken(lateSession, { expirationTime, firstUsedTime: longAgo });
    const childless = addToken(lateSession, { expirationTime, firstUsedTime: longAgo });

    const lostChild = addToken(lateSession, { expirationTime, parentRefreshTokenId: lostChildOf });

    await used(lateSession, USED_ABOVE);
    await used(windowSession, USED_ABOVE);

    expect(await refreshWith(stack, `${childless}|${lateSession}`)).toEqual({ tokens: null });

    expect((await refreshWith(stack, `${lostChildOf}|${lateSession}`)).tokens?.refreshToken).toBe(
      `${lostChild}|${lateSession}`,
    );

    const justUsed = addToken(windowSession, { expirationTime, firstUsedTime: Date.now() });

    expect((await refreshWith(stack, `${justUsed}|${windowSession}`)).tokens).not.toBeNull();

    expect(
      await Promise.all(
        [late, inWindow].map((signedIn) =>
          refusal(signedIn.client.query(api.core.auth.sessions.current, {})),
        ),
      ),
    ).toEqual(["accepted", "accepted"]);
  }, 120_000);

  it("hands a late retry its active child under a long invalidated branch", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await signedIn.client.query(api.core.auth.sessions.current, {});
    const expirationTime = Date.now() + DAY_MS;
    const longAgo = Date.now() - 6 * REUSE_WINDOW_MS;
    const replayed = addToken(sessionId, { expirationTime, firstUsedTime: longAgo });
    const active = addToken(sessionId, { expirationTime, parentRefreshTokenId: replayed });
    const invalidatedRoot = addToken(sessionId, { expirationTime, firstUsedTime: longAgo });

    await pileUp(
      Array.from({ length: MARKED_BRANCH }, () => ({
        sessionId,
        expirationTime,
        firstUsedTime: longAgo,
        parentRefreshTokenId: invalidatedRoot,
      })),
    );

    expect((await refreshWith(stack, `${replayed}|${sessionId}`)).tokens?.refreshToken).toBe(
      `${active}|${sessionId}`,
    );
  });

  it("refuses a late retry whose unused child is not the active token, however deep it lies", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await signedIn.client.query(api.core.auth.sessions.current, {});
    const expirationTime = Date.now() + DAY_MS;
    const longAgo = Date.now() - 6 * REUSE_WINDOW_MS;
    const replayed = addToken(sessionId, { expirationTime, firstUsedTime: longAgo });
    const olderChild = addToken(sessionId, { expirationTime, parentRefreshTokenId: replayed });
    const otherBranch = addToken(sessionId, { expirationTime, firstUsedTime: longAgo });
    const active = addToken(sessionId, { expirationTime, parentRefreshTokenId: otherBranch });

    await pileUp(
      Array.from({ length: MARKED_BRANCH }, () => ({
        sessionId,
        expirationTime,
        firstUsedTime: longAgo,
      })),
    );

    expect(await refreshWith(stack, `${replayed}|${sessionId}`)).toEqual({ tokens: null });
    expect(await refreshWith(stack, `${olderChild}|${sessionId}`)).toEqual({ tokens: null });
    expect((await refreshWith(stack, `${active}|${sessionId}`)).tokens).not.toBeNull();
  });

  it("refuses a late retry whose children are all used, however many it had", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await signedIn.client.query(api.core.auth.sessions.current, {});
    const expirationTime = Date.now() + DAY_MS;
    const longAgo = Date.now() - 6 * REUSE_WINDOW_MS;
    const replayed = addToken(sessionId, { expirationTime, firstUsedTime: longAgo });

    await pileUp(
      Array.from({ length: 66 }, () => ({
        sessionId,
        expirationTime,
        firstUsedTime: longAgo,
        parentRefreshTokenId: replayed,
      })),
    );

    await pileUp(
      Array.from({ length: MARKED_BRANCH }, () => ({
        sessionId,
        expirationTime,
        firstUsedTime: longAgo,
      })),
    );

    expect(await refreshWith(stack, `${replayed}|${sessionId}`)).toEqual({ tokens: null });
    expect(await refusal(signedIn.client.query(api.core.auth.sessions.current, {}))).toBe(
      "accepted",
    );
  });

  it("deletes an ended session's tokens in one chain, however often its expired token returns", async () => {
    if (stack === undefined) return;
    const signedIn = await signInAs(stack, await createPerson(stack));
    const { sessionId } = await signedIn.client.query(api.core.auth.sessions.current, {});
    const many = 12_000;

    await pileUp(
      Array.from({ length: many }, () => ({ sessionId, expirationTime: Date.now() + DAY_MS })),
    );

    const expired = addToken(sessionId, { expirationTime: Date.now() - 1000 });

    expect(await refreshWith(stack, `${expired}|${sessionId}`)).toEqual({ tokens: null });
    expect(await refreshWith(stack, `${expired}|${sessionId}`)).toEqual({ tokens: null });

    const seen: Array<number> = [];

    await expect
      .poll(
        () => {
          const queued = queuedDeletions(sessionId);

          seen.push(queued);

          return queued;
        },
        { timeout: 60_000, interval: 200 },
      )
      .toBe(0);

    expect(Math.max(...seen)).toBe(1);
  }, 120_000);

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
