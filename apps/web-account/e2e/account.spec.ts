import type { PlatformSdk } from "@media/sdk/promise";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Brand } from "effect";

import { createPerson, openPlatform, signIn } from "./people";
import type { Person } from "./people";
import { stackEnv } from "./stack";
import type { Stack } from "./stack";

const stack = stackEnv();

test.skip(stack === null, "needs scripts/dev-stack.sh up");

test("signing in at / shows the picker with the signed-in person", async ({ page }) => {
  if (stack === null) return;

  const person = await createPerson(stack, "lucia");

  await signIn(page, person);

  await expect(page.getByRole("heading", { name: "Who's here?" })).toBeVisible();
  await expect(page.getByRole("button", { name: person.username, exact: true })).toBeVisible();
});

test("a second person signed in on this browser joins the picker", async ({ page }) => {
  if (stack === null) return;

  const first = await createPerson(stack, "mateo");
  const second = await createPerson(stack, "aiko");

  await signIn(page, first);
  await expect(page.getByRole("button", { name: first.username, exact: true })).toBeVisible();

  await page.goto("/add");
  await page.getByLabel("Username").fill(second.username);
  await page.getByLabel("Password", { exact: true }).fill(second.password);
  await page.getByRole("button", { name: "Sign in" }).click();

  await expect(page.getByRole("button", { name: first.username, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: second.username, exact: true })).toBeVisible();

  await page.getByRole("button", { name: first.username, exact: true }).click();
  await expect(page).toHaveURL(/\/home$/u);
  await expect(page.getByRole("link", { name: `${first.username}, switch person` })).toBeVisible();
});

test("choosing a saved person from a CLI link's page keeps the page and its code", async ({
  page,
}) => {
  if (stack === null) return;

  const first = await createPerson(stack, "mateo");
  const second = await createPerson(stack, "aiko");
  const device = openPlatform(stack);

  try {
    await signIn(page, first);
    await expect(page.getByRole("button", { name: first.username, exact: true })).toBeVisible();
    await page.goto("/add");
    await page.getByLabel("Username").fill(second.username);
    await page.getByLabel("Password", { exact: true }).fill(second.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: second.username, exact: true }).click();
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("button", { name: first.username, exact: true })).toBeVisible();

    const pending = await device.session.startDeviceSignIn("media CLI on e2e");
    const code = pending.userCode.replace("-", "");

    await page.goto(`/device?code=${code}`);
    await page.getByRole("button", { name: first.username, exact: true }).click();

    await expect(page.getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`/device\\?code=${code}$`, "u"));
  } finally {
    await device.dispose();
  }
});

const fillIn = async (tab: Page, person: Person): Promise<void> => {
  await tab.goto("/");
  await tab.getByLabel("Username").fill(person.username);
  await tab.getByLabel("Password", { exact: true }).fill(person.password);
};

test("two people signing in at once on a new browser both join its picker", async ({
  page,
  context,
}) => {
  if (stack === null) return;

  const first = await createPerson(stack, "mateo");
  const second = await createPerson(stack, "aiko");
  const other = await context.newPage();

  await Promise.all([fillIn(page, first), fillIn(other, second)]);
  await Promise.all([
    page.getByRole("button", { name: "Sign in" }).click(),
    other.getByRole("button", { name: "Sign in" }).click(),
  ]);
  await Promise.all(
    [page, other].flatMap((tab) =>
      [first, second].map((person) =>
        expect(tab.getByRole("button", { name: person.username, exact: true })).toBeVisible(),
      ),
    ),
  );

  await page.reload();
  await expect(page.getByRole("button", { name: first.username, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: second.username, exact: true })).toBeVisible();
});

