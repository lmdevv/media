import { createHash } from "node:crypto";

import { ConvexHttpClient } from "convex/browser";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { GRANT_SESSIONS_MAX } from "../../../convex/core/sessions";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { enroll, member, picker } from "../../devices";
import type { Member } from "../../devices";
import { newestRows } from "../../rows";
import { failureOf, refusal, signIn, signInAs } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

const BAD_GRANT = {
  code: "unauthenticated",
  message: "This device grant does not work; sign in with your password",
};

interface Issued {
  readonly grantId: Id<"deviceGrants">;
  readonly grant: string;
}

const issue = (signedIn: SignedIn, name = "Phone", grant?: string): Promise<Issued> =>
  signedIn.client.action(
    api.core.devices.deviceGrants.issue,
    grant === undefined ? { name } : { name, grant },
  );

const exchange = (core: CoreStack, userId: Id<"users">, grant: string): Promise<SignedIn> =>
  signIn(core, "grant", { userId, grant });

const current = (signedIn: SignedIn) => signedIn.client.query(api.core.auth.sessions.current, {});

const grantsOf = async (who: Member) =>
  (
    await who.signedIn.client.query(api.core.devices.deviceGrants.list, {
      paginationOpts: { numItems: 20, cursor: null },
    })
  ).page;

/** A person signed in on one app of a phone, with the grant that sign-in issued. */
const phone = async (core: CoreStack, label: string) => {
  const who = await member(core, label);
  const movies = await enroll(who.signedIn, "Movies on phone");
  const issued = await issue(who.signedIn, `${label}'s phone`);

  return { who, movies, issued };
};

/** An app exchanging the grant and enrolling its own device, as the second iOS app does. */
const app = async (core: CoreStack, userId: Id<"users">, grant: string, name: string) => {
  const signedIn = await exchange(core, userId, grant);
  const device = await enroll(signedIn, name);

  return { signedIn, device };
};

