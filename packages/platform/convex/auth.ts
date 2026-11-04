import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { convexAuth, createAccount, retrieveAccount } from "@convex-dev/auth/server";
import type { ConvexAuthConfig } from "@convex-dev/auth/server";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { Scrypt } from "lucia";

import type { Id } from "./_generated/dataModel";

type SignInParams = Partial<Record<string, Value | undefined>>;

type CallbackProfile = Parameters<
  NonNullable<NonNullable<ConvexAuthConfig["callbacks"]>["createOrUpdateUser"]>
>[1]["profile"];

const parseUsernameParams = makeFunctionReference<
  "query",
  SignInParams,
  { readonly flow: "signUp" | "signIn"; readonly username: string; readonly password: string }
>("authParams:username");

const createUser = makeFunctionReference<"mutation", CallbackProfile, Id<"users">>(
  "core/users:createFromUsername",
);

const scrypt = new Scrypt();

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    ConvexCredentials({
      id: "username",
      authorize: async (params, ctx) => {
        const parsed = await ctx.runQuery(parseUsernameParams, params);
        const username = parsed.username.trim();
        const key = username.toLowerCase();

        if (parsed.flow === "signIn") {
          const retrieved = await retrieveAccount(ctx, {
            provider: "username",
            account: { id: key, secret: parsed.password },
          });

          return { userId: retrieved.user._id };
        }

        const { user } = await createAccount(ctx, {
          provider: "username",
          account: { id: key, secret: parsed.password },
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
  ],
  callbacks: {
    createOrUpdateUser: async (ctx, args) => {
      if (args.existingUserId !== null) return args.existingUserId;

      return ctx.runMutation(createUser, args.profile);
    },
  },
});
