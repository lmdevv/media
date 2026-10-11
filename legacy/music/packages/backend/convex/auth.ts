import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { Password } from "@convex-dev/auth/providers/Password";
import { convexAuth } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { Result, Schema } from "effect";

import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { sha256Hex } from "./lib/crypto";

const SignUpParams = Schema.Struct({
  email: Schema.Trimmed.check(Schema.isMinLength(3)),
  name: Schema.optionalKey(Schema.Trimmed),
  inviteCode: Schema.optionalKey(Schema.Trimmed),
});

const decodeSignUpParams = Schema.decodeUnknownResult(SignUpParams);

const SignUpProfile = Schema.Struct({
  email: Schema.String,
  name: Schema.optionalKey(Schema.String),
  inviteCode: Schema.optionalKey(Schema.String),
});

const decodeSignUpProfile = Schema.decodeUnknownResult(SignUpProfile);

const ApiKeyCredentials = Schema.Struct({ key: Schema.String.check(Schema.isMinLength(20)) });

const decodeApiKeyCredentials = Schema.decodeUnknownResult(ApiKeyCredentials);

const invalid = (message: string): never => {
  throw new ConvexError({ code: "invalid_args", message });
};

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password<DataModel>({
      profile: (params) => {
        const parsed = decodeSignUpParams(params);

        if (Result.isFailure(parsed)) return invalid("Enter an email address");
        const { email, name, inviteCode } = parsed.success;

        return {
          email: email.toLowerCase(),
          name: name === undefined || name.length === 0 ? undefined : name,
          inviteCode: inviteCode === undefined || inviteCode.length === 0 ? undefined : inviteCode,
        };
      },
      validatePasswordRequirements: (password) => {
        if (password.length < 8) invalid("Use at least 8 characters for the password");
      },
    }),
    ConvexCredentials<DataModel>({
      id: "apikey",
      authorize: async (credentials, ctx) => {
        const parsed = decodeApiKeyCredentials(credentials);

        if (Result.isFailure(parsed)) return null;
        const hash = await sha256Hex(parsed.success.key);

        return ctx.runMutation(internal.apiKeys.redeem, { hash });
      },
    }),
  ],
  callbacks: {
    createOrUpdateUser: async (ctx, args) => {
      if (args.existingUserId !== null) return args.existingUserId;
      const profile = decodeSignUpProfile(args.profile);

      if (Result.isFailure(profile)) return invalid("Sign-up details are incomplete");

      return ctx.runMutation(internal.users.createFromSignUp, profile.success);
    },
  },
});
