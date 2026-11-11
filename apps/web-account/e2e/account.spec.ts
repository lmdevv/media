import type { PlatformSdk } from "@media/sdk/promise";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Brand } from "effect";

import { asOwnClient, createPerson, newSecret, openPlatform, signIn } from "./people";
import type { Person } from "./people";
import { stackEnv } from "./stack";
import type { Stack } from "./stack";

const stack = stackEnv();

test.skip(stack === null, "needs scripts/dev-stack.sh up");

const home = (tab: Page, person: Person) =>
  expect(tab.getByRole("heading", { name: `Hi, ${person.username}.` })).toBeVisible();

const rememberSession = (tab: Page, name: string) =>
  tab.evaluate(
    (key) =>
      new Promise<void>((resolve, reject) => {
        const opening = indexedDB.open("media");

        opening.addEventListener("error", () => reject(new Error("IndexedDB did not open")));
        opening.addEventListener("success", () => {
          const read = opening.result.transaction("kv").objectStore("kv").get("media.session");

          read.addEventListener("error", () => reject(new Error("IndexedDB did not read")));
          read.addEventListener("success", () => {
            sessionStorage.setItem(key, /"token":"([^"]+)"/u.exec(String(read.result))?.[1] ?? "");
            resolve();
          });
        });
      }),
    name,
  );

const rememberedWorks = (tab: Page, core: Stack, name: string) =>
  tab.evaluate(
    async ({ key, url }) => {
      const response = await fetch(`${url}/api/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionStorage.getItem(key) ?? ""}`,
        },
        body: JSON.stringify({ path: "core/auth/sessions:current", args: {}, format: "json" }),
      });

      return (await response.text()).includes('"status":"success"');
    },
    { key: name, url: core.platformUrl },
  );

test("signing in at / goes to the person's home", async ({ page }) => {
  if (stack === null) return;

  const person = await createPerson(stack, "lucia");

  await signIn(page, person);

  await home(page, person);
  await expect(page).toHaveURL(/\/home$/u);
});

test("switching person signs the first out on the core, then signs the next in", async ({
  page,
}) => {
  if (stack === null) return;

  const first = await createPerson(stack, "mateo");
  const second = await createPerson(stack, "aiko");

  await signIn(page, first);
  await home(page, first);
  await rememberSession(page, "first");
  expect(await rememberedWorks(page, stack, "first")).toBe(true);

  await page.getByRole("button", { name: "Sign out" }).click();
  await asOwnClient(page);
  await page.getByLabel("Username").fill(second.username);
  await page.getByLabel("Password", { exact: true }).fill(second.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await home(page, second);
  await expect.poll(() => rememberedWorks(page, stack, "first")).toBe(false);
});

const holdEnrollments = async (tab: Page) => {
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const { promise: held, resolve: holding } = Promise.withResolvers<void>();

  await tab.route("**/api/action", async (route) => {
    if (!(route.request().postData() ?? "").includes("registry:enroll")) return route.fallback();

    holding();
    await released;
    await route.continue();
  });

  return { held, release };
};

const fillIn = async (tab: Page, person: Person): Promise<void> => {
  await tab.goto("/");
  await asOwnClient(tab);
  await tab.getByLabel("Username").fill(person.username);
  await tab.getByLabel("Password", { exact: true }).fill(person.password);
};

test("two tabs signing in at once leave only the session the core bound last, and end the other", async ({
  page,
  context,
}) => {
  if (stack === null) return;

  const enrolled = await createPerson(stack, "mateo");
  const later = await createPerson(stack, "lucia");
  const sooner = await createPerson(stack, "aiko");
  const other = await context.newPage();

  await signIn(page, enrolled);
  await home(page, enrolled);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Username")).toBeVisible();

  const { held, release } = await holdEnrollments(page);

  try {
    await Promise.all([fillIn(page, later), fillIn(other, sooner)]);
    await page.getByRole("button", { name: "Sign in" }).click();
    await held;
    await other.getByRole("button", { name: "Sign in" }).click();
    await home(other, sooner);
    await rememberSession(other, "sooner");

    release();
    await home(other, later);
    await page.reload();
    await home(page, later);
    await expect.poll(() => rememberedWorks(other, stack, "sooner")).toBe(false);
  } finally {
    release();
  }
});

/**
 * Sets whether a person is on every shared device's picker. The listing is the server's, so tests
 * in other workers change it at once and the core may give up on a conflict; it is tried again.
 */
const setListed = async (
  platform: PlatformSdk,
  userId: Parameters<PlatformSdk["core"]["devices"]["tiles"]["setListed"]>[0]["userId"],
  listed: boolean,
  attempts = 5,
): Promise<void> => {
  try {
    await platform.core.devices.tiles.setListed({ userId, listed });
  } catch (cause) {
    if (attempts <= 1 || !String(cause).includes("OptimisticConcurrencyControlFailure")) {
      throw cause;
    }

    await new Promise((resolve) => setTimeout(resolve, 100 * Math.random()));
    await setListed(platform, userId, listed, attempts - 1);
  }
};

/** Puts `person` on every shared device's picker; the returned step takes them off again. */
const listOnSharedDevices = async (core: Stack, person: Person) => {
  const platform = openPlatform(core);

  await platform.session.signInWithPassword(person);
  const { userId } = await platform.core.auth.sessions.current();

  await setListed(platform, userId, true);

  return async () => {
    await setListed(platform, userId, false);
    await platform.dispose();
  };
};

type DeviceRowId = Parameters<PlatformSdk["core"]["devices"]["registry"]["setMode"]>[0]["deviceId"];

const deviceIdOf = (tab: Page) =>
  tab.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const opening = indexedDB.open("media");

        opening.addEventListener("error", () => reject(new Error("IndexedDB did not open")));
        opening.addEventListener("success", () => {
          const read = opening.result.transaction("kv").objectStore("kv").get("media.device");

          read.addEventListener("error", () => reject(new Error("IndexedDB did not read")));
          read.addEventListener("success", () => {
            resolve(/"id":"([^"]+)"/u.exec(String(read.result))?.[1] ?? "");
          });
        });
      }),
  );

