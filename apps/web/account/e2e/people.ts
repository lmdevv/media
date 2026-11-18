import type { Page } from "@playwright/test";
import { createPlatform } from "@media/sdk/promise";
import type { PlatformSdk } from "@media/sdk/promise";
import { ownClientFetch } from "@media/sdk/testing/own-client";
import { Schema } from "effect";

import type { Stack } from "./stack";

/** A person's credentials. */
export interface Person {
  readonly username: string;
  readonly password: string;
}

/**
 * A password no one has used, marked so the results check (`secrets.ts`) can find it wherever it
 * lands.
 */
export const newSecret = (): string => `e2e-secret-${Math.random().toString(36).slice(2, 14)}`;

/** Fresh credentials no one holds yet, under a username that starts with `label`. */
const newPerson = (label: string): Person => {
  const unique = Math.random().toString(36).slice(2, 10);

  return { username: `${label}-${unique}`, password: newSecret() };
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

/** A platform client from Node over its own in-memory session, signing in as its own client. */
export const openPlatform = (stack: Stack): PlatformSdk =>
  createPlatform({
    url: stack.platformUrl,
    signInUrl: stack.signInUrl,
    signInFetch: ownClientFetch(),
    connection: "http",
  });

/**
 * Names the browser behind `page` as a client of its own at the sign-in boundary, as the proxy in
 * front of the server names each client with `X-Forwarded-For`. The boundary limits sign-ins per
 * address (ADR 0007), and the suite signs many people in from one host.
 */
export const asOwnClient = async (page: Page): Promise<void> => {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint8Array(2));
  const address = `198.18.${String(high)}.${String(low)}`;

  await page
    .context()
    .route("**/api/auth/sign-in", (route) =>
      route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": address } }),
    );
};

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

/** Signs `person` in at `/` through the sign-in form. */
export const signIn = async (page: Page, person: Person): Promise<void> => {
  await asOwnClient(page);
  await page.goto("/");
  await page.getByLabel("Username").fill(person.username);
  await page.getByLabel("Password", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Sign in" }).click();
};
