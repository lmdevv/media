import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { fail } from "../lib/errors";
import { SERVER, accountTarget, can } from "./policy";
import type {
  AccountAction,
  AccountTarget,
  Because,
  PersonDoc,
  Principal,
  ServerAction,
} from "./policy";

const accountRefusal = (action: AccountAction, because: Because, target: AccountTarget): string => {
  if (because === "scope") {
    return action === "viewRestrictions"
      ? "Only an admin can see someone else's restrictions"
      : "Only an admin can change someone's account";
  }

  if (because === "actor") return "Only the owner hands over ownership";

  if (because === "self") {
    return action === "handOverOwnership"
      ? "You already own this server"
      : "Change your own account from your own settings";
  }

  if (because === "service-target") {
    return "A service principal holds no role, password, or restrictions";
  }

  if (because === "restricted-target") return "Lift this person's restrictions first";

  if (target.kind === "person" && target.role === "owner") {
    return "No admin can change the owner's account";
  }

  return action === "restrict"
    ? "Only a member can have restrictions"
    : "A guest's account follows the link that made it";
};

/**
 * Loads the account `userId` and decides `action` on it for `caller`, and returns the person's
 * row. A missing account fails `not_found`; a refusal fails `forbidden` and says why.
 */
export const requireAccount = async (
  ctx: Pick<QueryCtx, "db">,
  caller: Principal,
  action: AccountAction,
  userId: Id<"users">,
): Promise<PersonDoc> => {
  const user = (await ctx.db.get(userId)) ?? fail("not_found", "No such user");
  const target = accountTarget(user);
  const decision = can(caller, action, target);

  if (!decision.allowed) {
    return fail("forbidden", accountRefusal(action, decision.because, target.target));
  }

  return user.kind === "person"
    ? user
    : fail("forbidden", accountRefusal(action, "service-target", target.target));
};

/** Decides a server-wide action for `caller`; a refusal fails `forbidden`. Reads nothing. */
export const requireServer = (caller: Principal, action: ServerAction): void => {
  if (!can(caller, action, SERVER).allowed) fail("forbidden", "Only an admin can do this");
};
