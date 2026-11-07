import { register } from "../../../commands/core/devices/approvals";
import type { Doc, Id } from "../../_generated/dataModel";
import type { DatabaseReader, MutationCtx, QueryCtx } from "../../_generated/server";
import type { Caller } from "../auth/caller";
import { callerUser } from "../auth/caller";
import { fail } from "../lib/errors";
import { PAGE_ROWS_MAX } from "../lib/paginate";
import { takeAttempt } from "../lib/rateLimit";
import { can, lockOf, proverOf } from "../permissions/policy";
import type { ApprovalResource, PersonDoc, Prover } from "../permissions/policy";
import { asPerson } from "../accounts/users";
import { liveSession } from "../sessions";
import type { SignedIn } from "../sessions";
import { NO_TILE, holderOf, listedPeople, releaseTile, requireSharedDevice, tileOf } from "./facts";
import type { SharedDevice } from "./facts";

/** How long an approval lives: the wait for an answer, then the wait to open the tile. */
const APPROVAL_MS = 2 * 60 * 1000;

const REQUESTS_PER_HOUR = 60;

const READS_PER_PROMPT = 3;

const PROMPT_LISTS = 2;

const PENDING_MAX = Math.floor(PAGE_ROWS_MAX / PROMPT_LISTS / READS_PER_PROMPT);

/** A device keeps one live approval; a read takes a few to clear stragglers too. */
const DEVICE_APPROVALS_READ = 8;

const NO_APPROVAL = "No such approval";

type Approval = Doc<"tileApprovals">;

/** What every state of an approval keeps. */
const fieldsOf = ({ deviceId, intent, userId, expiresAt }: Approval) => ({
  deviceId,
  intent,
  userId,
  expiresAt,
});

const approvalsOf = (db: DatabaseReader, deviceId: Id<"devices">) =>
  db
    .query("tileApprovals")
    .withIndex("by_device", (q) => q.eq("deviceId", deviceId))
    .take(DEVICE_APPROVALS_READ);

/** Deletes a device's approvals, when it stops being shared or is removed. */
export const dropApprovals = async (
  ctx: Pick<MutationCtx, "db">,
  deviceId: Id<"devices">,
): Promise<void> => {
  const approvals = await approvalsOf(ctx.db, deviceId);

  await Promise.all(approvals.map((approval) => ctx.db.delete(approval._id)));
};

/** The approval a device is waiting on or just got, unexpired, for its picker. */
export const currentApproval = async (
  db: DatabaseReader,
  deviceId: Id<"devices">,
  now: number,
): Promise<Approval | null> =>
  (await approvalsOf(db, deviceId)).find((approval) => approval.expiresAt > now) ?? null;

const resourceOf = (approval: Approval, answerer: PersonDoc): ApprovalResource => ({
  on: "approval",
  intent: approval.intent,
  userId: approval.userId,
  answererListed: answerer.sharedDevices === true,
});

const openable = (
  listed: ReadonlyArray<PersonDoc>,
  holder: Id<"users"> | null,
  userId: Id<"users">,
): Id<"users"> => {
  const person = listed.find((candidate) => candidate._id === userId) ?? fail("not_found", NO_TILE);
  const lock = lockOf(tileOf(person, listed, holder, null));

  if (lock.state === "open") return fail("conflict", "This tile opens without an approval");

  return lock.opensWith === "adult"
    ? fail("conflict", "A kid holds this device; ask an adult to let them leave first")
    : person._id;
};

const answerable = async (
  ctx: Pick<QueryCtx, "db">,
  caller: Caller,
  me: PersonDoc,
  approvalId: Id<"tileApprovals">,
): Promise<Approval> => {
  const approval = (await ctx.db.get(approvalId)) ?? fail("not_found", NO_APPROVAL);
  const decision = can(caller, "answer", resourceOf(approval, me));

  if (!decision.allowed) {
    return decision.refusal === "hidden"
      ? fail("not_found", NO_APPROVAL)
      : fail("forbidden", "Only an adult can let a kid leave a shared device");
  }

  return approval.expiresAt > Date.now()
    ? approval
    : fail("expired", "This approval has expired; the device can ask again");
};

const answered = (approval: Approval, me: PersonDoc): boolean =>
  approval.state !== "pending" && approval.answeredBy === me._id;

type Approved = Extract<Approval, { readonly state: "approved" }>;

const approverStillBacking = async (
  db: DatabaseReader,
  approval: Approved,
): Promise<PersonDoc | null> => {
  const approver = asPerson(await db.get(approval.answeredBy));

  return approver?.sessionGeneration === approval.generation ? approver : null;
};

/** What a tile sign-in with an approval proves, or the session a retry gets again. */
export type Redeemed =
  | { readonly kind: "prover"; readonly prover: Prover }
  | { readonly kind: "again"; readonly signedIn: SignedIn };

/**
 * Checks an `open` approval for `person`'s tile on `device`. An approved one proves its approver;
 * a redeemed one gives back its session while that session fills the slot, so a lost answer costs
 * only a retry. Fails with `pending`, `denied`, or `expired` otherwise.
 */
