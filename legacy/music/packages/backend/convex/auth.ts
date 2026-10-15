import { ConvexCredentials } from "@convex-dev/auth/providers/ConvexCredentials";
import { convexAuth, retrieveAccount } from "@convex-dev/auth/server";
import { ConvexError } from "convex/values";
import { Scrypt } from "lucia";
import { OptionalName, Text, cleanText } from "@music/commands/text";
import { Result, Schema } from "effect";

import { internal } from "./_generated/api";
import type { DataModel } from "./_generated/dataModel";
import { sha256Hex } from "./lib/crypto";
import { SUSPENDED_MESSAGE } from "./lib/viewer";

/** The provider ID stored on every password account; it must never change. */
const PASSWORD = "password";

/**
 * A new account's email, cleaned like any typed text: an account without a name shows the part
 * before the `@`. Sign-in looks an email up as typed (`Email`), so an account made before the
 * cleaning still finds its own.
 */
const NewEmail = Text.check(Schema.isMinLength(3));

const Email = Schema.Trimmed.check(Schema.isMinLength(3));

/**
 * The password provider's flows. `signUp` and `signIn` match Convex Auth's `Password` provider;
 * `reset` redeems an admin's reset link (see `passwordResets.ts`) instead of an emailed code.
 */
const PasswordParams = Schema.Union([
  Schema.Struct({
    flow: Schema.Literal("signUp"),
    email: NewEmail,
    password: Schema.String,
    name: Schema.optionalKey(OptionalName),
    inviteCode: Schema.optionalKey(Schema.Trimmed),
    /** A Jam link's code: makes a guest account to join it, when the server allows that. */
    jamCode: Schema.optionalKey(Schema.Trimmed),
  }),
  Schema.Struct({ flow: Schema.Literal("signIn"), email: Email, password: Schema.String }),
  Schema.Struct({
    flow: Schema.Literal("reset"),
    token: Schema.String,
    newPassword: Schema.String,
  }),
]);

const decodePasswordParams = Schema.decodeUnknownResult(PasswordParams);

const SignUpProfile = Schema.Struct({
  email: Schema.String,
  name: Schema.optionalKey(Schema.String),
  inviteCode: Schema.optionalKey(Schema.String),
  jamCode: Schema.optionalKey(Schema.String),
});

const decodeSignUpProfile = Schema.decodeUnknownResult(SignUpProfile);

const ApiKeyCredentials = Schema.Struct({ key: Schema.String.check(Schema.isMinLength(20)) });

const decodeApiKeyCredentials = Schema.decodeUnknownResult(ApiKeyCredentials);

/** The stored password hash of an account `retrieveAccount` returned. */
const decodeSecret = Schema.decodeUnknownResult(Schema.String);

const invalid = (message: string): never => {
  throw new ConvexError({ code: "invalid_args", message });
};

const checkPassword = (password: string): void => {
  if (password.length < 8) invalid("Use at least 8 characters for the password");
};

/** Empty optional fields from a form mean "not given". */
const given = (value: string | undefined): string | undefined =>
  value === undefined || value.length === 0 ? undefined : value;

/**
 * Hashes passwords as Convex Auth's `Password` provider does (Lucia's Scrypt), so accounts made
 * before this provider replaced it keep signing in.
 */
const scrypt = new Scrypt();

/**
 * A Scrypt hash of a phrase no account uses, to verify against when the account does not exist,
 * so that path does the same work as a wrong password. Made on first use (hashing needs
 * randomness, which a module may not use while it loads) and kept for the process.
 */
interface DummyHash {
  hash?: Promise<string>;
}

const dummy: DummyHash = {};

const dummyHash = (): Promise<string> => {
  dummy.hash ??= scrypt.hash("no account has this password");

  return dummy.hash;
};

/** What every failed password sign-in says, whether the email or the password was wrong. */
const INVALID_CREDENTIALS = "Invalid email or password";

const RATE_LIMITED_MESSAGE = "Too many failed sign-ins. Wait a few minutes and try again.";

const invalidCredentials = (): never => {
  throw new ConvexError({ code: "unauthenticated", message: INVALID_CREDENTIALS });
};

