import { createPlatform } from "@media/sdk/promise";
import type { PlatformSdk } from "@media/sdk/promise";
import { Schema } from "effect";

import type { Stack } from "./stack";

/** A person's credentials. */
export interface Person {
  readonly username: string;
  readonly password: string;
}

/** Fresh credentials no one holds yet, under a username that starts with `label`. */
const newPerson = (label: string): Person => {
  const unique = Math.random().toString(36).slice(2, 10);

  return { username: `${label}-${unique}`, password: `password-${unique}` };
};

const HostAnswer = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Literals(["success", "error"]),
    errorMessage: Schema.optionalKey(Schema.String),
  }),
);

/** Creates a user with the admin key, as `media admin` does on the server host. */
const createUserAsHost = async (
  stack: Stack,
  user: Person & { readonly role: "admin" | "member" },
): Promise<void> => {
  const response = await fetch(`${stack.platformUrl}/api/function`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Convex ${stack.adminKey}` },
    body: JSON.stringify({ path: "core/accounts/host:createUser", args: user, format: "json" }),
  });

  const answer = Schema.decodeSync(HostAnswer)(await response.text());

  if (answer.status !== "success") {
    throw new Error(`Creating ${user.username} failed: ${answer.errorMessage ?? response.status}`);
  }
};

/** A platform client from Node over its own in-memory session. */
export const openPlatform = (stack: Stack): PlatformSdk =>
  createPlatform({ url: stack.platformUrl, connection: "http" });

/**
 * Creates a person with the admin key, as the server host does. The core refuses users before
 * its owner exists, so a server without one gets an owner first.
 */
export const createPerson = async (
  stack: Stack,
  label: string,
  role: "admin" | "member" = "member",
): Promise<Person> => {
  const platform = openPlatform(stack);

  try {
    if (!(await platform.core.server.info()).hasOwner) {
      await platform.session.setUpOwner(newPerson("owner")).catch(() => undefined);
    }
  } finally {
    await platform.dispose();
  }

  const person = newPerson(label);

  await createUserAsHost(stack, { ...person, role });

  return person;
};