export const redeemable = async (
  ctx: Pick<QueryCtx, "db">,
  approvalId: Id<"tileApprovals">,
  device: SharedDevice,
  person: PersonDoc,
  now: number,
): Promise<Redeemed> => {
  const approval = await ctx.db.get(approvalId);

  if (
    approval === null ||
    approval.deviceId !== device._id ||
    approval.intent !== "open" ||
    approval.userId !== person._id
  ) {
    return fail("not_found", NO_APPROVAL);
  }

  if (approval.expiresAt <= now) return fail("expired", "This approval has expired; ask again");

  if (approval.state === "pending") return fail("pending", "Waiting for an approval");

  if (approval.state === "denied") return fail("denied", "This approval was refused");

  if (approval.state === "redeemed") {
    const again = await liveSession(ctx.db, approval.sessionId, now);

    return again === null
      ? fail("expired", "This approval was used; ask again")
      : { kind: "again", signedIn: { userId: person._id, sessionId: approval.sessionId } };
  }

  const approver = await approverStillBacking(ctx.db, approval);

  return approver === null
    ? fail("expired", "Whoever approved has signed out everywhere since; ask again")
    : { kind: "prover", prover: proverOf(approver) };
};

/** Marks an approved `open` approval used by the tile session it opened. */
export const markRedeemed = async (
  ctx: Pick<MutationCtx, "db">,
  approvalId: Id<"tileApprovals">,
  sessionId: Id<"authSessions">,
): Promise<void> => {
  const approval = await ctx.db.get(approvalId);

  if (approval?.state !== "approved") return;

  await ctx.db.replace(approval._id, {
    ...fieldsOf(approval),
    state: "redeemed",
    answeredBy: approval.answeredBy,
    sessionId,
  });
};

const nameOf = async (db: DatabaseReader, userId: Id<"users">): Promise<string | null> =>
  asPerson(await db.get(userId))?.username ?? null;

export const { request, pending, approve, deny } = register({
  request: async (ctx, { device: code, ask }) => {
    const device = await requireSharedDevice(ctx.db, code);
    const now = Date.now();
    const limit = { identifier: `approvals:${device._id}`, perHour: REQUESTS_PER_HOUR };

    if (!(await takeAttempt(ctx, limit, now))) {
      return fail("rate_limited", "This device asked too often; wait a few minutes");
    }

    const listed = await listedPeople(ctx.db);
    const holder = holderOf(device, listed);

    const userId =
      ask.intent === "leave"
        ? (holder ?? fail("conflict", "No kid holds this device"))
        : openable(listed, holder, ask.userId);

    const kept = await approvalsOf(ctx.db, device._id);

    const stands = async (approval: Approval): Promise<boolean> => {
      if (approval.intent !== ask.intent || approval.userId !== userId) return false;

      if (approval.expiresAt <= now) return false;

      if (approval.state === "pending") return true;

      return (
        approval.state === "approved" &&
        approval.intent === "open" &&
        (await approverStillBacking(ctx.db, approval)) !== null
      );
    };

    const standing = await Promise.all(kept.map(stands));
    const live = kept.find((_approval, index) => standing[index] === true);

    if (live !== undefined) return { approvalId: live._id, expiresAt: live.expiresAt };

    await Promise.all(kept.map((approval) => ctx.db.delete(approval._id)));

    const expiresAt = now + APPROVAL_MS;

    const approvalId = await ctx.db.insert("tileApprovals", {
      deviceId: device._id,
      intent: ask.intent,
      userId,
      expiresAt,
      state: "pending",
    });

    return { approvalId, expiresAt };
  },
  pending: async (ctx, _args, caller) => {
    const me = await callerUser(ctx, caller);
    const now = Date.now();

    const [mine, leaves] = await Promise.all([
      ctx.db
        .query("tileApprovals")
        .withIndex("by_user_intent_state_expiration", (q) =>
          q.eq("userId", me._id).eq("intent", "open").eq("state", "pending").gt("expiresAt", now),
        )
        .take(PENDING_MAX),
      ctx.db
        .query("tileApprovals")
        .withIndex("by_intent_state_expiration", (q) =>
          q.eq("intent", "leave").eq("state", "pending").gt("expiresAt", now),
        )
        .take(PENDING_MAX),
    ]);

    const open = [...mine, ...leaves].filter(
      (approval) => can(caller, "answer", resourceOf(approval, me)).allowed,
    );

    const prompts = await Promise.all(
      open.map(async (approval) => {
        const [device, username] = await Promise.all([
          ctx.db.get(approval.deviceId),
          nameOf(ctx.db, approval.userId),
        ]);

        return device === null || username === null
          ? []
          : [
              {
                approvalId: approval._id,
                intent: approval.intent,
                deviceName: device.name,
                userId: approval.userId,
                username,
                expiresAt: approval.expiresAt,
              },
            ];
      }),
    );

    return prompts.flat();
  },
  approve: async (ctx, { approvalId }, caller) => {
    const me = await callerUser(ctx, caller);
    const approval = await answerable(ctx, caller, me, approvalId);

    if (answered(approval, me) && approval.state !== "denied") return null;

    if (approval.state !== "pending") {
      return fail("conflict", "Someone already answered this approval");
    }

    if (approval.intent === "leave") {
      const device = await ctx.db.get(approval.deviceId);

      if (device?.mode === "shared" && device.tile?.userId === approval.userId) {
        await releaseTile(ctx, device);
      }
    }

    await ctx.db.replace(approval._id, {
      ...fieldsOf(approval),
      state: "approved",
      answeredBy: me._id,
      generation: me.sessionGeneration,
    });

    return null;
  },
  deny: async (ctx, { approvalId }, caller) => {
    const me = await callerUser(ctx, caller);
    const approval = await answerable(ctx, caller, me, approvalId);

    if (answered(approval, me) && approval.state === "denied") return null;

    if (approval.state !== "pending") {
      return fail("conflict", "Someone already answered this approval");
    }

    await ctx.db.replace(approval._id, {
      ...fieldsOf(approval),
      state: "denied",
      answeredBy: me._id,
    });

    return null;
  },
});
