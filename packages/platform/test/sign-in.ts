import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import type { Value } from "convex/values";
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

export const ensureOwner = (stack: CoreStack): Promise<void> => {
  const setUp = setUps.get(stack.url) ?? setUpOnce(stack);

  setUps.set(stack.url, setUp);

  return setUp;
};

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

const clientWith = (stack: CoreStack, token: string): ConvexHttpClient => {
  const client = new ConvexHttpClient(stack.url, { logger: false });

  client.setAuth(token);

  return client;
};

/** Signs in with a provider and its params; rejects as `auth:signIn` does. */
export const signIn = async (
  stack: CoreStack,
  provider: "password" | "apiKey" | "deviceCode" | "setup" | "invite" | "reset" | "tile",
  params: Readonly<Record<string, Value>>,
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
