import { convexAuth } from "@convex-dev/auth/server";
import type { RegisteredMutation } from "convex/server";

import { internal } from "./_generated/api";
import { internalMutation } from "./_generated/server";

import { apiKeyProvider } from "./core/auth/apiKeys";
import { deviceCodeProvider } from "./core/auth/deviceCodes";
import { grantProvider } from "./core/auth/deviceGrants";
import { guestProvider, inviteProvider, resetProvider, setupProvider } from "./core/auth/flows";
import { passwordProvider } from "./core/auth/password";
import { decideRefresh, signOutCaller, storeCall } from "./core/auth/store";
import { tileProvider } from "./core/auth/tiles";
import { JWT_MS, SESSION_MS } from "./core/sessions";

const openedByTheCore = (): never => {
  throw new Error("The core opens every session and creates every user (core/sessions.ts)");
};

/**
 * Convex Auth v1. `isAuthenticated` is not exported: it trusts the JWT alone. The library's store
 * sits at `auth:libraryStore`, behind `store`.
 */
export const {
  auth,
  signIn,
  signOut,
  store: libraryStore,
} = convexAuth({
  providers: [
    passwordProvider,
    apiKeyProvider,
    deviceCodeProvider,
    setupProvider,
    inviteProvider,
    resetProvider,
    tileProvider,
    guestProvider,
    grantProvider,
  ],
  session: { totalDurationMs: SESSION_MS, inactiveDurationMs: SESSION_MS },
  jwt: { durationMs: JWT_MS },
  callbacks: {
    createOrUpdateUser: async () => openedByTheCore(),
    beforeSessionCreation: async () => openedByTheCore(),
  },
});

/** What the library's store answers, which its callers read. */
type StoreAnswer =
  typeof libraryStore extends RegisteredMutation<"internal", infer _Args, infer Answer>
    ? Awaited<Answer>
    : never;

/**
 * The path the library calls (`auth:store`). It ends sessions itself where the library would read
 * every refresh token of a session in one call (`core/auth/store.ts`), and hands the rest to the
 * library's store in the same transaction.
 */
export const store = internalMutation({
  args: { args: storeCall },
  handler: async (ctx, { args }): Promise<StoreAnswer> => {
    if (args.type === "signOut") return signOutCaller(ctx);

    if (
      args.type === "refreshSession" &&
      (await decideRefresh(ctx, args.refreshToken)) === "answered"
    ) {
      return null;
    }

    return ctx.runMutation(internal.auth.libraryStore, { args });
  },
});
