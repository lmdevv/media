import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";

import { audioSeconds, pausedAt, watchMedia } from "./audio";
import { FIRST_SONG, startMediaService, writeMusicLibrary } from "./media-service";
import type { MediaService } from "./media-service";
import {
  NO_STACK,
  addHouseholdLibrary,
  createPerson,
  reachableStack,
  signIn,
  signInClient,
} from "./people";
import type { Person } from "./people";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

/** Long enough to pause, seek, and move inside one song. */
const SONG_SECONDS = 180;

/** A remote pause lands well inside this on a dev stack; the lane measures the real delay. */
const PAUSE_BOUND_MS = 1000;

let media: MediaService | undefined;

let album = "";

test.beforeAll(async () => {
  if (stack === null) return;

  const library = await writeMusicLibrary(SONG_SECONDS);

  album = library.album;
  media = await startMediaService(stack, library.root);
  await addHouseholdLibrary(stack, library.root);
});

test.afterAll(async () => {
  await media?.stop();
});

interface OpenBrowser {
  readonly context: BrowserContext;
  readonly page: Page;
}

/** A browser of its own, one device, with `person` signed in at `/music/`. */
const openBrowser = async (
  browser: Browser,
  baseURL: string | undefined,
  person: Person,
): Promise<OpenBrowser> => {
  const context = await browser.newContext(baseURL === undefined ? {} : { baseURL });
  const page = await context.newPage();

  await watchMedia(page);
  await signIn(page, person);
  await page.goto("/music/");

  return { context, page };
};

const playFirstSong = async (page: Page): Promise<void> => {
  await page.goto("/music/albums");
  await page.getByRole("link", { name: album }).first().click();
  await expect(page.getByRole("heading", { name: album })).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("row", { name: new RegExp(FIRST_SONG, "u") })
    .dblclick();
  await expect.poll(() => audioSeconds(page), { timeout: 30_000 }).toBeGreaterThan(1);
};

const playerOf = (page: Page) => page.getByRole("region", { name: "Player" });

