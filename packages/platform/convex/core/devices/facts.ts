import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader, MutationCtx, QueryCtx } from "../../_generated/server";
import { fail } from "../lib/errors";
import { constantTimeEqual, rowForSecret } from "../lib/secrets";
import { asPerson } from "../accounts/users";
import { can, isKid, lockOf, principalOf, proverOf } from "../permissions/policy";
import type { Decision, PersonDoc, Principal, Prover, TileResource } from "../permissions/policy";
import { endSession } from "../sessions";

/** A device code is `dv_<deviceId>.<secret>`; the app keeps it and the core keeps its hash. */
export const DEVICE_PREFIX = "dv";

/** Most people the shared devices list. `setListed` holds the line, so a picker reads one range. */
export const LISTED_MAX = 50;

export const NO_DEVICE = "No such device";

export const NO_TILE = "No such tile on this device";

/** A device an admin made shared, with its tile slot. */
export type SharedDevice = Extract<Doc<"devices">, { readonly mode: "shared" }>;

/** The device a device code names, its secret compared in constant time; null for any other code. */
export const deviceOfCode = (db: DatabaseReader, code: string): Promise<Doc<"devices"> | null> =>
  rowForSecret(DEVICE_PREFIX, code, async (rowId) => {
    const id = db.normalizeId("devices", rowId);

    return id === null ? null : db.get(id);
  });

const asShared = (device: Doc<"devices"> | null): SharedDevice => {
  if (device === null) return fail("not_found", NO_DEVICE);

  return device.mode === "shared"
    ? device
    : fail("forbidden", "This device is personal, so it has no tiles to lock or open");
};

/** The shared device a code names; `not_found` for none, `forbidden` for a personal device. */
export const requireSharedDevice = async (
  db: DatabaseReader,
  code: string,
): Promise<SharedDevice> => asShared(await deviceOfCode(db, code));

/** `requireSharedDevice` by row id and secret hash, for a mutation an action runs after hashing. */
export const sharedDeviceById = async (
  db: DatabaseReader,
  deviceId: string,
  secretHash: string,
): Promise<SharedDevice> => {
  const id = db.normalizeId("devices", deviceId);
  const device = id === null ? null : await db.get(id);

  return asShared(
    device !== null && constantTimeEqual(device.secretHash, secretHash) ? device : null,
  );
};

/** Everyone the shared devices list, by username. Every shared device lists the same people. */
export const listedPeople = async (db: DatabaseReader): Promise<ReadonlyArray<PersonDoc>> => {
  const rows = await db
    .query("users")
    .withIndex("by_shared_devices", (q) => q.eq("sharedDevices", true))
    .take(LISTED_MAX);

  return rows.flatMap((row) => (row.kind === "person" ? [row] : []));
};

/** The kid who holds `device`: the person in its slot while they are a listed kid, read live. */
export const holderOf = (
  device: SharedDevice,
  listed: ReadonlyArray<PersonDoc>,
): Id<"users"> | null =>
  listed.find((person) => person._id === device.tile?.userId && isKid(person))?._id ?? null;

/** `person`'s tile on a device that `listed` and `holder` describe, opened with `proof`. */
export const tileOf = (
  person: PersonDoc,
  listed: ReadonlyArray<PersonDoc>,
  holder: Id<"users"> | null,
  proof: Prover | null,
): TileResource => ({
  on: "tile",
  person: { ...proverOf(person), lockRequired: person.tileLock === true },
  kidListed: listed.some(isKid),
  holder,
  proof,
});

/** The person whose tile a sign-in names. */
export const tilePerson = async (db: DatabaseReader, userId: Id<"users">): Promise<PersonDoc> =>
  asPerson(await db.get(userId)) ?? fail("not_found", NO_TILE);

const lockedMessage = (tile: TileResource): string => {
  const lock = lockOf(tile);

  if (lock.state === "locked" && lock.opensWith === "adult") {
    return "An adult approves leaving a kid's tile, or proves who they are for this one";
  }

  return "This tile is locked; type the password or unlock code, or approve from another device";
};

/**
 * Decides opening `person`'s tile on `device` with a proof by `prover`, or with none. An unlisted
 * person fails `not_found`, and a lock the proof does not lift fails `forbidden`.
 */
export const requireOpen = async (
  db: DatabaseReader,
  device: SharedDevice,
  person: PersonDoc,
  prover: Prover | null,
): Promise<void> => {
  const listed = await listedPeople(db);
  const tile = tileOf(person, listed, holderOf(device, listed), prover);
  const decision = can(principalOf(person), "open", tile);

  if (decision.allowed) return;

  fail(decision.refusal === "hidden" ? "not_found" : "forbidden", lockedMessage(tile));
};

const tileRefusal = (decision: Extract<Decision, { readonly allowed: false }>): never => {
  if (decision.because === "kid-lock") {
    return fail("forbidden", "A kid uses shared devices, so this tile stays locked");
  }

  if (decision.because === "target-role") return fail("forbidden", "A guest has no tile");

  return fail("forbidden", "Only an admin can lock or unlock someone's tile");
};

/**
 * Loads `userId` and decides an admin's `lock` or `unlock` of their tile, and returns the person.
 * Lifting the lock fails `forbidden` while a listed kid locks the tile.
 */
export const requireTile = async (
  ctx: Pick<QueryCtx, "db">,
  caller: Principal,
  action: "lock" | "unlock",
  userId: Id<"users">,
): Promise<PersonDoc> => {
  const user = (await ctx.db.get(userId)) ?? fail("not_found", "No such user");

  if (user.kind !== "person") return fail("forbidden", "A service has no tile");

  const decision = can(caller, action, tileOf(user, await listedPeople(ctx.db), null, null));

  return decision.allowed ? user : tileRefusal(decision);
};

/** Puts a new tile session in the device's slot and ends the session the slot held. */
export const occupyTile = async (
  ctx: Pick<MutationCtx, "db">,
  device: SharedDevice,
  tile: { readonly userId: Id<"users">; readonly sessionId: Id<"authSessions"> },
): Promise<void> => {
  await ctx.db.patch(device._id, { tile });

  if (device.tile !== null && device.tile.sessionId !== tile.sessionId) {
    await endSession(ctx, device.tile.sessionId);
  }
};

/** Empties the device's slot, which ends its tile session and any kid's hold. */
export const releaseTile = async (
  ctx: Pick<MutationCtx, "db">,
  device: SharedDevice,
): Promise<void> => {
  if (device.tile === null) return;

  await ctx.db.patch(device._id, { tile: null });
  await endSession(ctx, device.tile.sessionId);
};
