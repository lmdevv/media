import type { SignInProvider } from "@media/contracts/sign-in";
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

/** The sign-in providers of the core. */
export type Provider = SignInProvider;

const Refusal = Schema.Struct({ code: Schema.String, message: Schema.String });

const decodeAnswer = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Union([Schema.Struct({ tokens: Token }), Refusal])),
);

const ADDRESSES = 1 << 17;

const [first = 0] = crypto.getRandomValues(new Uint32Array(1));

let clients = first % ADDRESSES;

/**
 * An address of its own for each sign-in, as the proxy in front of the server names each client:
 * the boundary limits sign-ins per address and trusts `X-Forwarded-For` from a loopback peer. The
 * addresses run through 198.18.0.0/15 from a random start, so processes rarely share one.
 */
export const newClientAddress = (): string => {
  clients = (clients + 1) % ADDRESSES;

  return `198.${String(18 + (clients >> 16))}.${String((clients >> 8) & 255)}.${String(clients & 255)}`;
};

/**
 * Posts a sign-in to the stack's boundary from `address`, as a client does, and answers its status
 * and body.
 */
export const postSignIn = async (
  stack: CoreStack,
  provider: Provider,
  params: Readonly<Record<string, Value>>,
  address: string = newClientAddress(),
): Promise<{ readonly status: number; readonly text: string }> => {
  const response = await fetch(stack.signInUrl, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": address },
    body: JSON.stringify({ provider, params }),
  });

  return { status: response.status, text: await response.text() };
};

/**
 * Signs in with a provider and its params through the stack's boundary, from an address of its
 * own; rejects as `auth:signIn` does, with a `ConvexError` holding the refusal.
 */
export const signIn = async (
  stack: CoreStack,
  provider: Provider,
  params: Readonly<Record<string, Value>>,
): Promise<SignedIn> => {
  const answer = decodeAnswer((await postSignIn(stack, provider, params)).text);

  if (!("tokens" in answer)) throw new ConvexError({ code: answer.code, message: answer.message });

  return { ...answer.tokens, client: clientWith(stack, answer.tokens.token) };
};

/** Signs `person` in with their password. */
export const signInAs = (stack: CoreStack, person: Person): Promise<SignedIn> =>
  signIn(stack, "password", { username: person.username, password: person.password });

const ErrorData = Schema.Struct({ code: Schema.String });

const RefusalData = Schema.Struct({ code: Schema.String, message: Schema.String });

/** The `code` a call was refused with, or `"accepted"` when it was not refused. */
export const refusal = async (call: Promise<unknown>): Promise<string> =>
  call.then(
    () => "accepted",
    (cause: unknown) =>
      cause instanceof ConvexError
        ? Schema.decodeUnknownSync(ErrorData)(cause.data).code
        : `failed: ${String(cause)}`,
  );

export const failureOf = async (
  call: Promise<unknown>,
): Promise<{ readonly code: string; readonly message: string }> => {
  try {
    await call;
  } catch (cause) {
    if (cause instanceof ConvexError) return Schema.decodeUnknownSync(RefusalData)(cause.data);

    throw cause;
  }

  throw new Error("the call was not refused");
};