test("two tabs signing one person in keep the session the core kept, whichever promotes first", async ({
  page,
  context,
}) => {
  if (stack === null) return;

  const enrolled = await createPerson(stack, "mateo");
  const person = await createPerson(stack, "lucia");
  const late = await context.newPage();
  const held: Array<() => void> = [];
  let holding = true;

  // The late tab's enrollment waits on the wire, after its sign-in is saved, until the other tab
  // has signed the same person in, enrolled, and promoted.
  await late.routeWebSocket(/\/api\/[^/]+\/sync/u, (socket) => {
    const server = socket.connectToServer();

    socket.onMessage((message) => {
      if (holding && message.toString().includes("registry:enroll")) {
        held.push(() => server.send(message));

        return;
      }

      server.send(message);
    });
  });

  await signIn(page, enrolled);
  await expect(page.getByRole("button", { name: enrolled.username, exact: true })).toBeVisible();

  const signInOn = async (tab: Page) => {
    await tab.goto("/add");
    await tab.getByLabel("Username").fill(person.username);
    await tab.getByLabel("Password", { exact: true }).fill(person.password);
    await tab.getByRole("button", { name: "Sign in" }).click();
  };

  await signInOn(late);
  await expect.poll(() => held.length).toBe(1);

  await signInOn(page);
  await expect(page.getByRole("button", { name: person.username, exact: true })).toBeVisible();

  holding = false;

  for (const send of held.splice(0)) send();

  await expect(late.getByRole("heading", { name: "Who's here?" })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: person.username, exact: true }).click();
  await expect(page).toHaveURL(/\/home$/u);
  await expect(page.getByRole("link", { name: `${person.username}, switch person` })).toBeVisible();
});

/** Puts `person` on every shared device's picker; the returned step takes them off again. */
const listOnSharedDevices = async (core: Stack, person: Person) => {
  const platform = openPlatform(core);

  await platform.session.signInWithPassword(person);
  const { userId } = await platform.core.auth.sessions.current();

  await platform.core.devices.tiles.setListed({ userId, listed: true });

  return async () => {
    await platform.core.devices.tiles.setListed({ userId, listed: false });
    await platform.dispose();
  };
};

type DeviceRowId = Parameters<PlatformSdk["core"]["devices"]["registry"]["setMode"]>[0]["deviceId"];

/**
 * The keys of this browser's shared store, and its device id from the device code it keeps; the
 * code itself stays in the page.
 */
const readStore = (tab: Page) =>
  tab.evaluate(
    () =>
      new Promise<{ readonly keys: ReadonlyArray<string>; readonly deviceId: string }>(
        (resolve, reject) => {
          const opening = indexedDB.open("media");

          opening.addEventListener("error", () => reject(new Error("IndexedDB did not open")));
          opening.addEventListener("success", () => {
            const kv = opening.result.transaction("kv").objectStore("kv");
            const keys = kv.getAllKeys();
            const device = kv.get("media.device");

            device.addEventListener("error", () => reject(new Error("IndexedDB did not read")));
            device.addEventListener("success", () =>
              resolve({
                keys: keys.result.map(String),
                deviceId: String(device.result).split(".")[0]?.slice(3) ?? "",
              }),
            );
          });
        },
      ),
  );

test("a shared device opens each tile on a slot of its own, and drops the tile it replaced", async ({
  page,
}) => {
  if (stack === null) return;

  const admin = await createPerson(stack, "admin", "admin");
  const ada = await createPerson(stack, "ada");
  const bo = await createPerson(stack, "bo");
  const unlist = await Promise.all([ada, bo].map((person) => listOnSharedDevices(stack, person)));
  const host = openPlatform(stack);

  try {
    await signIn(page, admin);
    await expect(page.getByRole("button", { name: admin.username, exact: true })).toBeVisible();

    await host.session.signInWithPassword(admin);
    await host.core.devices.registry.setMode({
      deviceId: Brand.nominal<DeviceRowId>()((await readStore(page)).deviceId),
      mode: "shared",
    });

    await page.reload();
    await page.getByRole("button", { name: ada.username, exact: true }).click();
    await expect(page.getByRole("link", { name: `${ada.username}, switch person` })).toBeVisible();

    await page.getByRole("link", { name: `${ada.username}, switch person` }).click();
    await page.getByRole("button", { name: bo.username, exact: true }).click();
    await expect(page.getByRole("link", { name: `${bo.username}, switch person` })).toBeVisible();

    await page.reload();
    await expect(page.getByRole("link", { name: `${bo.username}, switch person` })).toBeVisible();

    const { keys } = await readStore(page);
    const tokens = keys.filter((key) => /^media\.session\.[^:]+:/u.test(key));

    expect(tokens).toHaveLength(1);
  } finally {
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
  await page.getByRole("button", { name: person.username, exact: true }).click();
  await expect(page).toHaveURL(/\/home$/u);

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