const makeShared = async (tab: Page, admin: Person, host: PlatformSdk): Promise<void> => {
  await signIn(tab, admin);
  await home(tab, admin);
  await host.session.signInWithPassword(admin);
  await host.core.devices.registry.setMode({
    deviceId: Brand.nominal<DeviceRowId>()(await deviceIdOf(tab)),
    mode: "shared",
  });
  await tab.goto("/");
};

test("a shared device opens one tile at a time, and ends the tile it replaced", async ({
  page,
}) => {
  if (stack === null) return;

  const admin = await createPerson(stack, "admin", "admin");
  const ada = await createPerson(stack, "ada");
  const bo = await createPerson(stack, "bo");
  const unlist = await Promise.all([ada, bo].map((person) => listOnSharedDevices(stack, person)));
  const host = openPlatform(stack);

  try {
    await makeShared(page, admin, host);
    await page.getByRole("button", { name: ada.username, exact: true }).click();
    await home(page, ada);
    await rememberSession(page, "ada");

    await page.goto("/");
    await page.getByRole("button", { name: bo.username, exact: true }).click();
    await home(page, bo);

    await page.reload();
    await home(page, bo);
    expect(await rememberedWorks(page, stack, "ada")).toBe(false);
  } finally {
    await Promise.all(unlist.map((step) => step()));
    await host.dispose();
  }
});

test("two tabs opening tiles at once keep the tile the core opened last", async ({
  page,
  context,
}) => {
  if (stack === null) return;

  const admin = await createPerson(stack, "admin", "admin");
  const ada = await createPerson(stack, "ada");
  const bo = await createPerson(stack, "bo");
  const unlist = await Promise.all([ada, bo].map((person) => listOnSharedDevices(stack, person)));
  const host = openPlatform(stack);
  const other = await context.newPage();
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const { promise: reachedCore, resolve: opened } = Promise.withResolvers<void>();

  // Tab A's tile opening reaches the core first, but its answer waits until tab B is done.
  await page.route("**/api/auth/sign-in", async (route) => {
    if (!(route.request().postData() ?? "").includes('"tile"')) return route.fallback();

    const response = await route.fetch();

    opened();
    await released;
    await route.fulfill({ response });
  });

  try {
    await makeShared(page, admin, host);
    await other.goto("/");
    await page.getByRole("button", { name: ada.username, exact: true }).click();
    await reachedCore;

    await other.getByRole("button", { name: bo.username, exact: true }).click();
    await home(other, bo);

    release();
    await expect(page.getByRole("button", { name: ada.username, exact: true })).toBeVisible();

    await other.reload();
    await home(other, bo);
  } finally {
    release();
    await Promise.all(unlist.map((step) => step()));
    await host.dispose();
  }
});

