import type { DatabaseReader } from "../../_generated/server";
import type { Reach } from "../permissions/grants";
import { contentAs } from "../permissions/items";
import type { ShareTargetFacts } from "../permissions/policy";
import { factsOf, memberIn, placeOf } from "../together/access";
import type { StoredTarget } from "./model";

/**
 * What `target` names, as the principal of `makerReach` reaches it now: an item at their grants'
 * level with its facts, or the group session with where they stand in it.
 */
export const targetAs = async (
  db: DatabaseReader,
  makerReach: Reach,
  target: StoredTarget,
): Promise<ShareTargetFacts> => {
  if (target.kind === "item") {
    return { kind: "item", content: await contentAs(db, makerReach, target.item) };
  }

  const makerId = makerReach.principal.userId;
  const session = await db.get(target.sessionId);

  return {
    kind: "session",
    session:
      session === null
        ? { on: "together", domain: target.domain, session: null }
        : factsOf(session, placeOf(session, makerId, await memberIn(db, makerId, target.domain))),
  };
};
