import { createHash } from "node:crypto";

import { ConvexHttpClient } from "convex/browser";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { api } from "../../../convex/_generated/api";
import type { Id } from "../../../convex/_generated/dataModel";
import { importRows, newestRows } from "../../rows";
import { createPerson, refusal, signIn, signInAs, unique } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

const DAY_MS = 24 * 60 * 60 * 1000;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const StoredInvite = Schema.Struct({
  _id: Schema.String,
  _creationTime: Schema.Finite,
  secretHash: Schema.String,
  role: Schema.Literals(["admin", "member"]),
  invitedBy: Schema.String,
  expiresAt: Schema.Finite,
});

const storedInvites = () =>
  newestRows("invites").map((line) => ({
    line,
    invite: Schema.decodeUnknownSync(StoredInvite)(JSON.parse(line), {
      onExcessProperty: "error",
    }),
  }));

const secretOf = (code: string): string => code.slice(code.indexOf(".") + 1);

const signInAdmin = async (core: CoreStack): Promise<SignedIn> =>
  signInAs(core, await createPerson(core, "admin", "admin"));

const newcomer = () => ({ username: `new-${unique()}`, password: `password-${unique()}` });

const anonymous = (core: CoreStack) => new ConvexHttpClient(core.url, { logger: false });

const listsInvite = async (
  admin: SignedIn,
  inviteId: Id<"invites">,
  cursor: string | null = null,
): Promise<boolean> => {
  const page = await admin.client.query(api.core.accounts.invites.list, {
    paginationOpts: { numItems: 200, cursor },
  });

  if (page.page.some((invite) => invite.inviteId === inviteId)) return true;

  return page.isDone ? false : listsInvite(admin, inviteId, page.continueCursor);
};

