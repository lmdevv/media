import { expect, test } from "@playwright/test";

import { NO_STACK, createPerson, moviesPath, reachableStack, signIn } from "./stack/people";
import type { Person } from "./stack/people";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

let person: Person | undefined;

test.beforeAll(async () => {
  if (stack !== null) person = await createPerson(stack, "kit", "member");
});

test.beforeEach(async ({ page }) => {
  if (person !== undefined) await signIn(page, person);
});

test("the command menu filters, nests and goes back with the keyboard", async ({ page }) => {
  await page.goto(moviesPath("/dev/kit"));
  await expect(page.getByRole("button", { name: "Open command menu" })).toBeVisible();
  await page.keyboard.press("ControlOrMeta+k");

  const input = page.getByRole("combobox");
  const active = page.locator('[role="option"][aria-selected="true"]');

  await expect(active).toContainText("Severance");
  await page.keyboard.press("ArrowDown");
  await expect(active).toContainText("Dune: Part Two");
  await page.keyboard.press("Control+p");
  await expect(active).toContainText("Severance");

  await input.fill("subt");
  await page.keyboard.press("Enter");
  await expect(input).toHaveAttribute("placeholder", "Language…");
  await expect(page.getByText("Subtitles · Severance")).toBeVisible();

  await page.keyboard.press("Backspace");
  await expect(input).toHaveValue("subt");

  await input.fill("the brutalist");
  await expect(page.getByText("No results for “the brutalist”")).toBeVisible();
  await expect(active).toContainText("Search unmatched files");

  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("rows take focus with j and k and move between cards with arrows", async ({ page }) => {
  await page.goto(moviesPath("/dev/kit"));
  await expect(page.getByRole("button", { name: "Open command menu" })).toBeVisible();

  const focused = page.locator(":focus");

  await page.keyboard.press("j");
  await expect(focused).toContainText("Dune: Part Two");
  await page.keyboard.press("ArrowRight");
  await expect(focused).toContainText("Severance · S2:E4");
  await page.keyboard.press("j");
  await expect(focused).toContainText("Andor");
  await page.keyboard.press("k");
  await expect(focused).toContainText("Severance · S2:E4");
});
