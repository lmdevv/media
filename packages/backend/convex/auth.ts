import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { convexAuth, createAccount, retrieveAccount } from "@convex-dev/auth/server";
import type { ConvexAuthConfig } from "@convex-dev/auth/server";
import { makeFunctionReference } from "convex/server";
import { v } from "convex/values";
import type { Value } from "convex/values";
import { Scrypt } from "lucia";

import { internal } from "./_generated/api";
import { action } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { PASSWORD_MIN } from "./lib/bounds";
import { fail } from "./lib/errors";

type SignInParams = Partial<Record<string, Value | undefined>>;

interface PasswordParams {
  readonly flow: "signUp" | "signIn";
  readonly email: string;
  readonly password: string;
  readonly name?: string;
  readonly inviteCode?: string;
}

type SignUpProfile = {
  email: string;
  role: "member";
  name?: string;
  inviteCode?: string;
};

interface Redeemed {
  readonly userId: Id<"users">;
  readonly sessionId: Id<"authSessions">;
}

const parsePasswordParams = makeFunctionReference<"query", SignInParams, PasswordParams>(
  "authParams:password",
);

const redeemApiKey = makeFunctionReference<"mutation", SignInParams, Redeemed | null>(
  "apiKeys:redeem",
);

const redeemDeviceCode = makeFunctionReference<"mutation", SignInParams, Redeemed | null>(
  "deviceAuth:redeem",
);

type CallbackProfile = Parameters<
  NonNullable<NonNullable<ConvexAuthConfig["callbacks"]>["createOrUpdateUser"]>
>[1]["profile"];

const createUserFromSignUp = makeFunctionReference<"mutation", CallbackProfile, Id<"users">>(
  "users:createFromSignUp",
);

const parseUsernameParams = makeFunctionReference<
  "query",
  SignInParams,
  { readonly flow: "signUp" | "signIn"; readonly username: string; readonly password: string }
>("authParams:username");

const createCoreUser = makeFunctionReference<"mutation", CallbackProfile, Id<"users">>(
  "core/users:createFromUsername",
);

const scrypt = new Scrypt();

const signUpProfile = (email: string, parsed: PasswordParams): SignUpProfile => {
  const profile: SignUpProfile = { email, role: "member" };

  if (parsed.name !== undefined) profile.name = parsed.name;

  if (parsed.inviteCode !== undefined) profile.inviteCode = parsed.inviteCode;

  return profile;
};

const signInFailure = (cause: unknown): never => {
  const reason = cause instanceof Error ? cause.message : "";

  if (reason === "TooManyFailedAttempts") {
    return fail("rate_limited", "Too many failed sign-ins; wait a few minutes and try again");
  }

  return fail("unauthenticated", "Wrong email or password");
};

const convexAuthFunctions = convexAuth({
  providers: [
    ConvexCredentials({
      id: "password",
      authorize: async (params, ctx) => {
        const parsed = await ctx.runQuery(parsePasswordParams, params);
        const email = parsed.email.trim().toLowerCase();

        if (parsed.flow === "signIn") {
          const retrieved = await retrieveAccount(ctx, {
            provider: "password",
            account: { id: email, secret: parsed.password },
          }).catch(signInFailure);

          return { userId: retrieved.user._id };
        }

        if (parsed.password.length < PASSWORD_MIN) {
          return fail("invalid_args", `Use at least ${PASSWORD_MIN} characters for the password`);
        }

        const { user } = await createAccount(ctx, {
          provider: "password",
          account: { id: email, secret: parsed.password },
          profile: signUpProfile(email, parsed),
          shouldLinkViaEmail: false,
          shouldLinkViaPhone: false,
        });

        return { userId: user._id };
      },
      crypto: {
        hashSecret: (password) => scrypt.hash(password),
        verifySecret: (password, hash) => scrypt.verify(hash, password),
      },
    }),
    ConvexCredentials({
      id: "username",
      authorize: async (params, ctx) => {
        const parsed = await ctx.runQuery(parseUsernameParams, params);
        const username = parsed.username.trim();
        const secret = parsed.password;
        const key = username.toLowerCase();

        if (parsed.flow === "signIn") {
          const retrieved = await retrieveAccount(ctx, {
            provider: "username",
            account: { id: key, secret },
          }).catch(signInFailure);

          return { userId: retrieved.user._id };
        }

        const { user } = await createAccount(ctx, {
          provider: "username",
          account: { id: key, secret },
          profile: { username, usernameKey: key },
          shouldLinkViaEmail: false,
          shouldLinkViaPhone: false,
        });

        return { userId: user._id };
      },
      crypto: {
        hashSecret: (password) => scrypt.hash(password),
        verifySecret: (password, hash) => scrypt.verify(hash, password),
      },
    }),
    ConvexCredentials({
      id: "apikey",
      authorize: (params, ctx) => ctx.runMutation(redeemApiKey, params),
    }),
    ConvexCredentials({
      id: "device",
      authorize: (params, ctx) => ctx.runMutation(redeemDeviceCode, params),
    }),
  ],
  callbacks: {
    createOrUpdateUser: async (ctx, args) => {
      if (args.existingUserId !== null) return args.existingUserId;

      if (args.provider.id === "username") {
        return ctx.runMutation(createCoreUser, args.profile);
      }

      return ctx.runMutation(createUserFromSignUp, args.profile);
    },
    beforeSessionCreation: async (ctx, { userId }) => {
      await ctx.runQuery(internal.users.assertCanSignIn, { userId });
    },
  },
});

export const { auth, signIn, store, isAuthenticated } = convexAuthFunctions;

/**
 * Signs out as Convex Auth's own `signOut` does (the session and its refresh tokens go), and also
 * ends the playback sessions it started, so the media service stops their streams at once instead
 * of when the idle sweep notices.
 */
export const signOut = action({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(internal.sessions.endCurrent, {});

    return null;
  },
});
