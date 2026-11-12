import { ConvexHttpClient } from "convex/browser";
import type { FunctionReturnType } from "convex/server";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { PAGE_ROWS_MAX } from "../../../convex/core/lib/paginate";
import { logMark, usageSince } from "../../admin";
import { enroll, member } from "../../devices";
import type { Member } from "../../devices";
import { allPages, counted } from "../../pages";
import type { PageLoader } from "../../pages";
import { createPerson, failureOf, refusal, signIn, signInAs } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

type SessionRow = FunctionReturnType<typeof api.core.auth.sessions.list>["page"][number];

type KeyRow = FunctionReturnType<typeof api.core.auth.apiKeys.list>["page"][number];

const sessionPages =
  (signedIn: SignedIn): PageLoader<SessionRow> =>
  async (paginationOpts) =>
    signedIn.client.query(api.core.auth.sessions.list, { paginationOpts });

const keyPages =
  (signedIn: SignedIn): PageLoader<KeyRow> =>
  async (paginationOpts) =>
    signedIn.client.query(api.core.auth.apiKeys.list, { paginationOpts });

const everyRow = async <T>(load: PageLoader<T>, numItems = 50): Promise<ReadonlyArray<T>> =>
  (await allPages(load, numItems)).flatMap((page) => page.page);

const sessionsOf = (signedIn: SignedIn) => everyRow(sessionPages(signedIn));

const keysOf = (signedIn: SignedIn) => everyRow(keyPages(signedIn));

const current = (signedIn: SignedIn) => signedIn.client.query(api.core.auth.sessions.current, {});

/** A TV signed in with a device code `who` approved. */
const tv = async (core: CoreStack, who: SignedIn): Promise<SignedIn> => {
  const started = await new ConvexHttpClient(core.url, { logger: false }).action(
    api.core.auth.deviceCodes.start,
    { clientName: "Living room TV" },
  );

  await who.client.mutation(api.core.auth.deviceCodes.approve, {
    userCode: started.userCode,
    scopes: ["movies:read", "movies:play"],
  });

  return signIn(core, "deviceCode", { deviceCode: started.deviceCode });
};

/** A person on a phone: the movies app's password session, its device, and the phone's grant. */
const phone = async (core: CoreStack, label: string) => {
  const who = await member(core, label);
  const movies = await enroll(who.signedIn, "Movies on phone");

  const issued = await who.signedIn.client.action(api.core.devices.deviceGrants.issue, {
    name: `${label}'s phone`,
  });

  return { who, movies, issued };
};

/** Runs `make` `count` times, `width` at a time, and answers what each made in order. */
const inBatches = async <T>(
  count: number,
  width: number,
  make: (index: number) => Promise<T>,
): Promise<ReadonlyArray<T>> => {
  const starts = Array.from({ length: Math.ceil(count / width) }, (_, n) => n * width);

  return starts.reduce<Promise<ReadonlyArray<T>>>(async (earlier, start) => {
    const made = await earlier;
    const batch = Array.from({ length: Math.min(width, count - start) }, (_, n) => start + n);

    return [...made, ...(await Promise.all(batch.map(make)))];
  }, Promise.resolve([]));
};

/** Key sign-ins enough that the list runs past what one page of sessions reads. */
const KEY_SIGN_INS_PAST_A_PAGE = 340;

const makeKey = (who: Member, name: string) =>
  who.signedIn.client.action(api.core.auth.apiKeys.create, { name, scopes: ["movies:read"] });

