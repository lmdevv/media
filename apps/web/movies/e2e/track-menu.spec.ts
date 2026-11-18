import { devices, expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { expectAboveTrigger, settled } from "./menu-geometry";

import {
  NO_STACK,
  createPerson,
  moviesPath,
  reachableStack,
  signIn,
  signedInPage,
} from "./stack/people";
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

/** The kit's person, once `beforeAll` made them. */
const kitPerson = (): Person => {
  if (person === undefined) throw new Error("The kit's person was not made");

  return person;
};

const LABEL = "Audio, subtitles, and quality";

const HEADINGS = {
  "1": ["Subtitles"],
  "3": ["Audio", "Subtitles", "Quality"],
  "4": ["Version", "Audio", "Subtitles", "Quality"],
} as const;

const FIRST_SUBTITLE = "Off";

const CHOSEN_SUBTITLE = "Українська";

const NEXT_SUBTITLE = "Русский";

const LAST_SUBTITLE = "简体中文";

const FIRST_AUDIO = "English · Dolby TrueHD 7.1 Atmos";

const openMenu = async (page: Page): Promise<Locator> => {
  await page.getByRole("button", { name: LABEL }).click();

  const menu = page.getByRole("dialog", { name: LABEL });

  await settled(menu);

  return menu;
};

const open = async (page: Page, columns: keyof typeof HEADINGS): Promise<Locator> => {
  await page.goto(moviesPath(`/dev/tracks?columns=${columns}`));

  return openMenu(page);
};

const drag = async (
  page: Page,
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
): Promise<void> => {
  const cdp = await page.context().newCDPSession(page);

  const touch = async (type: "touchStart" | "touchMove", share: number) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: [{ x: from.x + (to.x - from.x) * share, y: from.y + (to.y - from.y) * share }],
    });

  await touch("touchStart", 0);
  await touch("touchMove", 1 / 3);
  await touch("touchMove", 2 / 3);
  await touch("touchMove", 1);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
};

const expectContained = async (page: Page, menu: Locator): Promise<void> =>
  expectAboveTrigger(page, menu, page.getByRole("button", { name: LABEL }));

const expectHeadings = async (menu: Locator, headings: ReadonlyArray<string>): Promise<void> => {
  const hidden = await menu.evaluate((popup, names) => {
    const bounds = popup.getBoundingClientRect();
    const labels = [...popup.querySelectorAll("span")];

    return names.filter((name) => {
      const heading = labels.find((label) => label.textContent === name);

      if (heading === undefined) return true;

      heading.scrollIntoView({ block: "nearest", inline: "nearest" });

      const box = heading.getBoundingClientRect();

      return (
        box.left < Math.max(0, bounds.left) ||
        box.top < Math.max(0, bounds.top) ||
        box.right > Math.min(window.innerWidth, bounds.right) ||
        box.bottom > Math.min(window.innerHeight, bounds.bottom)
      );
    });
  }, headings);

  expect(hidden).toEqual([]);
};

const expectNoClippedLabels = async (menu: Locator): Promise<void> => {
  const clipped = await menu
    .getByRole("radio")
    .evaluateAll((radios) =>
      radios
        .filter((radio) => radio.scrollWidth > radio.clientWidth + 1)
        .map((radio) => radio.textContent),
    );

  expect(clipped).toEqual([]);
};

const subtitle = (menu: Locator, name: string): Locator =>
  menu.getByRole("radiogroup", { name: "Subtitles" }).getByRole("radio", { name, exact: true });

const expectWholeFocusRing = async (page: Page): Promise<void> => {
  const ring = await page.evaluate(() => {
    const focused = document.activeElement;
    const list = focused?.closest('[role="radiogroup"]');

    if (!(focused instanceof HTMLElement) || !(list instanceof HTMLElement)) return null;

    const style = getComputedStyle(focused);
    const reach = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
    const box = focused.getBoundingClientRect();
    const bounds = list.getBoundingClientRect();

    return {
      visible: focused.matches(":focus-visible") && reach > 0,
      inside: box.top - reach >= bounds.top && box.bottom + reach <= bounds.bottom,
    };
  });

  expect(ring).toEqual({ visible: true, inside: true });
};

const headingBoxes = async (menu: Locator, headings: ReadonlyArray<string>) =>
  Promise.all(
    headings.map(async (heading) => menu.getByText(heading, { exact: true }).boundingBox()),
  );

