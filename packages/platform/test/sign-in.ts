import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { Schema } from "effect";

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

const unique = (): string => Math.random().toString(36).slice(2, 10);

/** Creates a user with the admin key. */
export const createPerson = async (stack: CoreStack, label = "person"): Promise<Person> => {
  const person = { username: `${label}-${unique()}`, password: `password-${unique()}` };

  await runFunction(stack, internal.core.auth.password.createUser, person, Schema.String);

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
  provider: "password" | "apiKey" | "deviceCode",
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
