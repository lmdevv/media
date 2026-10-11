/** Password sign-in against the dev backend, shared by the seed (Node) and the session page. */
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { Schema } from "effect";

const signInAction = makeFunctionReference<
  "action",
  { provider: string; params: Record<string, string> },
  unknown
>("auth:signIn");

const SignInResult = Schema.Struct({ tokens: Schema.Struct({ token: Schema.String }) });

const decodeSignIn = Schema.decodeUnknownSync(SignInResult);

/** The account the harness signs in with. */
export const harnessAccount = {
  email: "player-harness@example.com",
  password: "harness-password-1",
};

/** Signs in with the password provider, creating the account on first use. Returns a JWT. */
export const signIn = async (
  convexUrl: string,
  email: string,
  password: string,
): Promise<string> => {
  const client = new ConvexHttpClient(convexUrl);

  const attempt = async (flow: "signIn" | "signUp"): Promise<string | null> => {
    try {
      const result = await client.action(signInAction, {
        provider: "password",
        params: { email, password, flow, name: "Harness" },
      });

      return decodeSignIn(result).tokens.token;
    } catch {
      return null;
    }
  };

  const token = (await attempt("signIn")) ?? (await attempt("signUp"));

  if (token === null) throw new Error(`Could not sign in or sign up ${email}`);

  return token;
};
