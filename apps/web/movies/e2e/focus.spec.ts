import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { NO_STACK, createPerson, moviesPath, reachableStack, signIn } from "./stack/people";
import type { Person } from "./stack/people";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

let person: Person | undefined;

test.beforeAll(async () => {
  if (stack !== null) person = await createPerson(stack, "focus", "member");
});

test.beforeEach(async ({ page }) => {
  if (person !== undefined) await signIn(page, person);

  await page.goto(moviesPath("/dev/kit"));
  await expect(page.getByRole("button", { name: "Open command menu" })).toBeVisible();
});

const focusedTag = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.activeElement?.tagName ?? null);

/** Whether the element has focus and shows the keyboard focus ring. */
const ringed = (locator: Locator): Promise<boolean> =>
  locator.evaluate(
    (element) => element === document.activeElement && element.matches(":focus-visible"),
  );

test("a clicked button keeps no focus; Tab rings the next one and Enter presses it", async ({
  page,
}) => {
  const all = page.getByRole("button", { name: "All", exact: true });
  const sciFi = page.getByRole("button", { name: "Sci-fi", exact: true });

  await all.click();
  await expect(all).toHaveAttribute("aria-pressed", "true");
  expect(await focusedTag(page)).toBe("BODY");

  await page.keyboard.press("Tab");
  await expect.poll(() => ringed(sciFi)).toBe(true);

  await page.keyboard.press("Enter");
  await expect(sciFi).toHaveAttribute("aria-pressed", "true");
  expect(await ringed(sciFi)).toBe(true);
});

test("a popover returns focus to its trigger after a keyboard open, and to nothing after a click", async ({
  page,
}) => {
  const trigger = page.getByRole("button", { name: "Audio and subtitles" });
  const popover = page.getByRole("dialog", { name: "Audio and subtitles" });

  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect.poll(() => ringed(trigger)).toBe(true);

  await trigger.click();
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect.poll(() => focusedTag(page)).toBe("BODY");
});

test("the command menu returns focus to its button only when the keyboard opened it", async ({
  page,
}) => {
  const button = page.getByRole("button", { name: "Open command menu" });
  const menu = page.getByRole("dialog", { name: "Command menu" });

  await button.click();
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect.poll(() => focusedTag(page)).toBe("BODY");

  await button.focus();
  await page.keyboard.press("Enter");
  await expect(menu).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect.poll(() => ringed(button)).toBe(true);
});
