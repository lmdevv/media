import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { Schema } from "effect";

import type { AssignableRole } from "../commands/scopes";
import { api, internal } from "../convex/_generated/api";
import { runFunction } from "./admin";
import type { CoreStack } from "./stack-env";

/** A person's credentials. */
export interface Person {
  readonly username: string;
  readonly password: string;
}

/** A client signed in through `auth:signIn`, with the JWT it holds. */
export interface SignedIn {
  readonly client: ConvexHttpClient;
  readonly token: string;
  readonly refreshToken: string;
}

const Token = Schema.Struct({ token: Schema.String, refreshToken: Schema.String });

const decodeTokens = Schema.decodeUnknownSync(Token);

/** A short random suffix for usernames and passwords no other test uses. */
export const unique = (): string => Math.random().toString(36).slice(2, 10);

const setUps = new Map<string, Promise<void>>();

const setUpOnce = async (stack: CoreStack): Promise<void> => {
  const anonymous = new ConvexHttpClient(stack.url, { logger: false });

  if ((await anonymous.query(api.core.server.info, {})).hasOwner) return;

  const setUp = signIn(stack, "setup", {
    username: `owner-${unique()}`,
    password: `password-${unique()}`,
  });

  const outcome = await refusal(setUp);

  if (outcome !== "accepted" && outcome !== "conflict") {
    throw new Error(`Setting up the stack's owner answered ${outcome}`);
  }
};

/**
 * Sets the stack's server up with an owner nobody keeps the password of, unless it has one. Test
 * files run this in parallel on a fresh stack, and exactly one setup wins.
 */
export const ensureOwner = (stack: CoreStack): Promise<void> => {
  const setUp = setUps.get(stack.url) ?? setUpOnce(stack);

  setUps.set(stack.url, setUp);

  return setUp;
};

/** Creates a member, or a user with `role`, with the deployment's admin key. */
export const createPerson = async (
  stack: CoreStack,
  label = "person",
  role: AssignableRole = "member",
): Promise<Person> => {
  const person = { username: `${label}-${unique()}`, password: `password-${unique()}` };

  await ensureOwner(stack);
  await runFunction(
    stack,
    internal.core.accounts.host.createUser,
    { ...person, role },
    Schema.String,
  );

  return person;
};

/**
 * Takes over the stack's owner, whoever it is now, with the host reset, and signs in as them. It
 * ends the owner's other sessions, so only one test file may call it.
 */
export const claimOwner = async (
  stack: CoreStack,
): Promise<{ readonly person: Person; readonly signedIn: SignedIn }> => {
  const password = `password-${unique()}`;

  await ensureOwner(stack);

  const { username } = await runFunction(
    stack,
    internal.core.accounts.host.resetPassword,
    { password },
    Schema.Struct({ username: Schema.String }),
  );

  const person = { username, password };

  return { person, signedIn: await signInAs(stack, person) };
};

const clientWith = (stack: CoreStack, token: string): ConvexHttpClient => {
  const client = new ConvexHttpClient(stack.url, { logger: false });

  client.setAuth(token);

  return client;
};

/** Signs in with a provider and its params; rejects as `auth:signIn` does. */
export const signIn = async (
  stack: CoreStack,
  provider: "password" | "apiKey" | "deviceCode" | "setup" | "invite" | "reset",
  params: Readonly<Record<string, string>>,
): Promise<SignedIn> => {
  const result = await new ConvexHttpClient(stack.url, { logger: false }).action(api.auth.signIn, {
    provider,
    params,
  });

  const tokens = decodeTokens(result.tokens);

  return { ...tokens, client: clientWith(stack, tokens.token) };
};

/** Signs `person` in with their password. */
export const signInAs = (stack: CoreStack, person: Person): Promise<SignedIn> =>
  signIn(stack, "password", { username: person.username, password: person.password });

const ErrorData = Schema.Struct({ code: Schema.String });

/** The `code` a call was refused with, or `"accepted"` when it was not refused. */
export const refusal = async (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "accepted",
    (cause: unknown) =>
      cause instanceof ConvexError
        ? Schema.decodeUnknownSync(ErrorData)(cause.data).code
        : `failed: ${String(cause)}`,
  );