describe.skipIf(stack === undefined)("invites", { timeout: 120_000 }, () => {
  it("makes a user with the username and password they picked, signed in, in one call", async () => {
    if (stack === undefined) return;
    const admin = await signInAdmin(stack);
    const inviter = await admin.client.query(api.core.auth.sessions.current, {});
    const { code } = await admin.client.action(api.core.accounts.invites.create, {});

    expect(await anonymous(stack).query(api.core.accounts.invites.lookup, { code })).toMatchObject({
      role: "member",
      invitedBy: inviter.username,
    });

    const person = newcomer();
    const joined = await signIn(stack, "invite", { code, ...person });

    expect(await joined.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      username: person.username,
      role: "member",
      kind: "password",
      scopes: ["account"],
    });

    expect(await refusal(signInAs(stack, person))).toBe("accepted");
    expect(await refusal(signIn(stack, "invite", { code, ...newcomer() }))).toBe("expired");
    expect(await refusal(anonymous(stack).query(api.core.accounts.invites.lookup, { code }))).toBe(
      "expired",
    );
  });

  it("gives the invitee the role the invite names", async () => {
    if (stack === undefined) return;
    const admin = await signInAdmin(stack);
    const { code } = await admin.client.action(api.core.accounts.invites.create, { role: "admin" });
    const joined = await signIn(stack, "invite", { code, ...newcomer() });

    expect(await joined.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      role: "admin",
      scopes: ["account", "admin"],
    });
  });

  it("stores only a hash of the code", async () => {
    if (stack === undefined) return;
    const admin = await signInAdmin(stack);
    const { inviteId, code } = await admin.client.action(api.core.accounts.invites.create, {});
    const stored = storedInvites().find(({ invite }) => invite._id === inviteId);

    expect(stored?.invite.secretHash).toBe(sha256(secretOf(code)));
    expect(stored?.line).not.toContain(secretOf(code));
  });

  it("refuses an invite that has expired", async () => {
    if (stack === undefined) return;
    const admin = await signInAdmin(stack);
    const { userId } = await admin.client.query(api.core.auth.sessions.current, {});
    const secret = `expired-${unique()}-${unique()}-${unique()}`;

    importRows("invites", [
      {
        secretHash: sha256(secret),
        role: "member",
        invitedBy: userId,
        expiresAt: Date.now() - 1000,
      },
    ]);

    const planted = storedInvites().find(({ invite }) => invite.secretHash === sha256(secret));
    const code = `mi_${planted?.invite._id ?? "missing"}.${secret}`;
    const person = newcomer();

    expect(planted).toBeDefined();
    expect(await refusal(anonymous(stack).query(api.core.accounts.invites.lookup, { code }))).toBe(
      "expired",
    );
    expect(await refusal(signIn(stack, "invite", { code, ...person }))).toBe("expired");
    expect(await refusal(signInAs(stack, person))).toBe("unauthenticated");
  });

  it("lasts the days an admin picks, from 1 to 30, and 7 by default", async () => {
    if (stack === undefined) return;
    const admin = await signInAdmin(stack);

    const lasts = async (expiresInDays?: number) => {
      const before = Date.now();

      const { expiresAt } = await admin.client.action(
        api.core.accounts.invites.create,
        expiresInDays === undefined ? {} : { expiresInDays },
      );

      return (expiresAt - before) / DAY_MS;
    };

    expect(await lasts(1)).toBeCloseTo(1, 2);
    expect(await lasts(30)).toBeCloseTo(30, 2);
    expect(await lasts()).toBeCloseTo(7, 2);

    expect(await Promise.all([0, 31, 1.5].map(async (days) => refusal(lasts(days))))).toEqual([
      "invalid_args",
      "invalid_args",
      "invalid_args",
    ]);
  });

  it("stops working when its maker is no longer an admin, or is revoked", async () => {
    if (stack === undefined) return;
    const maker = await signInAdmin(stack);
    const other = await signInAdmin(stack);
    const { userId } = await maker.client.query(api.core.auth.sessions.current, {});
    const demoted = await maker.client.action(api.core.accounts.invites.create, {});

    await other.client.mutation(api.core.accounts.users.setRole, { userId, role: "member" });

    expect(await refusal(signIn(stack, "invite", { code: demoted.code, ...newcomer() }))).toBe(
      "expired",
    );

    const revoked = await other.client.action(api.core.accounts.invites.create, {});

    expect(await listsInvite(other, revoked.inviteId)).toBe(true);

    await other.client.mutation(api.core.accounts.invites.revoke, { inviteId: revoked.inviteId });

    expect(await listsInvite(other, revoked.inviteId)).toBe(false);
    expect(await refusal(signIn(stack, "invite", { code: revoked.code, ...newcomer() }))).toBe(
      "expired",
    );
    expect(
      await refusal(
        other.client.mutation(api.core.accounts.invites.revoke, { inviteId: revoked.inviteId }),
      ),
    ).toBe("not_found");
  });

  it("keeps the invite when the username is taken, so the invitee can pick another", async () => {
    if (stack === undefined) return;
    const admin = await signInAdmin(stack);
    const taken = await createPerson(stack);
    const { code } = await admin.client.action(api.core.accounts.invites.create, {});

    expect(
      await refusal(
        signIn(stack, "invite", {
          code,
          username: taken.username.toUpperCase(),
          password: "x".repeat(8),
        }),
      ),
    ).toBe("conflict");
    expect(
      await refusal(
        signIn(stack, "invite", { code, username: "has space", password: "x".repeat(8) }),
      ),
    ).toBe("invalid_args");
    expect(await refusal(signIn(stack, "invite", { code, ...newcomer() }))).toBe("accepted");
  });

  it("lets only admins invite, and never with an API key", async () => {
    if (stack === undefined) return;
    const member = await signInAs(stack, await createPerson(stack));
    const admin = await signInAdmin(stack);

    const { key } = await admin.client.action(api.core.auth.apiKeys.create, {
      name: "agent",
      scopes: ["account", "admin"],
    });

    const agent = await signIn(stack, "apiKey", { key });

    expect(await refusal(member.client.action(api.core.accounts.invites.create, {}))).toBe(
      "forbidden",
    );
    expect(await refusal(agent.client.action(api.core.accounts.invites.create, {}))).toBe(
      "forbidden",
    );
    expect(
      await refusal(
        agent.client.query(api.core.accounts.invites.list, {
          paginationOpts: { numItems: 1, cursor: null },
        }),
      ),
    ).toBe("accepted");
  });
});