describe.skipIf(stack === undefined)("a person's own sessions", { timeout: 300_000 }, () => {
  it("lists each live browser, app, device, and key sign-in newest first, naming each", async () => {
    if (stack === undefined) return;
    const { who, movies, issued } = await phone(stack, "aiko");
    const music = await signIn(stack, "grant", { userId: who.userId, grant: issued.grant });
    const musicDevice = await enroll(music, "Music on phone");
    const laptop = await signInAs(stack, who.person);
    const television = await tv(stack, laptop);

    const { key } = await laptop.client.action(api.core.auth.apiKeys.create, {
      name: "script",
      scopes: ["movies:read"],
    });

    const script = await signIn(stack, "apiKey", { key });
    const listed = await sessionsOf(laptop);

    expect(listed.map((row) => [row.kind, row.name, row.device?.deviceId ?? null])).toEqual([
      ["apiKey", "script", null],
      ["deviceCode", "Living room TV", null],
      ["password", null, null],
      ["grant", "Music on phone", musicDevice.deviceId],
      ["password", "Movies on phone", movies.deviceId],
    ]);
    expect(listed.map((row) => row.current)).toEqual([false, false, true, false, false]);
    expect(listed.map((row) => row.sessionId)).toEqual([
      (await current(script)).sessionId,
      (await current(television)).sessionId,
      (await current(laptop)).sessionId,
      (await current(music)).sessionId,
      (await current(who.signedIn)).sessionId,
    ]);
    expect(listed[0]?.scopes).toEqual(["movies:read"]);
    expect(listed[1]?.scopes).toEqual(["movies:read", "movies:play"]);
    expect(listed[2]?.scopes).toContain("account");

    for (const row of listed) {
      expect(row.expiresAt).toBeGreaterThan(row.signedInAt);
    }
  });

  it("signs one out, so that app alone asks again while the grant and the other apps stay", async () => {
    if (stack === undefined) return;
    const { who, issued } = await phone(stack, "ends");
    const music = await signIn(stack, "grant", { userId: who.userId, grant: issued.grant });

    await enroll(music, "Music on phone");

    const laptop = await signInAs(stack, who.person);
    const movies = (await sessionsOf(laptop)).find((row) => row.name === "Movies on phone");

    if (movies === undefined) throw new Error("The movies app is not listed");

    await laptop.client.mutation(api.core.auth.sessions.end, { sessionId: movies.sessionId });

    expect(await refusal(current(who.signedIn))).toBe("unauthenticated");
    expect(await refusal(current(music))).toBe("accepted");
    expect(await refusal(current(laptop))).toBe("accepted");
    expect((await sessionsOf(laptop)).map((row) => row.name)).toEqual([null, "Music on phone"]);

    const [grant] = (
      await laptop.client.query(api.core.devices.deviceGrants.list, {
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).page;

    expect(grant).toMatchObject({ grantId: issued.grantId, signsIn: true });
    expect(
      await refusal(
        laptop.client.mutation(api.core.auth.sessions.end, { sessionId: movies.sessionId }),
      ),
    ).toBe("not_found");
  });

  it("signs one key's sign-in out alone, and the key signs in again on its next use", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "keyed");

    const { key } = await aiko.signedIn.client.action(api.core.auth.apiKeys.create, {
      name: "script",
      scopes: ["movies:read"],
    });

    const first = await signIn(stack, "apiKey", { key });
    const second = await signIn(stack, "apiKey", { key });
    const { sessionId } = await current(first);

    await aiko.signedIn.client.mutation(api.core.auth.sessions.end, { sessionId });

    expect(await refusal(current(first))).toBe("unauthenticated");
    expect(await refusal(current(second))).toBe("accepted");
    expect(await refusal(current(await signIn(stack, "apiKey", { key })))).toBe("accepted");
    expect((await sessionsOf(aiko.signedIn)).map((row) => row.sessionId)).not.toContain(sessionId);
  });

  it("lets nobody else list or end them, admins included", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const bo = await member(stack, "bo");
    const admin = await member(stack, "admin", "admin");
    const [mine] = await sessionsOf(aiko.signedIn);

    if (mine === undefined) throw new Error("Aiko has no session");

    expect((await sessionsOf(bo.signedIn)).map((row) => row.sessionId)).not.toContain(
      mine.sessionId,
    );

    const answers = await Promise.all(
      [bo, admin].map(async (other) =>
        refusal(
          other.signedIn.client.mutation(api.core.auth.sessions.end, {
            sessionId: mine.sessionId,
          }),
        ),
      ),
    );

    expect(answers).toEqual(["not_found", "not_found"]);

    expect(await refusal(current(aiko.signedIn))).toBe("accepted");
  });

  it("needs the account scope: a TV's session and a key without it are refused", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const television = await tv(stack, aiko.signedIn);

    const { key } = await aiko.signedIn.client.action(api.core.auth.apiKeys.create, {
      name: "reader",
      scopes: ["movies:read"],
    });

    const reader = await signIn(stack, "apiKey", { key });

    const answers = await Promise.all(
      [television, reader].flatMap((refused) => [
        refusal(
          refused.client.query(api.core.auth.sessions.list, {
            paginationOpts: { numItems: 10, cursor: null },
          }),
        ),
        refusal(
          refused.client.query(api.core.auth.apiKeys.list, {
            paginationOpts: { numItems: 10, cursor: null },
          }),
        ),
      ]),
    );

    expect(answers).toEqual(["forbidden", "forbidden", "forbidden", "forbidden"]);
  });

  it("pages through more sessions than one page reads, each once, and reads no more than a page", async () => {
    if (stack === undefined) return;
    const person = await createPerson(stack, "busy");
    const laptop = await signInAs(stack, person);

    const keys = await inBatches(4, 4, async (index) =>
      laptop.client.action(api.core.auth.apiKeys.create, {
        name: `key ${index}`,
        scopes: ["movies:read"],
      }),
    );

    await inBatches(KEY_SIGN_INS_PAST_A_PAGE, 20, async (index) =>
      signIn(stack, "apiKey", { key: keys[index % keys.length]?.key ?? "" }),
    );

    const browsers = await inBatches(3, 1, async () => signInAs(stack, person));
    const loader = counted(sessionPages(laptop));
    const mark = await logMark(stack);
    const pages = await allPages(loader.load, 100_000);
    const rows = pages.flatMap((page) => page.page);

    const reads = (await usageSince(stack, mark, api.core.auth.sessions.list, loader.calls())).map(
      (call) => call.reads,
    );

    const expected = await Promise.all(
      [...browsers.toReversed(), laptop].map(async (each) => (await current(each)).sessionId),
    );

    const keyRows = rows.filter((row) => row.kind === "apiKey");

    expect(pages.length).toBeGreaterThan(1);
    expect(new Set(rows.map((row) => row.sessionId)).size).toBe(rows.length);
    expect(keyRows).toHaveLength(KEY_SIGN_INS_PAST_A_PAGE);
    expect(new Set(keyRows.map((row) => row.name))).toEqual(
      new Set(["key 0", "key 1", "key 2", "key 3"]),
    );
    expect(rows.filter((row) => row.kind !== "apiKey").map((row) => row.sessionId)).toEqual(
      expected,
    );
    expect(Math.max(...reads)).toBeLessThanOrEqual(PAGE_ROWS_MAX);
  });
});