describe.skipIf(stack === undefined)("device grants", { timeout: 180_000 }, () => {
  it("stores only the grant's hash, and each app exchanges it into a session on a device of its own", async () => {
    if (stack === undefined) return;
    const { who, movies, issued } = await phone(stack, "aiko");
    const music = await app(stack, who.userId, issued.grant, "Music on phone");
    const tv = await app(stack, who.userId, issued.grant, "Another app on phone");

    expect(issued.grant).toMatch(/^dg_[a-z0-9]+\.[\w-]{40,}$/u);
    expect(await current(music.signedIn)).toMatchObject({
      userId: who.userId,
      kind: "grant",
      device: { deviceId: music.device.deviceId, joinSequence: 1 },
    });
    expect(await current(tv.signedIn)).toMatchObject({ kind: "grant" });
    expect(new Set([movies.deviceId, music.device.deviceId, tv.device.deviceId]).size).toBe(3);
    expect((await picker(stack, music.device)).tiles.map((tile) => tile.userId)).toEqual([
      who.userId,
    ]);

    const [listed] = await grantsOf(who);

    expect(listed).toMatchObject({ grantId: issued.grantId, name: "aiko's phone", signsIn: true });
    expect(listed?.devices.map((device) => device.deviceId).toSorted()).toEqual(
      [movies.deviceId, music.device.deviceId, tv.device.deviceId].toSorted(),
    );

    const secret = issued.grant.split(".")[1] ?? "";
    const rows = newestRows("deviceGrants").join("\n");

    expect(rows).toContain(createHash("sha256").update(secret).digest("hex"));
    expect(rows).not.toContain(secret);
  });

  it("ends every session the grant issued or minted when it is revoked, and mints no more", async () => {
    if (stack === undefined) return;
    const { who, issued } = await phone(stack, "revoked");
    const music = await app(stack, who.userId, issued.grant, "Music on phone");
    const other = await app(stack, who.userId, issued.grant, "Other on phone");
    const laptop = await signInAs(stack, who.person);

    await laptop.client.mutation(api.core.devices.deviceGrants.revoke, {
      grantId: issued.grantId,
    });

    expect(await refusal(current(who.signedIn))).toBe("unauthenticated");
    expect(await refusal(current(music.signedIn))).toBe("unauthenticated");
    expect(await refusal(current(other.signedIn))).toBe("unauthenticated");
    expect(await refusal(current(laptop))).toBe("accepted");
    expect(await failureOf(exchange(stack, who.userId, issued.grant))).toEqual(BAD_GRANT);
    expect(
      await refusal(
        laptop.client.mutation(api.core.devices.deviceGrants.revoke, { grantId: issued.grantId }),
      ),
    ).toBe("not_found");
  });

  it("ends one app's session alone, leaving the other apps and the grant", async () => {
    if (stack === undefined) return;
    const { who, issued } = await phone(stack, "one");
    const music = await app(stack, who.userId, issued.grant, "Music on phone");
    const other = await app(stack, who.userId, issued.grant, "Other on phone");
    const { sessionId } = await current(music.signedIn);

    await who.signedIn.client.mutation(api.core.auth.sessions.end, { sessionId });

    expect(await refusal(current(music.signedIn))).toBe("unauthenticated");
    expect(await refusal(current(other.signedIn))).toBe("accepted");
    expect(await refusal(current(who.signedIn))).toBe("accepted");
    expect(await refusal(current(await exchange(stack, who.userId, issued.grant)))).toBe(
      "accepted",
    );
  });

  it("replaces an app's earlier session on its device when it exchanges again", async () => {
    if (stack === undefined) return;
    const { who, issued } = await phone(stack, "again");
    const first = await app(stack, who.userId, issued.grant, "Music on phone");
    const second = await exchange(stack, who.userId, issued.grant);
    const joined = await enroll(second, "Music on phone", first.device.device);

    expect(joined).toEqual({ ...first.device, joinSequence: 2 });
    expect(await refusal(current(first.signedIn))).toBe("unauthenticated");
    expect(await current(second)).toMatchObject({
      kind: "grant",
      device: { deviceId: first.device.deviceId, joinSequence: 2 },
    });
  });

  it("refuses a tampered, malformed, or someone else's grant with one answer", async () => {
    if (stack === undefined) return;
    const aiko = await phone(stack, "aiko");
    const bo = await member(stack, "bo");
    const [prefix, secret = ""] = aiko.issued.grant.split(".");
    const flipped = `${secret.slice(0, -1)}${secret.endsWith("A") ? "B" : "A"}`;

    const answers = await Promise.all(
      [
        exchange(stack, aiko.who.userId, `${prefix}.${flipped}`),
        exchange(stack, bo.userId, aiko.issued.grant),
        exchange(stack, aiko.who.userId, "dg_nothing.short"),
        exchange(stack, aiko.who.userId, `dg_${bo.userId}.${secret}`),
      ].map(failureOf),
    );

    expect(answers).toEqual([BAD_GRANT, BAD_GRANT, BAD_GRANT, BAD_GRANT]);
  });

  it("stops minting once its person signs out everywhere, until a password sign-in confirms it", async () => {
    if (stack === undefined) return;
    const { who, issued } = await phone(stack, "ended");
    const music = await app(stack, who.userId, issued.grant, "Music on phone");
    const laptop = await signInAs(stack, who.person);

    await laptop.client.mutation(api.core.auth.sessions.endAll, { keepCurrent: false });

    expect(await refusal(current(music.signedIn))).toBe("unauthenticated");
    expect(await refusal(current(who.signedIn))).toBe("unauthenticated");
    expect(await failureOf(exchange(stack, who.userId, issued.grant))).toEqual(BAD_GRANT);

    const back = await signInAs(stack, who.person);

    expect(await grantsOf({ ...who, signedIn: back })).toMatchObject([
      { grantId: issued.grantId, signsIn: false, devices: [] },
    ]);
    expect(await issue(back, "Phone", issued.grant)).toEqual(issued);
    expect(await refusal(current(await exchange(stack, who.userId, issued.grant)))).toBe(
      "accepted",
    );
  });

  it("issues only from a password session, and only its own person sees or revokes a grant", async () => {
    if (stack === undefined) return;
    const { who, issued } = await phone(stack, "issuer");
    const bo = await member(stack, "bo");
    const minted = await exchange(stack, who.userId, issued.grant);

    const { key } = await who.signedIn.client.action(api.core.auth.apiKeys.create, {
      name: "script",
      scopes: ["account"],
    });

    const keyed = await signIn(stack, "apiKey", { key });
    const anonymous = new ConvexHttpClient(stack.url, { logger: false });

    const started = await anonymous.action(api.core.auth.deviceCodes.start, {
      clientName: "TV",
    });

    await who.signedIn.client.mutation(api.core.auth.deviceCodes.approve, {
      userCode: started.userCode,
      scopes: ["account"],
    });

    const tv = await signIn(stack, "deviceCode", { deviceCode: started.deviceCode });

    expect(await failureOf(issue(minted))).toEqual({
      code: "forbidden",
      message: "Only a password sign-in issues a device grant",
    });
    expect(await refusal(issue(keyed))).toBe("forbidden");
    expect(await refusal(issue(tv))).toBe("forbidden");
    expect(await refusal(issue(who.signedIn, " "))).toBe("invalid_args");
    expect(
      await refusal(
        bo.signedIn.client.mutation(api.core.devices.deviceGrants.revoke, {
          grantId: issued.grantId,
        }),
      ),
    ).toBe("not_found");
    expect(await grantsOf(bo)).toEqual([]);
    expect(await issue(bo.signedIn, "Bo's phone", issued.grant)).not.toMatchObject({
      grantId: issued.grantId,
    });
    expect(await refusal(current(minted))).toBe("accepted");
  });

  it("keeps at most its cap of sessions, ending unenrolled ones before any app's", async () => {
    if (stack === undefined) return;
    const { who, issued } = await phone(stack, "many");
    const music = await app(stack, who.userId, issued.grant, "Music on phone");

    // The issuer and the music app hold two places; each unenrolled exchange takes one more.
    const exchanged = await inOrder(
      Array.from({ length: GRANT_SESSIONS_MAX - 1 }, (_, n) => n),
      async () => exchange(stack, who.userId, issued.grant),
    );

    const answers = await Promise.all(
      [who.signedIn, music.signedIn, ...exchanged].map(async (signedIn) =>
        refusal(current(signedIn)),
      ),
    );

    expect(answers).toEqual([
      "accepted",
      "accepted",
      "unauthenticated",
      ...exchanged.slice(1).map(() => "accepted"),
    ]);
  });
});
