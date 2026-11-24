import { createPlatform } from "@media/sdk/promise";
import type { PlatformSdk } from "@media/sdk/promise";
import { ownClientFetch } from "@media/sdk/testing/own-client";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Schema } from "effect";

import { stackEnv } from "./stack-env";
import type { StackEnv } from "./stack-env";

/** Why the suite skips. */
export const NO_STACK = "needs the dev stack: scripts/dev-stack.sh up";

/** A person's credentials. */
export interface Person {
  readonly username: string;
  readonly password: string;
}

const unique = (): string => Math.random().toString(36).slice(2, 10);

const newPerson = (label: string): Person => ({
  username: `${label}-${unique()}`,
  password: `e2e-password-${unique()}`,
});

const HostAnswer = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Literals(["success", "error"]),
    errorMessage: Schema.optionalKey(Schema.String),
  }),
);

/** A platform client from Node over its own in-memory session, signed out. */
const openPlatform = (stack: StackEnv): PlatformSdk =>
  createPlatform({
    url: stack.platformUrl,
    signInUrl: stack.signInUrl,
    signInFetch: ownClientFetch(),
    connection: "http",
  });

/**
 * The worktree's stack when its core answers; null otherwise, so the suite skips. A core without
 * an owner gets one first, as the core refuses other users before it.
 */
export const reachableStack = async (): Promise<StackEnv | null> => {
  const stack = stackEnv();

  if (stack === null) return null;

  const platform = openPlatform(stack);

  try {
    if (!(await platform.core.server.info()).hasOwner) {
      await platform.session.setUpOwner(newPerson("owner")).catch(() => undefined);
    }

    return stack;
  } catch {
    return null;
  } finally {
    await platform.dispose();
  }
};

/** Creates a person with the core's admin key, as `media admin` does on the server host. */
export const createPerson = async (
  stack: StackEnv,
  label: string,
  role: "admin" | "member",
): Promise<Person> => {
  const person = newPerson(label);
  const path = "core/accounts/host:createUser";

  const response = await fetch(`${stack.platformUrl}/api/function`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Convex ${stack.adminKey}` },
    body: JSON.stringify({ path, args: { ...person, role }, format: "json" }),
  });

  const answer = Schema.decodeSync(HostAnswer)(await response.text());

  if (answer.status !== "success") {
    throw new Error(`${path} failed: ${answer.errorMessage ?? String(response.status)}`);
  }

  return person;
};

/** Signs `person` in from Node over its own session, apart from any browser's. */
export const signInClient = async (stack: StackEnv, person: Person): Promise<PlatformSdk> => {
  const platform = openPlatform(stack);

  await platform.session.signInWithPassword(person);

  return platform;
};

/**
 * Signs `person` in at `/`, the account client, through its sign-in form, as the browser's one
 * session (ADR 0020), naming the browser as a client of its own at the sign-in boundary, which
 * limits sign-ins per address (ADR 0007).
 */
export const signIn = async (page: Page, person: Person): Promise<void> => {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint8Array(2));
  const address = `198.18.${String(high)}.${String(low)}`;

  await page
    .context()
    .route("**/api/auth/sign-in", (route) =>
      route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": address } }),
    );

  await page.goto("/");
  await page.getByLabel("Username").fill(person.username);
  await page.getByLabel("Password", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: `Hi, ${person.username}.` })).toBeVisible();
};

/** A music library and the admin who made it, and so manages it. */
export interface ManagedLibrary {
  readonly manager: Person;
  readonly libraryId: Awaited<ReturnType<PlatformSdk["core"]["libraries"]["create"]>>["libraryId"];
}

/**
 * Adds a music library over `folder` that the whole household may use, made by a new admin who
 * manages it, and resolves once its first scan finished.
 */
export const addManagedLibrary = async (
  stack: StackEnv,
  folder: string,
): Promise<ManagedLibrary> => {
  const manager = await createPerson(stack, "music-admin", "admin");
  const platform = await signInClient(stack, manager);

  try {
    const { libraryId } = await platform.core.libraries.create({
      name: `Music ${manager.username}`,
      kind: "music",
      folders: [folder],
    });

    await platform.core.permissions.grants.set({
      resource: { type: "library", id: libraryId },
      principal: { kind: "household" },
      level: "view",
    });

    await expect
      .poll(async () => (await platform.core.libraries.get({ libraryId })).scan?.status, {
        timeout: 60_000,
      })
      .toBe("succeeded");

    return { manager, libraryId };
  } finally {
    await platform.dispose();
  }
};

/**
 * Adds a music library over `folder` that the whole household may use, as an admin, and resolves
 * once its first scan finished.
 */
export const addHouseholdLibrary = async (stack: StackEnv, folder: string): Promise<void> => {
  await addManagedLibrary(stack, folder);
};