describe.skipIf(stack === undefined)("a person's own API keys", { timeout: 300_000 }, () => {
  it("lists name, scopes, creation, expiry, and last use, newest first, never a secret", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");

    const older = await aiko.signedIn.client.action(api.core.auth.apiKeys.create, {
      name: "backup script",
      scopes: ["movies:read", "movies:play"],
      expiresInDays: 30,
    });

    const newer = await aiko.signedIn.client.action(api.core.auth.apiKeys.create, {
      name: "agent",
      scopes: ["account"],
    });

    const before = await keysOf(aiko.signedIn);

    expect(before).toMatchObject([
      { keyId: newer.keyId, name: "agent", scopes: ["account"], expiresAt: null, lastUsedAt: null },
      {
        keyId: older.keyId,
        name: "backup script",
        scopes: ["movies:read", "movies:play"],
        expiresAt: older.expiresAt,
        lastUsedAt: null,
      },
    ]);

    const signedInAt = Date.now();
    const agent = await signIn(stack, "apiKey", { key: newer.key });
    const after = await keysOf(agent);

    expect(after[0]?.lastUsedAt).toBeGreaterThanOrEqual(signedInAt - 5000);
    expect(after[0]?.createdAt).toBeLessThanOrEqual(after[0]?.lastUsedAt ?? 0);

    const shown = JSON.stringify(after);

    for (const { key } of [older, newer]) {
      expect(shown).not.toContain(key.split(".")[1]);
    }
  });

  it("refuses a key with no scopes, as old movies did", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "empty");

    expect(
      await failureOf(
        aiko.signedIn.client.action(api.core.auth.apiKeys.create, { name: "nothing", scopes: [] }),
      ),
    ).toEqual({ code: "invalid_args", message: "Choose at least one scope" });
    expect(await keysOf(aiko.signedIn)).toEqual([]);
  });

  it("drops a revoked key at once, every key after End all, and shows no one else's", async () => {
    if (stack === undefined) return;
    const aiko = await member(stack, "aiko");
    const bo = await member(stack, "bo");
    const first = await makeKey(aiko, "one");
    const second = await makeKey(aiko, "two");
    const bos = await makeKey(bo, "bo's");

    await aiko.signedIn.client.mutation(api.core.auth.apiKeys.revoke, { keyId: first.keyId });

    expect((await keysOf(aiko.signedIn)).map((key) => key.keyId)).toEqual([second.keyId]);
    expect((await keysOf(bo.signedIn)).map((key) => key.keyId)).toEqual([bos.keyId]);
    expect(
      await refusal(
        bo.signedIn.client.mutation(api.core.auth.apiKeys.revoke, { keyId: second.keyId }),
      ),
    ).toBe("not_found");

    await aiko.signedIn.client.mutation(api.core.auth.apiKeys.endAll, {});

    expect(await keysOf(aiko.signedIn)).toEqual([]);

    const third = await makeKey(aiko, "three");

    expect((await keysOf(aiko.signedIn)).map((key) => key.keyId)).toEqual([third.keyId]);
  });

  it("pages through more keys than one page holds, each once, at the largest page asked", async () => {
    if (stack === undefined) return;
    const busy = await member(stack, "keys");

    const made = await inBatches(PAGE_ROWS_MAX + 10, 50, async (index) =>
      busy.signedIn.client.action(api.core.auth.apiKeys.create, {
        name: `key ${index}`,
        scopes: ["movies:read"],
      }),
    );

    const loader = counted(keyPages(busy.signedIn));
    const mark = await logMark(stack);
    const pages = await allPages(loader.load, 100_000);
    const listed = pages.flatMap((page) => page.page.map((key) => key.keyId));

    const reads = (await usageSince(stack, mark, api.core.auth.apiKeys.list, loader.calls())).map(
      (call) => call.reads,
    );

    const ids: ReadonlyArray<Id<"apiKeys">> = made.map((key) => key.keyId);

    expect(pages.length).toBeGreaterThan(1);
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed.toSorted()).toEqual(ids.toSorted());
    expect(Math.max(...reads)).toBeLessThanOrEqual(PAGE_ROWS_MAX);
  });
});
