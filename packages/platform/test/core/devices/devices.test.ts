import { ConvexClient } from "convex/browser";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { roleScopes } from "../../../commands/scopes";
import { api, internal } from "../../../convex/_generated/api";
import { NO_TILE } from "../../../convex/core/devices/facts";
import { inOrder } from "../../../convex/core/lib/inOrder";
import { PASSWORD_MAX } from "../../../convex/core/lib/passwords";
import { runFunction } from "../../admin";
import {
  anonymous,
  enroll,
  listings,
  member,
  openTile,
  picker,
  sharedAdmin,
  sharedDevice,
  sharedTiles,
  tileIn,
} from "../../devices";
import type { Member, Picker } from "../../devices";
import { importRows } from "../../rows";
import { failureOf, refusal, signIn, signInAs } from "../../sign-in";
import type { SignedIn } from "../../sign-in";
import { coreStackFromEnvFile } from "../../stack-env";
import type { CoreStack } from "../../stack-env";

const stack = coreStackFromEnvFile();

const SET_PASSWORD = {
  "their own change": async (_core, who, password) => {
    await who.signedIn.client.action(api.core.accounts.me.changePassword, {
      currentPassword: who.person.password,
      newPassword: password,
    });
  },
  "a reset link": async (core, who, password) => {
    const admin = await sharedAdmin(core);

    const { code } = await admin.signedIn.client.action(api.core.accounts.resetLinks.create, {
      userId: who.userId,
    });

    await signIn(core, "reset", { code, password });
  },
  "a host reset": async (core, who, password) => {
    await runFunction(
      core,
      internal.core.accounts.host.resetPassword,
      { username: who.person.username, password },
      Schema.Struct({ username: Schema.String }),
    );
  },
} satisfies Readonly<
  Record<string, (core: CoreStack, who: Member, password: string) => Promise<void>>
>;

const FULL_WIDTH_ZERO = 0xff10;

const MATH_BOLD_ZERO = 0x1d7ce;

const digitsIn = (zero: number, digits: string): string =>
  String.fromCodePoint(...Array.from(digits, (digit) => zero + Number(digit)));

const listed = listings();

const CONTENT_SCOPES = roleScopes.member.filter((scope) => scope !== "account");

const LOCKED_BY_KID = { state: "locked", because: ["kid-listed"], opensWith: "self" };

const currentOf = (tile: SignedIn) => tile.client.query(api.core.auth.sessions.current, {});

