import { Context, Effect, Layer, Redacted, Schema } from "effect";

import * as Platform from "../platform/platform";
import * as TokenStorage from "../token-storage";
import type { PlatformStack } from "./stack-env";

const decodeAdminAnswer = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      status: Schema.Literals(["success", "error"]),
      errorMessage: Schema.optionalKey(Schema.String),
    }),
  ),
);

/** A person's credentials. */
export interface PlatformPerson {
  readonly username: string;
  readonly password: string;
}

/** Fresh credentials no one holds yet, under a username that starts with `label`. */
export const newPlatformPerson = (label: string): PlatformPerson => {
  const unique = Math.random().toString(36).slice(2, 10);

  return { username: `${label}-${unique}`, password: `password-${unique}` };
};

/** A signed-out platform client over its own in-memory session, for the scope's lifetime. */
const openPlatform = (url: string) =>
  Effect.map(
    Layer.build(Platform.layer({ url, connection: "http", storage: TokenStorage.layerMemory })),
    (context) => Context.get(context, Platform.Platform),
  );

const setUpOnce = (stack: PlatformStack) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const platform = yield* openPlatform(stack.url);

        if ((yield* platform.core.server.info()).hasOwner) return;

        const owner = newPlatformPerson("owner");

        yield* platform.session
          .signIn(
            Platform.Credentials.Setup({
              username: owner.username,
              password: Redacted.make(owner.password),
            }),
          )
          .pipe(Effect.catchTag("Conflict", () => Effect.void));
      }),
    ),
  );

const setUps = new Map<string, Promise<void>>();

/** Sets up the stack's owner unless it has one, once per stack and test file. */
const ensurePlatformOwner = (stack: PlatformStack): Promise<void> => {
  const setUp = setUps.get(stack.url) ?? setUpOnce(stack);

  setUps.set(stack.url, setUp);

  return setUp;
};

/**
 * Creates a platform user with the admin key, as the server host does, and returns their
 * credentials. The core refuses users before its owner exists, so this sets one up first.
 */
export const createPlatformPerson = async (
  stack: PlatformStack,
  label: string,
  role: "admin" | "member" = "member",
): Promise<PlatformPerson> => {
  const person = newPlatformPerson(label);

  await ensurePlatformOwner(stack);

  const response = await fetch(`${stack.url}/api/function`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Convex ${stack.adminKey}` },
    body: JSON.stringify({
      path: "core/accounts/host:createUser",
      args: { ...person, role },
      format: "json",
    }),
  });

  const answer = decodeAdminAnswer(await response.text());

  if (answer.status !== "success") {
    throw new Error(
      `Creating ${person.username} failed: ${answer.errorMessage ?? response.status}`,
    );
  }

  return person;
};