test("an older tile that registers last never replaces the tile the core opened after it", async ({
  page,
  context,
}) => {
  if (stack === null) return;

  const admin = await createPerson(stack, "admin", "admin");
  const ada = await createPerson(stack, "ada");
  const bo = await createPerson(stack, "bo");
  const unlist = await Promise.all([ada, bo].map((person) => listOnSharedDevices(stack, person)));
  const host = openPlatform(stack);
  const other = await context.newPage();
  const { promise: released, resolve: release } = Promise.withResolvers<void>();
  const { promise: reachedCore, resolve: opened } = Promise.withResolvers<void>();

  // Tab A's tile opens and asks the core for its number before tab B opens; the answer, naming
  // Ada's tile still live, waits until tab B's tile is promoted.
  await page.route("**/api/query", async (route) => {
    if (!(route.request().postData() ?? "").includes("sessions:current")) return route.fallback();

    const response = await route.fetch();

    opened();
    await released;
    await route.fulfill({ response });
  });

  try {
    await makeShared(page, admin, host);
    await other.goto("/");
    await page.getByRole("button", { name: ada.username, exact: true }).click();
    await reachedCore;

    await other.getByRole("button", { name: bo.username, exact: true }).click();
    await home(other, bo);

    release();
    await expect(page.getByRole("button", { name: ada.username, exact: true })).toBeVisible();

    await other.reload();
    await home(other, bo);
  } finally {
    release();
    await Promise.all(unlist.map((step) => step()));
    await host.dispose();
  }
});

test("two tabs share one sign-in, and a sign-out in one signs the other out", async ({
  page,
  context,
}) => {
  if (stack === null) return;

  const person = await createPerson(stack, "lucia");
  const other = await context.newPage();

  await signIn(page, person);
  await home(page, person);

  await other.goto("/home");
  await expect(other.getByRole("button", { name: "Sign out" })).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByLabel("Username")).toBeVisible();
  await expect(other.getByRole("button", { name: "Sign out" })).toBeHidden();

  await other.reload();
  await expect(other.getByLabel("Username")).toBeVisible();
  expect(await other.evaluate(() => Object.keys(localStorage))).toStrictEqual([]);
});

test("a CLI link signs in, then approves its code on the same page", async ({ page }) => {
  if (stack === null) return;

  const person = await createPerson(stack, "lucia");
  const device = openPlatform(stack);

  try {
    const pending = await device.session.startDeviceSignIn("media CLI on e2e");
    const signedIn = pending.complete();

    await page.goto(`/device?code=${pending.userCode.replace("-", "")}`);
    await asOwnClient(page);
    await page.getByLabel("Username").fill(person.username);
    await page.getByLabel("Password", { exact: true }).fill(person.password);
    await page.getByRole("button", { name: "Sign in" }).click();

    await expect(page).toHaveURL(/\/device\?code=/u);
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(
      page.getByRole("heading", { name: "media CLI on e2e is signed in." }),
    ).toBeVisible();

    await signedIn;
    expect((await device.core.auth.sessions.current()).username).toBe(person.username);
  } finally {
    await device.dispose();
  }
});

test("a second password change keeps what was typed while it runs and once it fails", async ({
  page,
}) => {
  if (stack === null) return;

  const person = await createPerson(stack, "aiko");
  const current = page.getByLabel("Current password", { exact: true });
  const next = page.getByLabel(/^New password/u);
  const change = page.getByRole("button", { name: "Change password" });

  await signIn(page, person);
  await home(page, person);
  await page.goto("/settings");

  await current.fill(person.password);
  await next.fill(newSecret());
  await change.click();
  await expect(page.getByRole("status")).toHaveText("Password changed.");
  await expect(current).toHaveValue("");

  const typed = newSecret();

  await current.fill("not-the-password");
  await next.fill(typed);
  await change.click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(current).toHaveValue("not-the-password");
  await expect(next).toHaveValue(typed);
});
