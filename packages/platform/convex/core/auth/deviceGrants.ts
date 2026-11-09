import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Value } from "convex/values";

import { internal } from "../../_generated/api";
import type { DataModel } from "../../_generated/dataModel";
import { internalQuery } from "../../_generated/server";
import { BAD_GRANT, GRANT_PREFIX } from "../devices/deviceGrants";
import { fail } from "../lib/errors";
import { parseSecret, sha256Hex } from "../lib/secrets";
import type { SignedIn } from "../sessions";

const grantParams = { userId: v.string(), grant: v.string() };

const parseGrantParams = makeFunctionReference<
  "query",
  Partial<Record<string, Value | undefined>>,
  { readonly userId: string; readonly grant: string }
>("core/auth/deviceGrants:parse");

/** Checks the sign-in params' shape. */
export const parse = internalQuery({
  args: grantParams,
  returns: v.object(grantParams),
  handler: (_ctx, args) => args,
});

/**
 * The `grant` provider (D48): an app presents its device's grant and the person the device's
 * keychain names, and gets a session of its own. Every refusal is one `unauthenticated` message,
 * whether the grant is malformed, unknown, tampered, another person's, revoked, or stale.
 */
export const grantProvider = ConvexCredentials<DataModel>({
  id: "grant",
  authorize: async (params, ctx): Promise<SignedIn> => {
    const { userId, grant } = await ctx.runQuery(parseGrantParams, params);
    const parsed = parseSecret(GRANT_PREFIX, grant.trim());

    if (parsed === null) return fail("unauthenticated", BAD_GRANT);

    const opened: SignedIn | null = await ctx.runMutation(
      internal.core.devices.deviceGrants.redeem,
      {
        userId,
        grantId: parsed.rowId,
        secretHash: await sha256Hex(parsed.secret),
      },
    );

    return opened ?? fail("unauthenticated", BAD_GRANT);
  },
});