test("a pause in one of Aiko's browsers pauses the other at once, and a move continues the song there", async ({
  browser,
  baseURL,
}) => {
  if (stack === null) return;

  const aiko = await createPerson(stack, "aiko", "member");
  const laptop = await openBrowser(browser, baseURL, aiko);
  const desk = await openBrowser(browser, baseURL, aiko);

  try {
    await playFirstSong(laptop.page);
    await desk.page.goto("/music/");
    await expect(desk.page.getByRole("status").filter({ hasText: "Playing on" })).toBeVisible({
      timeout: 15_000,
    });

    const sentAt = await desk.page.evaluate(() => Date.now());

    await playerOf(desk.page).getByRole("button", { name: "Pause", exact: true }).click();
    await expect.poll(() => audioSeconds(laptop.page)).toBe(0);

    const delay = (await pausedAt(laptop.page)) - sentAt;

    console.log(`remote pause landed after ${String(delay)} ms`);
    expect(delay).toBeLessThan(PAUSE_BOUND_MS);

    await playerOf(desk.page).getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(() => audioSeconds(laptop.page)).toBeGreaterThan(0);

    const before = await audioSeconds(laptop.page);

    await desk.page.getByRole("button", { name: "Play on another device" }).click();
    await desk.page.getByRole("menuitemradio", { name: /This browser/u }).click();

    await expect.poll(() => audioSeconds(desk.page), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(() => audioSeconds(laptop.page)).toBe(0);
    expect(Math.abs((await audioSeconds(desk.page)) - before)).toBeLessThan(5);
    await expect(desk.page.getByRole("status").filter({ hasText: "Playing on" })).toHaveCount(0);
    await expect(laptop.page.getByRole("status").filter({ hasText: "Playing on" })).toBeVisible();
  } finally {
    await laptop.context.close();
    await desk.context.close();
  }
});

test("Aiko seeks her other browser, and plays an album there from the album's menu", async ({
  browser,
  baseURL,
}) => {
  if (stack === null) return;

  const aiko = await createPerson(stack, "aiko", "member");
  const laptop = await openBrowser(browser, baseURL, aiko);
  const desk = await openBrowser(browser, baseURL, aiko);

  try {
    await playFirstSong(laptop.page);
    await desk.page.goto("/music/");
    await expect(desk.page.getByRole("status").filter({ hasText: "Playing on" })).toBeVisible({
      timeout: 15_000,
    });

    // The seek bar's control, clicked two thirds along: 2 minutes into the 3-minute song.
    const bar = playerOf(desk.page)
      .getByRole("slider", { name: "Seek" })
      .locator("xpath=ancestor::div[contains(@class,'touch-none')][1]");

    const box = await bar.boundingBox();

    if (box === null) throw new Error("The seek bar has no box");
    await bar.click({ position: { x: (box.width * 120) / SONG_SECONDS, y: box.height / 2 } });
    await expect.poll(() => audioSeconds(laptop.page)).toBeGreaterThan(115);
    expect(await audioSeconds(laptop.page)).toBeLessThan(130);

    await laptop.page.getByRole("button", { name: "Pause", exact: true }).first().click();
    await expect.poll(() => audioSeconds(laptop.page)).toBe(0);

    await desk.page.goto("/music/albums");
    await desk.page.getByRole("link", { name: album }).first().click();
    await desk.page
      .getByRole("button", { name: `More actions for ${album}` })
      .first()
      .click();
    await desk.page.getByRole("menuitem", { name: "Play on" }).click();
    await desk.page.getByRole("menuitem", { name: /Chrome/u }).click();

    await expect.poll(() => audioSeconds(laptop.page), { timeout: 15_000 }).toBeGreaterThan(0);
    await expect.poll(() => audioSeconds(laptop.page)).toBeLessThan(10);
    await expect(playerOf(laptop.page).getByText(FIRST_SONG)).toBeVisible();
  } finally {
    await laptop.context.close();
    await desk.context.close();
  }
});

test("a tab that takes over Aiko's browser stops the tab before it, so a remote pause silences the browser", async ({
  browser,
  baseURL,
}) => {
  if (stack === null) return;

  const aiko = await createPerson(stack, "aiko", "member");
  const laptop = await openBrowser(browser, baseURL, aiko);
  const phone = await openBrowser(browser, baseURL, aiko);
  const secondTab = await laptop.context.newPage();

  try {
    await watchMedia(secondTab);
    await playFirstSong(laptop.page);
    await playFirstSong(secondTab);

    await expect.poll(() => audioSeconds(laptop.page), { timeout: 15_000 }).toBe(0);
    expect(await audioSeconds(secondTab)).toBeGreaterThan(0);

    await phone.page.goto("/music/");
    await expect(phone.page.getByRole("status").filter({ hasText: "Playing on" })).toBeVisible({
      timeout: 15_000,
    });
    await playerOf(phone.page).getByRole("button", { name: "Pause", exact: true }).click();

    await expect.poll(() => audioSeconds(secondTab)).toBe(0);
    expect(await audioSeconds(laptop.page)).toBe(0);
  } finally {
    await laptop.context.close();
    await phone.context.close();
  }
});

test("Sam's list holds only his own devices, and Mateo cannot control Aiko's", async ({
  browser,
  baseURL,
}) => {
  if (stack === null) return;

  const aiko = await createPerson(stack, "aiko", "member");
  const sam = await createPerson(stack, "sam", "member");
  const mateo = await createPerson(stack, "mateo", "member");
  const laptop = await openBrowser(browser, baseURL, aiko);
  const samsLaptop = await openBrowser(browser, baseURL, sam);
  const aikoClient = await signInClient(stack, aiko);
  const mateoClient = await signInClient(stack, mateo);

  try {
    await playFirstSong(laptop.page);
    await samsLaptop.page.keyboard.press("d");

    const list = samsLaptop.page.getByRole("menu", { name: "Play on" });

    await expect(list.getByRole("menuitemradio")).toHaveCount(1);
    await expect(list.getByText("No other devices right now")).toBeVisible();

    const [target] = await aikoClient.core.connect.targets.list({});

    expect(target).toBeDefined();

    if (target === undefined) return;

    await expect(
      mateoClient.core.connect.targets.control({ deviceId: target.deviceId, playing: false }),
    ).rejects.toThrow();
    expect(await mateoClient.core.connect.targets.list({})).toStrictEqual([]);
    await expect.poll(() => audioSeconds(laptop.page)).toBeGreaterThan(0);
  } finally {
    await aikoClient.dispose();
    await mateoClient.dispose();
    await laptop.context.close();
    await samsLaptop.context.close();
  }
});
