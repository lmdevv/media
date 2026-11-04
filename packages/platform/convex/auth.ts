import { convexAuth } from "@convex-dev/auth/server";

import { apiKeyProvider } from "./core/auth/apiKeys";
import { deviceCodeProvider } from "./core/auth/deviceCodes";
import { passwordProvider } from "./core/auth/password";
import { JWT_MS, SESSION_MS } from "./core/sessions";

const openedByTheCore = (): never => {
  throw new Error("The core opens every session and creates every user (core/sessions.ts)");
};

/**
 * Convex Auth v1, at the path the library calls (`auth:store`). `isAuthenticated` is not exported:
 * it trusts the JWT alone.
 */
export const { auth, signIn, signOut, store } = convexAuth({
  providers: [passwordProvider, apiKeyProvider, deviceCodeProvider],
  session: { totalDurationMs: SESSION_MS, inactiveDurationMs: SESSION_MS },
  jwt: { durationMs: JWT_MS },
  callbacks: {
    createOrUpdateUser: async () => openedByTheCore(),
    beforeSessionCreation: async () => openedByTheCore(),
  },
});