for (const columns of ["1", "3", "4"] as const) {
  test(`a ${columns} column menu fits a desktop window and opens on the chosen subtitle`, async ({
    page,
  }) => {
    const menu = await open(page, columns);

    await expectContained(page, menu);
    await expectHeadings(menu, HEADINGS[columns]);
    await expect(subtitle(menu, CHOSEN_SUBTITLE)).toBeChecked();
    await expect(subtitle(menu, CHOSEN_SUBTITLE)).toBeInViewport({ ratio: 1 });
    await expect(subtitle(menu, FIRST_SUBTITLE)).not.toBeInViewport();
    await expectNoClippedLabels(menu);
  });
}

const WINDOWS = [
  { name: "a short window", viewport: { width: 1280, height: 360 } },
  { name: "a phone held sideways", viewport: devices["iPhone 13 landscape"].viewport },
  { name: "a phone held upright", viewport: devices["iPhone 13"].viewport },
  { name: "a small phone held sideways", viewport: { width: 568, height: 320 } },
] as const;

for (const { name, viewport } of WINDOWS) {
  test(`four columns stay inside ${name}`, async ({ page }) => {
    await page.setViewportSize(viewport);

    const menu = await open(page, "4");

    await expectContained(page, menu);
    await expectHeadings(menu, ["Subtitles"]);
    await expect(subtitle(menu, CHOSEN_SUBTITLE)).toBeInViewport({ ratio: 1 });
    await expectHeadings(menu, HEADINGS["4"]);
    await expectContained(page, menu);
    await expectNoClippedLabels(menu);
  });
}

test("rotating a phone with the menu open keeps it inside and on the chosen subtitle", async ({
  page,
}) => {
  await page.setViewportSize(devices["iPhone 13"].viewport);

  const menu = await open(page, "3");

  await expectContained(page, menu);
  await page.setViewportSize(devices["iPhone 13 landscape"].viewport);
  await expect.poll(async () => (await menu.boundingBox())?.y ?? -1).toBeGreaterThanOrEqual(0);
  await expectContained(page, menu);
  await expect(subtitle(menu, CHOSEN_SUBTITLE)).toBeInViewport({ ratio: 1 });
});

test("text at double size keeps the menu inside the window and readable", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(moviesPath("/dev/tracks?columns=4"));
  await page.addStyleTag({
    content: `:root { font-size: 200%; --text-body: 30px; --leading-label: 36px;
      --text-caption: 24px; --leading-caption: 32px; }`,
  });

  const menu = await openMenu(page);

  await expectContained(page, menu);
  await expect(subtitle(menu, CHOSEN_SUBTITLE)).toBeInViewport({ ratio: 1 });
  await expectHeadings(menu, HEADINGS["4"]);
  await expectNoClippedLabels(menu);
});

test("a window resized after the viewer scrolls keeps their place", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 600 });

  const menu = await open(page, "4");

  await subtitle(menu, CHOSEN_SUBTITLE).hover();
  await page.mouse.wheel(0, -8000);
  await expect(subtitle(menu, FIRST_SUBTITLE)).toBeInViewport({ ratio: 1 });

  const before = (await menu.boundingBox())?.height ?? 0;

  await page.setViewportSize({ width: 1280, height: 420 });
  await expect.poll(async () => (await menu.boundingBox())?.height ?? 0).toBeLessThan(before);
  await expect(subtitle(menu, FIRST_SUBTITLE)).toBeInViewport({ ratio: 1 });
  await expect(subtitle(menu, CHOSEN_SUBTITLE)).not.toBeInViewport();
});

test("a choice in another column keeps a scrolled column's place", async ({ page }) => {
  const menu = await open(page, "4");

  await subtitle(menu, CHOSEN_SUBTITLE).hover();
  await page.mouse.wheel(0, -8000);
  await expect(subtitle(menu, FIRST_SUBTITLE)).toBeInViewport({ ratio: 1 });

  await menu.getByRole("radio", { name: "720p", exact: true }).click();
  await expect(menu.getByRole("radio", { name: "720p", exact: true })).toBeChecked();
  await expect(subtitle(menu, FIRST_SUBTITLE)).toBeInViewport({ ratio: 1 });
  await expect(subtitle(menu, CHOSEN_SUBTITLE)).not.toBeInViewport();
});

test("the wheel scrolls one column, leaving the headings and the other columns still", async ({
  page,
}) => {
  const menu = await open(page, "4");
  const headings = await headingBoxes(menu, HEADINGS["4"]);

  await subtitle(menu, CHOSEN_SUBTITLE).hover();
  await page.mouse.wheel(0, 4000);
  await expect(subtitle(menu, LAST_SUBTITLE)).toBeInViewport({ ratio: 1 });
  await page.mouse.wheel(0, -8000);
  await expect(subtitle(menu, FIRST_SUBTITLE)).toBeInViewport({ ratio: 1 });

  await expect(menu.getByRole("radio", { name: "Auto", exact: true })).toBeInViewport({ ratio: 1 });
  await expect(menu.getByRole("radio", { name: FIRST_AUDIO })).toBeInViewport({ ratio: 1 });
  expect(await headingBoxes(menu, HEADINGS["4"])).toEqual(headings);
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);
  await expectContained(page, menu);
});

