import { createMovies } from "@media/sdk/promise";
import type { MoviesSdk } from "@media/sdk/promise";
import type { Page } from "@playwright/test";

import { OWNER } from "../stack/owner";
import { stackEnv } from "../stack/stack-env";
import type { StackEnv } from "../stack/stack-env";

/** Why the admin suites skip. */
export const NO_STACK = "needs the dev stack: scripts/dev-stack.sh up";

const SESSION_KEY = "movies.session";

const PROFILE_KEY = "movies.profile";

/** An SDK client with its own in-memory store, and that store's serialized session. */
export interface Client {
  readonly sdk: MoviesSdk;
  /** The stored session as the app keeps it in `localStorage`. */
  readonly session: () => string;
}

/** Opens an SDK client against the stack, signed out. */
export const openClient = (stack: StackEnv): Client => {
  const store = new Map<string, string>();

  const sdk = createMovies({
    convexUrl: stack.convexUrl,
    mediaUrl: stack.mediaUrl,
    connection: "http",
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => {
        store.set(key, value);
      },
      removeItem: (key) => {
        store.delete(key);
      },
    },
    storageKey: SESSION_KEY,
  });

  return {
    sdk,
    session: () => {
      const value = store.get(SESSION_KEY);

      if (value === undefined) throw new Error("The test client is not signed in");

      return value;
    },
  };
};

/**
 * The worktree's stack when it is reachable and its owner is the suites' owner or not created yet;
 * null otherwise, so the suites skip.
 */
export const ownedStack = async (): Promise<StackEnv | null> => {
  const stack = stackEnv();

  if (stack === null) return null;

  const client = openClient(stack);

  try {
    const status = await client.sdk.query("setup.status", {});

    if (!status.hasOwner) return stack;

    await client.sdk.auth.signInWithPassword({
      flow: "signIn",
      email: OWNER.email,
      password: OWNER.password,
    });

    return stack;
  } catch {
    return null;
  } finally {
    await client.sdk.dispose();
  }
};

/** Signs in as the owner, creating it when these suites run on a fresh stack by themselves. */
export const signInOwner = async (stack: StackEnv): Promise<Client> => {
  const client = openClient(stack);
  const status = await client.sdk.query("setup.status", {});

  await client.sdk.auth.signInWithPassword(
    status.hasOwner
      ? { flow: "signIn", email: OWNER.email, password: OWNER.password }
      : { flow: "signUp", email: OWNER.email, password: OWNER.password, name: OWNER.name },
  );

  return client;
};

/**
 * Makes `page` start signed in as `client` on its next navigation, with the account's first
 * profile that needs no PIN chosen, as "Who's watching?" would.
 */
export const useSession = async (page: Page, client: Client): Promise<void> => {
  const profiles = await client.sdk.query("profiles.list", {});
  const profile = profiles.find((each) => !each.locked && !each.kids) ?? profiles[0];

  if (profile === undefined) throw new Error("The owner has no profile");

  await page.addInitScript(
    ([entries]) => {
      for (const [key, value] of entries) window.localStorage.setItem(key, value);
    },
    [
      [
        [SESSION_KEY, client.session()],
        [PROFILE_KEY, profile.id],
      ],
    ] as const,
  );
};