/**
 * Email and password accounts. It replaces Convex Auth's `Password` provider, which cannot refuse
 * a suspended account or take a reset link without email; everything else matches it.
 */
const password = ConvexCredentials<DataModel>({
  id: PASSWORD,
  authorize: async (params, ctx) => {
    const parsed = decodePasswordParams(params);

    if (Result.isFailure(parsed)) return invalid("Enter an email address and a password");
    const input = parsed.success;

    if (input.flow === "signUp") {
      checkPassword(input.password);
      const email = input.email.toLowerCase();

      const profile: Partial<Record<"name" | "inviteCode" | "jamCode", string>> & {
        email: string;
      } = { email };

      const name = given(input.name);
      const inviteCode = given(input.inviteCode);
      const jamCode = given(input.jamCode);

      if (name !== undefined) profile.name = name;

      if (inviteCode !== undefined) profile.inviteCode = inviteCode;

      if (jamCode !== undefined) profile.jamCode = jamCode;

      // Convex Auth's `createAccount` signs in an existing account when the password matches,
      // without the sign-in rate limit: sign-up would be an unlimited password oracle, and a way
      // around suspension. So the account is made here, in one transaction with the check that
      // the email has none (two sign-ups at once can't both pass it), and an existing email is
      // refused like any failed sign-in, but only after the invite checks pass, so that without
      // a valid invite every email reads alike.
      const userId = await ctx.runMutation(internal.users.createPasswordAccount, {
        ...profile,
        provider: PASSWORD,
        secret: await scrypt.hash(input.password),
      });

      if (userId === null) return invalidCredentials();

      return { userId };
    }

    if (input.flow === "signIn") {
      // Sign-up keeps an email cleaned (`NewEmail`); one made before that keeps it as typed.
      const typed = input.email.toLowerCase();

      const id = await ctx.runQuery(internal.users.signInAccountId, {
        provider: PASSWORD,
        typed,
        cleaned: cleanText(typed),
      });

      // Fails on a wrong password before anything reveals that the account is suspended.
      const { account, user } = await retrieveAccount(ctx, {
        provider: PASSWORD,
        account: { id, secret: input.password },
      }).catch(async (cause: unknown) => {
        const reason = cause instanceof Error ? cause.message : "";

        if (reason === "TooManyFailedAttempts") {
          throw new ConvexError({ code: "rate_limited", message: RATE_LIMITED_MESSAGE });
        }

        // An unknown email costs the same hash check as a wrong password, so timing does not
        // tell them apart either.
        if (reason === "InvalidAccountId") await scrypt.verify(await dummyHash(), input.password);

        return invalidCredentials();
      });

      if (user.suspendedAt !== undefined) {
        throw new ConvexError({ code: "forbidden", message: SUSPENDED_MESSAGE });
      }

      // The session opens in its own transaction with a second look at the password, rather than
      // in Convex Auth's later one, so a reset landing after the check leaves no session behind.
      const secret = decodeSecret(account.secret);

      // A password account always has a secret; one without can't have passed the check.
      if (Result.isFailure(secret)) return invalidCredentials();

      const opened = await ctx.runMutation(internal.users.openPasswordSession, {
        accountId: account._id,
        secret: secret.success,
      });

      if (opened.kind === "suspended") {
        throw new ConvexError({ code: "forbidden", message: SUSPENDED_MESSAGE });
      }

      if (opened.kind === "changed") return invalidCredentials();

      return { userId: opened.userId, sessionId: opened.sessionId };
    }

    checkPassword(input.newPassword);

    // One transaction checks the link and who may use it, sets the password on the person's own
    // account, ends their sessions, and opens the one this sign-in gets, so nothing can change
    // in between.
    return ctx.runMutation(internal.passwordResets.redeem, {
      hash: await sha256Hex(input.token),
      provider: PASSWORD,
      secret: await scrypt.hash(input.newPassword),
    });
  },
  crypto: {
    hashSecret: (secret) => scrypt.hash(secret),
    verifySecret: (secret, hash) => scrypt.verify(hash, secret),
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    password,
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
