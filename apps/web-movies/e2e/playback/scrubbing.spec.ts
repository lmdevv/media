import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devices, expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

import { createLibrary, removeLibrary, titlesByName } from "../stack/libraries";
import type { LibraryId, TitleId } from "../stack/libraries";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import {
  NO_STACK,
  createPerson,
  moviesPath,
  reachableStack,
  signIn,
  signInClient,
  signedInPage,
} from "../stack/people";
import type { Client } from "../stack/people";
import {
  capture,
  encodeClip,
  expectPlayingPast,
  expectPositionNear,
  movieNfo,
  offline,
  revealControls,
  writeText,
} from "./playback-stack";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

const SETUP_TIMEOUT_MS = 240_000;

const run = Date.now().toString(36);

const MOVIE = "Harbour Lights";

const SECONDS = 100;

const CHAPTERS = [
  { start: 0, title: "Arrival" },
  { start: 40, title: "Storm" },
  { start: 70, title: "Dawn" },
] as const;

let workspace = "";

let media: MediaService | undefined;

let owner: Client;

let libraryId: LibraryId | undefined;

let context: BrowserContext;

let page: Page;

let titleId: TitleId;

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "movies-web-scrubbing-"));

  const folder = join(workspace, "Films", `${MOVIE} (2021)`);

  await Promise.all([
    encodeClip(join(folder, `${MOVIE} (2021).mp4`), {
      seconds: SECONDS,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
      chapters: CHAPTERS,
    }),
    writeText(join(folder, "movie.nfo"), movieNfo(MOVIE, 2021)),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  owner = await signInClient(stack, await createPerson(stack, "admin"));

  const { platform } = owner;

  libraryId = await createLibrary(platform, {
    name: `Scrubbing ${run}`,
    folders: [join(workspace, "Films")],
  });

  const id = (await titlesByName(platform, libraryId)).get(MOVIE);

  if (id === undefined) throw new Error(`${MOVIE} was not scanned`);
  titleId = id;

  await expect
    .poll(
      async () =>
        (await platform.movies.titles.get({ titleId })).files[0]?.trickplay?.sheetCount ?? 0,
      { timeout: 60_000 },
    )
    .toBe(1);

  context = await browser.newContext();
  page = await context.newPage();
  await signIn(page, owner.person);
});

test.afterAll(async () => {
  if (stack === null) return;

  await context.close();
  await removeLibrary(owner.platform, libraryId);
  await owner.platform.dispose();
  await media?.stop();
  await rm(workspace, { recursive: true, force: true });
});

const openPaused = async (target: Page): Promise<void> => {
  await target.goto(moviesPath(`/watch/${titleId}?start=0`));
  await expectPlayingPast(target, 0.5);
  await target.keyboard.press("k");
  await revealControls(target);
};

const hoverScrubber = async (target: Page, fraction: number): Promise<void> => {
  const box = await target.locator('[data-slot="scrubber"]').boundingBox();

  if (box === null) throw new Error("The scrubber is not on screen");

  await target.mouse.move(box.x + box.width * fraction, box.y + box.height / 2);
};

const thumbnailStyle = (target: Page) =>
  target
    .locator('[data-slot="scrubber-hover"] [data-slot="sprite-thumbnail"]')
    .evaluate((element) => {
      if (!(element instanceof HTMLElement)) throw new Error("The thumbnail is not an element");

      return {
        image: element.style.backgroundImage,
        position: element.style.backgroundPosition,
      };
    });

test("hovering the scrubber shows the frame, chapter, and time under the pointer", async () => {
  await openPaused(page);
  await expect(page.locator('[data-slot="scrubber-chapter-mark"]')).toHaveCount(2);

  await hoverScrubber(page, 0.5);

  const hover = page.locator('[data-slot="scrubber-hover"]');

  await expect(hover.locator('[data-slot="scrubber-time"]')).toHaveText(/^0:(49|50)$/u);
  await expect(hover.locator('[data-slot="scrubber-chapter"]')).toHaveText("Storm");

  const style = await thumbnailStyle(page);

  expect(style.image).toMatch(
    /\/media\/trickplay\/[a-z0-9]+\/[0-9a-z]+-[0-9a-z]+\/0\.jpg\?ticket=t1\./u,
  );
  expect(style.position).toMatch(/^(44\.4|55\.5)\d*% 0%$/u);

  const sheet = await page.evaluate(
    async (url) => {
      const response = await fetch(url);

      return { status: response.status, type: response.headers.get("content-type") };
    },
    /url\("(.+)"\)/u.exec(style.image)?.[1] ?? "",
  );

  expect(sheet).toEqual({ status: 200, type: "image/jpeg" });
  await capture(page, "scrub-thumbnail");

  await hoverScrubber(page, 0.1);
  await expect(hover.locator('[data-slot="scrubber-chapter"]')).toHaveText("Arrival");
});

test("the Chapters menu lists each chapter with its frame and plays from its start", async () => {
  await openPaused(page);
  await page.getByRole("button", { name: "Chapters" }).click();

  const menu = page.getByRole("dialog", { name: "Chapters" });

  await expect(menu.getByRole("button")).toHaveText([/Arrival/u, /Storm/u, /Dawn/u]);
  await expect(menu.locator('[data-slot="sprite-thumbnail"]')).toHaveCount(3);
  await capture(page, "chapters-menu");
  await menu.getByRole("button", { name: /Dawn/u }).click();
  await expectPositionNear(page, 70, 1);
  await expect(menu).toBeHidden();
});

test("a keyboard seek shows its thumbnail for a moment", async () => {
  await openPaused(page);
  await page.keyboard.press("l");

  const hover = page.locator('[data-slot="scrubber-hover"]');

  await expect(hover.locator('[data-slot="sprite-thumbnail"]')).toBeVisible();
  await expect(hover.locator('[data-slot="scrubber-time"]')).toHaveText(/^0:1[01]$/u);
  await expect(hover).toBeHidden({ timeout: 5_000 });
});

test("seeking with the focused scrubber's keys shows the thumbnail too", async () => {
  await openPaused(page);
  await page.getByRole("slider", { name: "Seek" }).focus();
  await page.keyboard.press("PageUp");

  const hover = page.locator('[data-slot="scrubber-hover"]');

  await expect(hover.locator('[data-slot="sprite-thumbnail"]')).toBeVisible();
  await expect(hover).toBeHidden({ timeout: 5_000 });
});

test("dragging the phone scrubber shows the thumbnail", async ({ browser }) => {
  const handset = await signedInPage(browser, owner.person, { ...devices["iPhone 13 landscape"] });
  const phone = handset.context();

  await handset.goto(moviesPath(`/watch/${titleId}?start=0`));
  await expectPlayingPast(handset, 0.5);
  await handset.getByTestId("player-video").tap();

  const box = await handset.locator('[data-slot="scrubber"]').boundingBox();

  if (box === null) throw new Error("The phone scrubber is not on screen");

  await handset.mouse.move(box.x + 4, box.y + box.height / 2);
  await handset.mouse.down();
  await handset.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2, { steps: 5 });

  const hover = handset.locator('[data-slot="scrubber-hover"]');

  await expect(hover.locator('[data-slot="sprite-thumbnail"]')).toBeVisible();
  await expect(hover.locator('[data-slot="scrubber-chapter"]')).toHaveText("Dawn");
  await capture(handset, "scrub-thumbnail-phone");
  await handset.mouse.up();
  await expectPositionNear(handset, 75, 3);
  await phone.close();
});
