import { register } from "../../commands/core/guests";
import { asPerson } from "./accounts/users";
import { callerUser } from "./auth/caller";
import { guestAccessOf, requireGuestAddress, shownTarget } from "./guests/model";
import { guestLinkOf, newLinkStanding } from "./guests/standing";
import { fail } from "./lib/errors";
import { requireAccount, requireServer } from "./permissions/authorize";
import { can } from "./permissions/policy";
import { endUserSessions } from "./sessions";

export const { status, configure, allow, current } = register({
  status: async (ctx, _args, caller) => {
    const [access, me] = await Promise.all([guestAccessOf(ctx.db), callerUser(ctx, caller)]);

    const offer = can(caller, "offer", {
      ...newLinkStanding(access, caller, me),
      about: { kind: "standing" },
    });

    return { enabled: access.enabled, address: access.address, mayShare: offer.allowed };
  },
  configure: async (ctx, { enabled, address }, caller) => {
    requireServer(caller, "configureGuests");

    const stored = address === null ? null : requireGuestAddress(address);

    if (enabled && stored === null) {
      return fail("invalid_args", "Set the guest address before turning guest links on");
    }

    const row = await ctx.db.query("guestAccess").first();
    const epoch = row?.enabled === true && !enabled ? row.epoch + 1 : (row?.epoch ?? 0);
    const next = { enabled, epoch, address: stored };

    if (row === null) await ctx.db.insert("guestAccess", next);
    else if (row.enabled !== enabled || row.address !== stored) await ctx.db.patch(row._id, next);

    return null;
  },
  allow: async (ctx, { userId, allowed }, caller) => {
    const person = await requireAccount(ctx, caller, "allowSharing", userId);

    if (person.role !== "member") return fail("forbidden", "Only a member is allowed to share");

    if (allowed === (person.sharesWithGuests === true)) return null;

    await ctx.db.patch(person._id, { sharesWithGuests: allowed ? true : undefined });

    if (!allowed) await endUserSessions(ctx, person);

    return null;
  },
  current: async (ctx, _args, caller) => {
    const me = await callerUser(ctx, caller);

    if (me.role !== "guest") return null;

    const found = await guestLinkOf(ctx.db, me, Date.now());

    if (found === null) return fail("unauthenticated", "This share link no longer works");

    const { link } = found;
    const maker = asPerson(await ctx.db.get(link.maker));

    return {
      name: me.username,
      sharedBy: maker?.username ?? "",
      target: shownTarget(link.target),
      expiresAt: link.expiresAt,
    };
  },
});
