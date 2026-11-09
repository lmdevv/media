import type { FunctionArgs, FunctionReference } from "convex/server";
import { Schema } from "effect";

import { internal } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { callFunction, runFunction } from "./admin";
import { signIn, unique } from "./sign-in";
import type { SignedIn } from "./sign-in";
import type { CoreStack } from "./stack-env";

// SAFETY: a type predicate, not checked by the compiler. A Convex id is an opaque string, and the
// stack answered this one as a `users` id; the backend's `v.id("users")` validators check it again
// whenever a test sends it back.
const isUserId = (value: unknown): value is Id<"users"> => Schema.is(Schema.String)(value);

const UserId = Schema.declare(isUserId);

const Issued = Schema.Struct({ keyId: Schema.String, key: Schema.String });

type ServerCallable = FunctionReference<"query" | "mutation">;

/**
 * Signs a new service principal in with a fresh key holding `media-service`, as the media server
 * does: the only caller server functions accept.
 */
const signInService = async (stack: CoreStack): Promise<SignedIn> => {
  const serviceId = await runFunction(
    stack,
    internal.core.accounts.host.createService,
    { name: `media server ${unique()}` },
    UserId,
  );

  const issued = await runFunction(
    stack,
    internal.core.auth.apiKeys.issueServiceKey,
    { serviceId },
    Issued,
  );

  return signIn(stack, "apiKey", { key: issued.key });
};

const services = new Map<string, Promise<SignedIn>>();

/** The stack's media server for this test run, signed in once. */
const serviceOf = (stack: CoreStack): Promise<SignedIn> => {
  const service = services.get(stack.url) ?? signInService(stack);

  services.set(stack.url, service);

  return service;
};

/**
 * Runs a server function as the stack's media server and decodes its result. Refusals come back
 * as `runFunction`'s do, so a worker's retry of a refusal that committed nothing still works.
 */
export const runServer = async <
  Callable extends ServerCallable,
  Result extends Schema.ConstraintDecoder<unknown>,
>(
  stack: CoreStack,
  callable: Callable,
  args: FunctionArgs<Callable>,
  result: Result,
): Promise<Result["Type"]> =>
  callFunction(stack.url, `Bearer ${(await serviceOf(stack)).token}`, callable, args, result);

/** Runs a server function with another session's token, such as a person's, to see it refused. */
export const runServerAs = <
  Callable extends ServerCallable,
  Result extends Schema.ConstraintDecoder<unknown>,
>(
  stack: CoreStack,
  signedIn: SignedIn,
  callable: Callable,
  args: FunctionArgs<Callable>,
  result: Result,
): Promise<Result["Type"]> =>
  callFunction(stack.url, `Bearer ${signedIn.token}`, callable, args, result);
