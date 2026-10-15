import { assignableRoles } from "@music/commands/permissions";

import type { Doc } from "../_generated/dataModel";
import { roleOf } from "./viewer";

/**
 * Whether an invite still carries its sender's authority: an invite from someone since removed,
 * suspended, or demoted below the role it gives no longer works.
 */
export const inviterStillAllows = (inviter: Doc<"users"> | null, invite: Doc<"invites">): boolean =>
  inviter !== null &&
  inviter.suspendedAt === undefined &&
  assignableRoles(roleOf(inviter)).includes(invite.role);
