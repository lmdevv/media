import { expect, test } from "@playwright/test";
import type { Locator } from "@playwright/test";

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

const edges = async (
  locator: Locator,
): Promise<{ readonly left: number; readonly right: number; readonly bottom: number }> => {
  const box = await locator.boundingBox();

  if (box === null) throw new Error(`${locator.toString()} is not on screen`);

  return {
    left: Math.round(box.x),
    right: Math.round(box.x + box.width),
    bottom: Math.round(box.y + box.height),
  };
};

test("a long hero overview shows three lines until More opens it", async ({ page }) => {
  await page.setViewportSize({ width: 1710, height: 1000 });
  await page.goto(moviesPath("/dev/kit"));

  const hero = page.locator('[data-slot="hero"]');
  const overview = hero.getByText(/^Paul Atreides unites/u);

  const lines = () =>
    overview.evaluate((element) =>
      Math.round(element.clientHeight / Number.parseFloat(getComputedStyle(element).lineHeight)),
    );

  await expect(hero.getByRole("button", { name: "More", exact: true })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  expect(await lines()).toBe(3);

  await hero.getByRole("button", { name: "More", exact: true }).click();
  await expect(hero.getByRole("button", { name: "Less", exact: true })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(await lines()).toBeGreaterThan(3);
  expect((await edges(hero.getByRole("button", { name: "Play" }))).bottom).toBeLessThanOrEqual(
    (await edges(hero)).bottom,
  );
});

for (const width of [1710, 1280]) {
  test(`at ${width}px a row's title, See all and first card line up with the top bar`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(moviesPath("/dev/kit"));

    const bar = await edges(page.locator('[data-slot="hero"] [data-slot="top-bar"]'));
    const row = page.getByRole("region", { name: "Continue watching for Alex" });

    expect((await edges(row.getByRole("heading"))).left).toBe(bar.left);
    expect((await edges(row.locator("[data-media-row] > *").first())).left).toBe(bar.left);
    expect((await edges(row.getByText("See all"))).right).toBe(bar.right);
  });
}
