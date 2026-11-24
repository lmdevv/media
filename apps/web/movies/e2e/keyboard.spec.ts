import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { NO_STACK, createPerson, moviesPath, reachableStack, signIn } from "./stack/people";
import type { Person } from "./stack/people";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

let person: Person | undefined;

test.beforeAll(async () => {
  if (stack !== null) person = await createPerson(stack, "keys", "member");
});

test.beforeEach(async ({ page }) => {
  if (person !== undefined) await signIn(page, person);
});

const openHome = async (page: Page): Promise<void> => {
  await page.goto(moviesPath());
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
};

const openKit = async (page: Page): Promise<void> => {
  await page.goto(moviesPath("/dev/kit"));
  await expect(page.getByRole("button", { name: "Open command menu" })).toBeVisible();
};

const press = async (page: Page, ...keys: ReadonlyArray<string>): Promise<void> => {
  const [key, ...rest] = keys;

  if (key === undefined) return;
  await page.keyboard.press(key);
  await press(page, ...rest);
};

test("two-key sequences go to each section", async ({ page }) => {
  await openHome(page);

  await press(page, "g", "m");
  await expect(page).toHaveURL(/\/movies\/movies$/u);
  await press(page, "g", "s");
  await expect(page).toHaveURL(/\/movies\/shows$/u);
  await press(page, "g", "l");
  await expect(page).toHaveURL(/\/movies\/my-list$/u);
  await press(page, "g", ",");
  await expect(page).toHaveURL(/\/movies\/settings/u);
  await press(page, "g", "h");
  await expect(page).toHaveURL(/\/movies\/$/u);
});

test("a sequence waits one second for its second key and restarts on a stray one", async ({
  page,
}) => {
  await openHome(page);

  await page.keyboard.press("g");
  await page.waitForTimeout(1300);
  await page.keyboard.press("m");
  await page.waitForTimeout(300);
  await expect(page).toHaveURL(/\/movies\/$/u);

  await page.keyboard.press("g");
  await page.waitForTimeout(500);
  await page.keyboard.press("m");
  await expect(page).toHaveURL(/\/movies\/movies$/u);

  await press(page, "g", "x", "g", "l");
  await expect(page).toHaveURL(/\/movies\/my-list$/u);
});

test("slash opens the command menu, and the menu shortcut toggles it even from its own field", async ({
  page,
}) => {
  await openHome(page);

  const menu = page.getByRole("dialog", { name: "Command menu" });

  await page.keyboard.press("/");
  await expect(menu).toBeVisible();
  await expect(page.getByRole("combobox")).toBeFocused();

  await page.keyboard.press("ControlOrMeta+k");
  await expect(menu).toBeHidden();

  await page.keyboard.press("ControlOrMeta+k");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test("keys typed in a text field stay text, except the menu shortcut", async ({ page }) => {
  await page.goto(moviesPath("/search"));

  const field = page.getByRole("searchbox", { name: "Search titles" });

  await expect(field).toBeFocused();
  await press(page, "g", "m", "/", "j");
  await expect(field).toHaveValue("gm/j");
  await expect(page).toHaveURL(/\/movies\/search/u);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.getByRole("dialog", { name: "Command menu" })).toBeVisible();
});

test("an open dialog keeps the keys pressed inside it", async ({ page }) => {
  await openKit(page);
  await page.getByRole("button", { name: "Open command menu" }).click();

  const option = page.getByRole("option").first();

  await option.focus();
  await page.keyboard.press("j");
  await expect(option).toBeFocused();
});

test("a held key runs its shortcut once", async ({ page }) => {
  await openKit(page);

  const focused = page.locator(":focus");

  await page.keyboard.down("j");
  await page.keyboard.down("j");
  await page.keyboard.down("j");
  await page.keyboard.up("j");
  await expect(focused).toContainText("Dune: Part Two");
});

test("a shortcut marks its key press handled and skips one something else handled", async ({
  page,
}) => {
  await openKit(page);
  await page.evaluate(() => {
    const root = document.documentElement;

    window.addEventListener("keydown", (event) => {
      const seen = `${event.key}:${String(event.defaultPrevented)}`;

      root.dataset["seenKeys"] = [root.dataset["seenKeys"], seen].filter(Boolean).join(" ");
    });
  });

  const focused = page.locator(":focus");

  await press(page, "j", "x");
  await expect(page.locator("html")).toHaveAttribute("data-seen-keys", "j:true x:false");
  await expect(focused).toContainText("Dune: Part Two");

  await page.evaluate(() => {
    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "j") event.preventDefault();
      },
      true,
    );
  });
  await page.keyboard.press("j");
  await page.waitForTimeout(200);
  await expect(focused).toContainText("Dune: Part Two");
});

test("the command menu draws each shortcut's keys on its row", async ({ page }) => {
  await openKit(page);
  await page.keyboard.press("ControlOrMeta+k");

  const keysOf = (title: string) =>
    page.getByRole("option", { name: new RegExp(`^${title}`, "u") }).locator("kbd > kbd");

  await expect(keysOf("Home")).toHaveText(["G", "H"]);
  await expect(keysOf("My List")).toHaveText(["G", "L"]);
  await expect(keysOf("Settings")).toHaveText(["G", ","]);
});

test("the search button names its shortcut for this keyboard", async ({ page }) => {
  await openHome(page);

  const search = page.getByRole("button", { name: "Search", exact: true });

  await expect(search).toHaveAttribute("aria-keyshortcuts", /Control\+K/u);
  await expect(search).toContainText("Ctrl");
});