describe.skipIf(stack === undefined)("devices", { timeout: 180_000 }, () => {
  afterEach(async () => {
    await listed.clear();
  });

  it("registers personal devices whose picker lists only the people signed in on them", async () => {
    if (stack === undefined) return;
    const ada = await member(stack, "ada");
    const bo = await member(stack, "bo");
    const cy = await member(stack, "cy");

    const laptop = await enroll(ada.signedIn, "Ada's laptop");
    const again = await enroll(bo.signedIn, "Shared laptop", laptop.device);
    await enroll(cy.signedIn, "Cy's phone");

    expect(again).toEqual({ ...laptop, joinSequence: 2 });

    const shown = await picker(stack, laptop);
    const names = shown.tiles.map((tile) => tile.username);

    expect(shown).toMatchObject({ mode: "personal", name: "Shared laptop" });
    expect(names).toEqual([ada.person.username, bo.person.username].toSorted());

    await ada.signedIn.client.mutation(api.core.auth.sessions.end, { sessionId: ada.sessionId });

    expect((await picker(stack, laptop)).tiles.map((tile) => tile.username)).toEqual([
      bo.person.username,
    ]);
    expect(await refusal(enroll(cy.signedIn, "x", `${laptop.device}x`))).toBe("accepted");
    expect(await refusal(picker(stack, { ...laptop, device: `${laptop.device}x` }))).toBe(
      "not_found",
    );
  });

  it("numbers each join of a device, and keeps live only the person's last join there", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const ada = await member(stack, "ada");
    const savedFirst = await signInAs(stack, ada.person);
    const savedSecond = await signInAs(stack, ada.person);
    const laptop = await enroll(ada.signedIn, "Ada's laptop");

    // Two tabs' sign-ins: the one saved second joins first, then the one saved first joins.
    const joinedFirst = await enroll(savedSecond, "Ada's laptop", laptop.device);
    const joinedLast = await enroll(savedFirst, "Ada's laptop", laptop.device);

    expect([laptop, joinedFirst, joinedLast].map((join) => join.joinSequence)).toStrictEqual([
      1, 2, 3,
    ]);
    expect(await refusal(savedSecond.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await savedFirst.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      userId: ada.userId,
      device: { deviceId: laptop.deviceId, joinSequence: 3 },
    });

    const setMode = (mode: "personal" | "shared") =>
      admin.signedIn.client.mutation(api.core.devices.registry.setMode, {
        deviceId: laptop.deviceId,
        mode,
      });

    await setMode("shared");
    await setMode("personal");

    const afterModes = await enroll(await signInAs(stack, ada.person), "Laptop", laptop.device);

    expect(afterModes.joinSequence).toBe(4);
  });

  it("numbers each tile a shared device opens after its joins, and keeps open only the highest", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const ada = await listed.adult(await member(stack, "ada"));
    const bo = await listed.adult(await member(stack, "bo"));
    const tv = await sharedDevice(stack, admin);

    const adaTile = await openTile(stack, tv, ada.userId);
    const adaOpened = (await currentOf(adaTile)).device;
    const boTile = await openTile(stack, tv, bo.userId);

    expect({
      ada: adaOpened,
      bo: (await currentOf(boTile)).device,
      adaAfter: await refusal(currentOf(adaTile)),
    }).toStrictEqual({
      ada: { deviceId: tv.deviceId, joinSequence: 2 },
      bo: { deviceId: tv.deviceId, joinSequence: 3 },
      adaAfter: "unauthenticated",
    });
  });

  it("lists on a shared device only the people who opted in", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const dad = await listed.adult(await member(stack, "dad"));
    const mom = await listed.adult(await member(stack, "mom"));
    const aunt = await member(stack, "aunt");
    const tv = await sharedDevice(stack, admin);

    expect(await refusal(tv.setUp.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );

    const ids = sharedTiles(await picker(stack, tv)).map((tile) => tile.userId);

    expect(ids).toContain(dad.userId);
    expect(ids).toContain(mom.userId);
    expect(ids).not.toContain(aunt.userId);
    expect(ids).not.toContain(admin.userId);
    expect(await refusal(openTile(stack, tv, aunt.userId))).toBe("not_found");

    const momTile = await openTile(stack, tv, mom.userId);

    await mom.signedIn.client.mutation(api.core.devices.tiles.setListed, {
      userId: mom.userId,
      listed: false,
    });

    expect(sharedTiles(await picker(stack, tv)).map((tile) => tile.userId)).not.toContain(
      mom.userId,
    );
    expect(await refusal(momTile.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
  });

  it("opens a kid's tile freely and locks every adult tile while a kid is listed", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const dad = await listed.adult(await member(stack, "dad"));
    const lily = await listed.kid(admin, await member(stack, "lily"));
    const tv = await sharedDevice(stack, admin);

    const before = await picker(stack, tv);

    expect(tileIn(before, dad.userId).lock).toEqual(LOCKED_BY_KID);
    expect(tileIn(before, lily.userId)).toMatchObject({ kid: true, lock: { state: "open" } });

    const lilyTile = await openTile(stack, tv, lily.userId);

    expect(await lilyTile.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      userId: lily.userId,
      kind: "tile",
      scopes: CONTENT_SCOPES,
    });

    const after = await picker(stack, tv);

    expect(after).toMatchObject({ mode: "shared", holder: lily.userId });
    expect(tileIn(after, dad.userId).lock).toEqual({
      state: "locked",
      because: ["kid-listed", "kid-holds-device"],
      opensWith: "self",
    });
    expect(await refusal(openTile(stack, tv, dad.userId))).toBe("forbidden");
    expect(
      await refusal(lilyTile.client.action(api.core.devices.registry.enroll, { name: "TV" })),
    ).toBe("forbidden");
    expect(
      await refusal(
        lilyTile.client.query(api.core.accounts.users.list, {
          paginationOpts: { numItems: 1, cursor: null },
        }),
      ),
    ).toBe("forbidden");
  });

  it("refuses an admin who tries to lift the lock a listed kid puts on an adult's tile", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const dad = await listed.adult(await member(stack, "dad"));
    const lily = await listed.kid(admin, await member(stack, "lily"));
    const tv = await sharedDevice(stack, admin);

    const unlock = () =>
      admin.signedIn.client.mutation(api.core.devices.tiles.setLock, {
        userId: dad.userId,
        locked: false,
      });

    expect(await refusal(unlock())).toBe("forbidden");
    expect(tileIn(await picker(stack, tv), dad.userId).lock).toEqual(LOCKED_BY_KID);
    expect(
      await refusal(
        lily.signedIn.client.mutation(api.core.devices.tiles.setListed, {
          userId: lily.userId,
          listed: false,
        }),
      ),
    ).toBe("forbidden");

    await admin.signedIn.client.mutation(api.core.devices.tiles.setListed, {
      userId: lily.userId,
      listed: false,
    });

    expect(await refusal(unlock())).toBe("accepted");
    expect(tileIn(await picker(stack, tv), dad.userId).lock).toEqual({ state: "open" });
  });

  it("locks the one tile an admin names when no kid is listed", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const dad = await listed.adult(await member(stack, "dad"));
    const mom = await listed.adult(await member(stack, "mom"));
    const tv = await sharedDevice(stack, admin);

    expect(sharedTiles(await picker(stack, tv)).filter((tile) => tile.kid)).toEqual([]);

    const setLock = (locked: boolean) =>
      admin.signedIn.client.mutation(api.core.devices.tiles.setLock, {
        userId: dad.userId,
        locked,
      });

    await setLock(true);

    const shown = await picker(stack, tv);

    expect(tileIn(shown, dad.userId).lock).toEqual({
      state: "locked",
      because: ["admin-rule"],
      opensWith: "self",
    });
    expect(tileIn(shown, mom.userId).lock).toEqual({ state: "open" });
    expect(
      sharedTiles(shown)
        .filter((tile) => tile.userId !== dad.userId)
        .every((tile) => tile.lock.state === "open"),
    ).toBe(true);
    expect(await refusal(openTile(stack, tv, dad.userId))).toBe("forbidden");
    expect(
      await refusal(
        openTile(stack, tv, dad.userId, {
          kind: "password",
          by: mom.userId,
          password: mom.person.password,
        }),
      ),
    ).toBe("forbidden");

    const dadTile = await openTile(stack, tv, dad.userId, {
      kind: "password",
      by: dad.userId,
      password: dad.person.password,
    });

    expect(await dadTile.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      userId: dad.userId,
      kind: "tile",
    });

    const momTile = await openTile(stack, tv, mom.userId);

    expect(await refusal(dadTile.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await momTile.client.query(api.core.auth.sessions.current, {})).toMatchObject({
      userId: mom.userId,
    });

    await setLock(false);
  });

  it("turns an unlock code off after 5 wrong tries until a password, an approval, or an admin", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const dad = await listed.adult(await member(stack, "dad"));
    await listed.kid(admin, await member(stack, "lily"));
    const tv = await sharedDevice(stack, admin);
    const code = "4826";

    await dad.signedIn.client.action(api.core.devices.unlockCodes.set, { code });

    const tryCode = (typed: string) =>
      refusal(openTile(stack, tv, dad.userId, { kind: "code", by: dad.userId, code: typed }));

    const codeState = async () => tileIn(await picker(stack, tv), dad.userId).code;

    const fiveWrong = async () => {
      expect(await inOrder(["1111", "2222", "3333", "4444", "5555"], tryCode)).toEqual(
        Array.from({ length: 5 }, () => "unauthenticated"),
      );

      expect(await codeState()).toBe("off");
      expect(await tryCode(code)).toBe("forbidden");
    };

    expect(await codeState()).toBe("ready");
    expect(await tryCode(code)).toBe("accepted");

    await fiveWrong();

    expect(
      await refusal(
        openTile(stack, tv, dad.userId, {
          kind: "password",
          by: dad.userId,
          password: dad.person.password,
        }),
      ),
    ).toBe("accepted");
    expect(await codeState()).toBe("ready");

    await fiveWrong();

    expect(
      await refusal(
        dad.signedIn.client.mutation(api.core.devices.unlockCodes.reset, {
          deviceId: tv.deviceId,
          userId: dad.userId,
        }),
      ),
    ).toBe("forbidden");

    await admin.signedIn.client.mutation(api.core.devices.unlockCodes.reset, {
      deviceId: tv.deviceId,
      userId: dad.userId,
    });

    expect(await codeState()).toBe("ready");
    expect(await tryCode(code)).toBe("accepted");
  });

  it("never lets an unlock code sign in", async () => {
    if (stack === undefined) return;
    const dad = await listed.adult(await member(stack, "dad"));
    const code = "7391448";

    await dad.signedIn.client.action(api.core.devices.unlockCodes.set, { code });

    expect(
      await refusal(signIn(stack, "password", { username: dad.person.username, password: code })),
    ).toBe("unauthenticated");

    const phone = await enroll(dad.signedIn, "Dad's phone");

    expect(
      await refusal(openTile(stack, phone, dad.userId, { kind: "code", by: dad.userId, code })),
    ).toBe("forbidden");
    expect(
      await refusal(dad.signedIn.client.action(api.core.devices.unlockCodes.set, { code: "12ab" })),
    ).toBe("invalid_args");
  });

  it.each(Object.entries(SET_PASSWORD))(
    "never keeps an unlock code that is also the password set by %s",
    async (_path, setPassword) => {
      if (stack === undefined) return;
      const admin = await sharedAdmin(stack);
      const dad = await member(stack, "dad");
      const tv = await sharedDevice(stack, admin);
      const digits = "73914482";

      const setCode = await refusal(
        dad.signedIn.client.action(api.core.devices.unlockCodes.set, { code: digits }),
      );

      await setPassword(stack, dad, digits);

      const signedIn = await signInAs(stack, { ...dad.person, password: digits });

      await listed.adult({ ...dad, signedIn });

      expect({ setCode, code: tileIn(await picker(stack, tv), dad.userId).code }).toEqual({
        setCode: "invalid_args",
        code: "none",
      });
      expect(
        await refusal(signedIn.client.action(api.core.devices.unlockCodes.set, { code: digits })),
      ).toBe("invalid_args");
    },
  );

  it.each(Object.entries(SET_PASSWORD))(
    "refuses a password set by %s that Scrypt hashes as the unlock code",
    async (_path, setPassword) => {
      if (stack === undefined) return;
      const dad = await member(stack, "dad");
      const code = "7391448";

      await dad.signedIn.client.action(api.core.devices.unlockCodes.set, { code });

      const set = await refusal(setPassword(stack, dad, digitsIn(MATH_BOLD_ZERO, code)));
      const codeSignIn = await refusal(signInAs(stack, { ...dad.person, password: code }));

      expect({ set, codeSignIn }).toEqual({ set: "invalid_args", codeSignIn: "unauthenticated" });
    },
  );

  it.each(Object.entries(SET_PASSWORD))(
    "takes a longest password of full-width and math digits set by %s, which signs in and opens a tile",
    async (_path, setPassword) => {
      if (stack === undefined) return;
      const admin = await sharedAdmin(stack);
      const dad = await member(stack, "dad");
      const half = "7391".repeat(PASSWORD_MAX).slice(0, PASSWORD_MAX / 2);
      const password = `${digitsIn(FULL_WIDTH_ZERO, half)}${digitsIn(MATH_BOLD_ZERO, half)}`;

      await setPassword(stack, dad, password);

      const signedIn = await signInAs(stack, { ...dad.person, password });

      await listed.adult({ ...dad, signedIn });
      await listed.kid(admin, await member(stack, "lily"));

      const tv = await sharedDevice(stack, admin);

      const tile = await openTile(stack, tv, dad.userId, {
        kind: "password",
        by: dad.userId,
        password,
      });

      expect(await tile.client.query(api.core.auth.sessions.current, {})).toMatchObject({
        userId: dad.userId,
        kind: "tile",
      });
    },
  );

  it("opens an adult's tile when that adult approves from another signed-in session", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const dad = await listed.adult(await member(stack, "dad"));
    const mom = await listed.adult(await member(stack, "mom"));
    await listed.kid(admin, await member(stack, "lily"));
    const tv = await sharedDevice(stack, admin);
    const phone = await signInAs(stack, dad.person);

    const asked = await anonymous(stack).mutation(api.core.devices.approvals.request, {
      device: tv.device,
      ask: { intent: "open", userId: dad.userId },
    });

    const proof = { kind: "approval", approvalId: asked.approvalId } as const;

    expect(await refusal(openTile(stack, tv, dad.userId, proof))).toBe("pending");
    expect(
      (await mom.signedIn.client.query(api.core.devices.approvals.pending, {})).map(
        (prompt) => prompt.approvalId,
      ),
    ).not.toContain(asked.approvalId);
    expect(
      await refusal(
        mom.signedIn.client.mutation(api.core.devices.approvals.approve, {
          approvalId: asked.approvalId,
        }),
      ),
    ).toBe("not_found");

    const prompts = await phone.client.query(api.core.devices.approvals.pending, {});

    expect(prompts).toContainEqual({
      approvalId: asked.approvalId,
      intent: "open",
      deviceName: "Living room TV",
      userId: dad.userId,
      username: dad.person.username,
      expiresAt: asked.expiresAt,
    });

    await phone.client.mutation(api.core.devices.approvals.approve, {
      approvalId: asked.approvalId,
    });

    const dadTile = await openTile(stack, tv, dad.userId, proof);
    const current = await dadTile.client.query(api.core.auth.sessions.current, {});

    expect(current).toMatchObject({ userId: dad.userId, kind: "tile" });
    expect(
      await (
        await openTile(stack, tv, dad.userId, proof)
      ).client.query(api.core.auth.sessions.current, {}),
    ).toMatchObject({ sessionId: current.sessionId });
    expect(
      await refusal(
        dadTile.client.mutation(api.core.devices.approvals.approve, {
          approvalId: asked.approvalId,
        }),
      ),
    ).toBe("forbidden");
  });

  it("keeps a kid on their tile until an adult approves leaving it", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const mom = await listed.adult(await member(stack, "mom"));
    const lily = await listed.kid(admin, await member(stack, "lily"));
    const max = await listed.kid(admin, await member(stack, "max"));
    const tv = await sharedDevice(stack, admin);
    const device = { device: tv.device };

    const maxCode = "6152";

    await max.signedIn.client.action(api.core.devices.unlockCodes.set, { code: maxCode });

    const lilyTile = await openTile(stack, tv, lily.userId);

    await lilyTile.client.action(api.auth.signOut, {});

    expect(tileIn(await picker(stack, tv), max.userId).lock).toEqual({
      state: "locked",
      because: ["kid-holds-device"],
      opensWith: "adult",
    });
    expect(await refusal(openTile(stack, tv, max.userId))).toBe("forbidden");
    expect(
      await refusal(
        openTile(stack, tv, max.userId, { kind: "code", by: max.userId, code: maxCode }),
      ),
    ).toBe("forbidden");
    expect(
      await refusal(openTile(stack, tv, max.userId, { kind: "code", by: max.userId, code: "x" })),
    ).toBe("invalid_args");
    expect(tileIn(await picker(stack, tv), max.userId).code).toBe("ready");
    expect(
      await refusal(
        anonymous(stack).mutation(api.core.devices.approvals.request, {
          ...device,
          ask: { intent: "open", userId: max.userId },
        }),
      ),
    ).toBe("conflict");

    const asked = await anonymous(stack).mutation(api.core.devices.approvals.request, {
      ...device,
      ask: { intent: "leave" },
    });

    const approve = (who: typeof mom) =>
      who.signedIn.client.mutation(api.core.devices.approvals.approve, {
        approvalId: asked.approvalId,
      });

    expect(await refusal(approve(max))).toBe("forbidden");
    expect(await max.signedIn.client.query(api.core.devices.approvals.pending, {})).toEqual([]);
    expect(
      (await mom.signedIn.client.query(api.core.devices.approvals.pending, {})).map(
        (prompt) => prompt.approvalId,
      ),
    ).toContain(asked.approvalId);

    await approve(mom);

    expect(await picker(stack, tv)).toMatchObject({ holder: null });
    expect(await refusal(openTile(stack, tv, max.userId))).toBe("accepted");
    expect(await picker(stack, tv)).toMatchObject({ holder: max.userId });

    const again = await anonymous(stack).mutation(api.core.devices.approvals.request, {
      ...device,
      ask: { intent: "leave" },
    });

    expect(again.approvalId).not.toBe(asked.approvalId);
    expect(await picker(stack, tv)).toMatchObject({
      approval: { approvalId: again.approvalId, intent: "leave", state: "pending" },
    });
  });

  it("signs everyone out of a device when an admin changes its mode", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const dad = await listed.adult(await member(stack, "dad"));
    const tv = await sharedDevice(stack, admin);
    const dadTile = await openTile(stack, tv, dad.userId);

    const setMode = (mode: "personal" | "shared") =>
      admin.signedIn.client.mutation(api.core.devices.registry.setMode, {
        deviceId: tv.deviceId,
        mode,
      });

    await setMode("personal");

    expect(await refusal(dadTile.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await refusal(openTile(stack, tv, dad.userId))).toBe("forbidden");

    const laptop = await signInAs(stack, dad.person);

    await enroll(laptop, "Dad's laptop", tv.device);
    await setMode("shared");

    expect(await refusal(laptop.client.query(api.core.auth.sessions.current, {}))).toBe(
      "unauthenticated",
    );
    expect(await refusal(enroll(await signInAs(stack, dad.person), "x", tv.device))).toBe(
      "conflict",
    );
    expect(
      await refusal(
        dad.signedIn.client.mutation(api.core.devices.registry.setMode, {
          deviceId: tv.deviceId,
          mode: "personal",
        }),
      ),
    ).toBe("forbidden");

    await admin.signedIn.client.mutation(api.core.devices.registry.remove, {
      deviceId: tv.deviceId,
    });

    expect(await refusal(picker(stack, tv))).toBe("not_found");
  });

  it("refuses a person the shared devices do not list as having no tile, not as locked", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const stranger = await member(stack, "stranger");
    const tv = await sharedDevice(stack, admin);

    expect(await failureOf(openTile(stack, tv, stranger.userId))).toEqual({
      code: "not_found",
      message: NO_TILE,
    });
  });

  it("asks again once whoever approved has signed out everywhere", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const dad = await member(stack, "dad");
    await listed.kid(admin, await member(stack, "lily"));
    const tv = await sharedDevice(stack, admin);
    const phone = await signInAs(stack, dad.person);

    const setListed = async (who: SignedIn, listing: boolean) => {
      await who.client.mutation(api.core.devices.tiles.setListed, {
        userId: dad.userId,
        listed: listing,
      });
    };

    const ask = () =>
      anonymous(stack).mutation(api.core.devices.approvals.request, {
        device: tv.device,
        ask: { intent: "open", userId: dad.userId },
      });

    await setListed(dad.signedIn, true);

    try {
      const asked = await ask();

      await phone.client.mutation(api.core.devices.approvals.approve, {
        approvalId: asked.approvalId,
      });
      await phone.client.mutation(api.core.auth.sessions.endAll, { keepCurrent: false });

      const proof = { kind: "approval", approvalId: asked.approvalId } as const;

      expect(await refusal(openTile(stack, tv, dad.userId, proof))).toBe("expired");

      const again = await ask();

      expect(again.approvalId).not.toBe(asked.approvalId);
      expect(await picker(stack, tv)).toMatchObject({
        approval: { approvalId: again.approvalId, intent: "open", state: "pending" },
      });
    } finally {
      await setListed(await signInAs(stack, dad.person), false);
    }
  });

  it("shows every waiting prompt however many answered ones a person has", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const dad = await listed.adult(await member(stack, "dad"));
    await listed.kid(admin, await member(stack, "lily"));
    const tv = await sharedDevice(stack, admin);
    const den = await sharedDevice(stack, admin, "Den TV");

    const asked = await anonymous(stack).mutation(api.core.devices.approvals.request, {
      device: tv.device,
      ask: { intent: "open", userId: dad.userId },
    });

    importRows(
      "tileApprovals",
      Array.from({ length: 60 }, () => ({
        deviceId: den.deviceId,
        intent: "open" as const,
        userId: dad.userId,
        expiresAt: asked.expiresAt - 1000,
        state: "denied" as const,
        answeredBy: dad.userId,
      })),
    );

    expect(
      (await dad.signedIn.client.query(api.core.devices.approvals.pending, {})).map(
        (prompt) => prompt.approvalId,
      ),
    ).toContain(asked.approvalId);
  });

  it("gives a right unlock code its try back when the tile cannot open after all", async () => {
    if (stack === undefined) return;
    const admin = await sharedAdmin(stack);
    const lily = await listed.kid(admin, await member(stack, "lily"));
    const max = await listed.kid(admin, await member(stack, "max"));
    const tv = await sharedDevice(stack, admin);
    const code = "5307";

    await lily.signedIn.client.action(api.core.devices.unlockCodes.set, { code });

    const tryCode = (typed: string) =>
      refusal(openTile(stack, tv, lily.userId, { kind: "code", by: lily.userId, code: typed }));

    expect(await inOrder(["1111", "2222", "3333", "4444"], tryCode)).toEqual(
      Array.from({ length: 4 }, () => "unauthenticated"),
    );

    const watcher = new ConvexClient(stack.url, { logger: false });
    const maxOpens: Array<Promise<string>> = [];

    const stop = watcher.onUpdate(
      api.core.devices.picker.show,
      { device: tv.device },
      (shown: Picker) => {
        if (maxOpens.length === 0 && tileIn(shown, lily.userId).code === "off") {
          maxOpens.push(refusal(openTile(stack, tv, max.userId)));
        }
      },
    );

    try {
      expect(await tryCode(code)).toBe("forbidden");
      expect(await Promise.all(maxOpens)).toEqual(["accepted"]);
    } finally {
      stop();
      await watcher.close();
    }

    expect(await picker(stack, tv)).toMatchObject({ holder: max.userId });
    expect(tileIn(await picker(stack, tv), lily.userId).code).toBe("ready");
  });
});
