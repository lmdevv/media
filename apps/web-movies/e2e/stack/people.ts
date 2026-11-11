import { createMediaServer, createPlatform } from "@media/sdk/promise";
import type { MediaServer, PlatformSdk } from "@media/sdk/promise";
import { ownClientFetch } from "@media/sdk/testing/own-client";
import { expect } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";
import { Schema } from "effect";

import { stackEnv } from "./stack-env";
import type { StackEnv } from "./stack-env";

/** Why the stack suites skip. */
export const NO_STACK = "needs the dev stack: scripts/dev-stack.sh up";

/** A person's credentials. */
export interface Person {
  readonly username: string;
  readonly password: string;
}

const unique = (): string => Math.random().toString(36).slice(2, 10);

/** Fresh credentials no one holds yet, under a username that starts with `label`. */
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

/** Creates a user with the core's admin key, as `media admin` does on the server host. */
const createUserAsHost = async (
  stack: StackEnv,
  user: Person & { readonly role: "admin" | "member" },
): Promise<void> => {
  const path = "core/accounts/host:createUser";

  const response = await fetch(`${stack.platformUrl}/api/function`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Convex ${stack.adminKey}` },
    body: JSON.stringify({ path, args: user, format: "json" }),
  });

  const answer = Schema.decodeSync(HostAnswer)(await response.text());

  if (answer.status !== "success") {
    throw new Error(`${path} failed: ${answer.errorMessage ?? String(response.status)}`);
  }
};

/** A platform client from Node over its own in-memory session, signed out. */
const openPlatform = (stack: StackEnv): PlatformSdk =>
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
const asOwnClient = async (page: Page): Promise<void> => {
  const [high = 0, low = 0] = crypto.getRandomValues(new Uint8Array(2));
  const address = `198.18.${String(high)}.${String(low)}`;

  await page
    .context()
    .route("**/api/auth/sign-in", (route) =>
      route.continue({ headers: { ...route.request().headers(), "x-forwarded-for": address } }),
    );
};

/**
 * The worktree's stack when its core answers; null otherwise, so the suites skip. A core without
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

/** Creates a person with the admin key, an admin unless `role` says otherwise. */
export const createPerson = async (
  stack: StackEnv,
  label: string,
  role: "admin" | "member" = "admin",
): Promise<Person> => {
  const person = newPerson(label);

  await createUserAsHost(stack, { ...person, role });

  return person;
};

/** A person signed in from Node, and the media server's own routes as them. */
export interface Client {
  readonly person: Person;
  readonly platform: PlatformSdk;
  readonly media: MediaServer;
}

/** Signs `person` in from Node over its own session, apart from any browser's. */
export const signInClient = async (stack: StackEnv, person: Person): Promise<Client> => {
  const platform = openPlatform(stack);

  await platform.session.signInWithPassword(person);

  return {
    person,
    platform,
    media: createMediaServer({ url: stack.mediaUrl, accessToken: platform.session.accessToken }),
  };
};

/** The movies client's address for `path` inside it, such as `/title/…`. */
export const moviesPath = (path = "/"): string => `/movies${path === "/" ? "/" : path}`;

/**
 * Signs `person` in at `/`, the account client, through its sign-in form, as the browser's one
 * session (ADR 0020), and waits for their home there.
 */
export const signIn = async (page: Page, person: Person): Promise<void> => {
  await asOwnClient(page);
  await page.goto("/");
  await page.getByLabel("Username").fill(person.username);
  await page.getByLabel("Password", { exact: true }).fill(person.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: `Hi, ${person.username}.` })).toBeVisible();
};

/** A new browser context made with `options`, signed in at `/` as `person`, and its first tab. */
export const signedInPage = async (
  browser: Browser,
  person: Person,
  options?: Parameters<Browser["newContext"]>[0],
): Promise<Page> => {
  const context = await browser.newContext(options);
  const page = await context.newPage();

  await signIn(page, person);

  return page;
};