test("arrow keys bring each subtitle into view; Escape closes back to the trigger", async ({
  page,
}) => {
  const menu = await open(page, "4");

  await expect(menu.getByRole("radio", { name: /^1080p Theatrical/u })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(menu.getByRole("radio", { name: FIRST_AUDIO })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(subtitle(menu, CHOSEN_SUBTITLE)).toBeFocused();

  await expect(subtitle(menu, NEXT_SUBTITLE)).not.toBeInViewport({ ratio: 1 });
  await page.keyboard.press("ArrowDown");
  await expect(subtitle(menu, NEXT_SUBTITLE)).toBeFocused();
  await expect(subtitle(menu, NEXT_SUBTITLE)).toBeInViewport({ ratio: 1 });
  await expectWholeFocusRing(page);

  await page.mouse.move(0, 0);
  await subtitle(menu, NEXT_SUBTITLE).hover();
  await page.mouse.wheel(0, -8000);
  await subtitle(menu, FIRST_SUBTITLE).click();
  await page.keyboard.press("ArrowUp");
  await expect(subtitle(menu, LAST_SUBTITLE)).toBeFocused();
  await expect(subtitle(menu, LAST_SUBTITLE)).toBeChecked();
  await expect(subtitle(menu, LAST_SUBTITLE)).toBeInViewport({ ratio: 1 });
  await expectWholeFocusRing(page);
  await page.keyboard.press("ArrowDown");
  await expect(subtitle(menu, FIRST_SUBTITLE)).toBeFocused();
  await expect(subtitle(menu, FIRST_SUBTITLE)).toBeInViewport({ ratio: 1 });
  await expectWholeFocusRing(page);
  await expect(menu.getByText("Subtitles", { exact: true })).toBeInViewport({ ratio: 1 });

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.getByRole("button", { name: LABEL })).toBeFocused();
});

test("a finger drags one column's options, not the page", async ({ browser }) => {
  const page = await signedInPage(browser, kitPerson(), { ...devices["iPhone 13 landscape"] });
  const phone = page.context();

  try {
    const menu = await open(page, "3");
    const headings = await headingBoxes(menu, HEADINGS["3"]);
    const list = await menu.getByRole("radiogroup", { name: "Subtitles" }).boundingBox();

    if (list === null) throw new Error("Nothing to drag");

    const x = list.x + list.width / 2;

    await drag(page, { x, y: list.y + list.height - 4 }, { x, y: list.y + 4 });

    await expect(subtitle(menu, CHOSEN_SUBTITLE)).not.toBeInViewport({ ratio: 1 });
    await expect(menu.getByRole("radio", { name: FIRST_AUDIO })).toBeInViewport({ ratio: 1 });
    expect(await headingBoxes(menu, HEADINGS["3"])).toEqual(headings);
    await expectContained(page, menu);
  } finally {
    await phone.close();
  }
});

test("a finger swiping sideways over the options brings the next columns", async ({ browser }) => {
  const page = await signedInPage(browser, kitPerson(), { ...devices["iPhone 13"] });
  const phone = page.context();

  try {
    const menu = await open(page, "4");
    const version = menu.getByText("Version", { exact: true });
    const start = (await version.boundingBox())?.x ?? 0;
    const list = await menu.getByRole("radiogroup", { name: "Version" }).boundingBox();

    if (list === null) throw new Error("Nothing to swipe");

    const y = list.y + list.height / 2;

    await drag(page, { x: list.x + list.width - 4, y }, { x: list.x + 4, y });

    await expect.poll(async () => (await version.boundingBox())?.x ?? start).toBeLessThan(start);
    await expectContained(page, menu);
  } finally {
    await phone.close();
  }
});

test("in full screen the menu renders inside the player and inside the screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 400 });
  await page.goto(moviesPath("/dev/tracks?columns=4"));
  await page.getByRole("button", { name: "Full screen" }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);

  const menu = await openMenu(page);

  expect(await menu.evaluate((popup) => document.fullscreenElement?.contains(popup) ?? false)).toBe(
    true,
  );
  await expectContained(page, menu);
  await expectHeadings(menu, HEADINGS["4"]);
  await expect(subtitle(menu, CHOSEN_SUBTITLE)).toBeInViewport({ ratio: 1 });

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(page.getByRole("button", { name: LABEL })).toBeFocused();
});
