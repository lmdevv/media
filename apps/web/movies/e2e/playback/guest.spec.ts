import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createLibrary, removeLibrary, titlesByName } from "../stack/libraries";
import type { LibraryId, TitleId } from "../stack/libraries";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import { NO_STACK, createPerson, reachableStack, signInClient, signIn } from "../stack/people";
import { refuseIdentityOnce, refuseQueryOnce } from "../session/identity";
import type { Client } from "../stack/people";
import {
  encodeClip,
  episodeNfo,
  expectPlayingPast,
  movieNfo,
  offline,
  revealControls,
  showNfo,
  videoState,
  writeText,
} from "./playback-stack";

test.use({ trace: "off", screenshot: "off", video: "off" });

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

const SETUP_TIMEOUT_MS = 240_000;

const run = Date.now().toString(36);

const MOVIE = "Guest Movie";

const SHOW = "Guest Show";

const EPISODES = ["First Crossing", "Second Crossing"] as const;

const EPISODE_SECONDS = 60;

let workspace = "";

let media: MediaService | undefined;

let host: Client;

const libraries: Array<LibraryId> = [];

const titles = new Map<string, TitleId>();

const pages: Array<Page> = [];

const titleId = (name: string): TitleId => {
  const id = titles.get(name);

  if (id === undefined) throw new Error("Guest fixture title missing");

  return id;
};

test.beforeAll(async () => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "media-web-together-"));

  const films = join(workspace, "Films");
  const shows = join(workspace, "Shows");
  const movieFolder = join(films, `${MOVIE} (2022)`);
  const season = join(shows, `${SHOW} (2021)`, "Season 01");

  await Promise.all([
    encodeClip(join(movieFolder, `${MOVIE} (2022).mp4`), {
      seconds: 180,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(movieFolder, "movie.nfo"), movieNfo(MOVIE, 2022)),
    writeText(join(shows, `${SHOW} (2021)`, "tvshow.nfo"), showNfo(SHOW, 2021)),
    ...EPISODES.flatMap((name, index) => {
      const stem = join(season, `${SHOW} - S01E0${String(index + 1)}`);

      return [
        encodeClip(`${stem}.mp4`, {
          seconds: EPISODE_SECONDS,
          video: "h264",
          audio: [{ codec: "aac", language: "eng" }],
        }),
        writeText(`${stem}.nfo`, episodeNfo(1, index + 1, name)),
      ];
    }),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  host = await signInClient(stack, await createPerson(stack, "guest-host"));
  await host.platform.core.guests.configure({
    enabled: true,
    address: `http://localhost:${stack.moviesPort}`,
  });

  libraries.push(
    await createLibrary(host.platform, { name: `Together films ${run}`, folders: [films] }),
    await createLibrary(host.platform, { name: `Together shows ${run}`, folders: [shows] }),
  );

  await Promise.all(
    libraries.map((libraryId) =>
      host.platform.core.permissions.grants.set({
        resource: { type: "library", id: libraryId },
        principal: { kind: "household" },
        level: "view",
      }),
    ),
  );

  const scanned = await Promise.all(libraries.map((id) => titlesByName(host.platform, id)));

  for (const byName of scanned) byName.forEach((id, name) => titles.set(name, id));
});

test.afterAll(async () => {
  if (stack === null) return;

  await Promise.all(pages.map((page) => page.context().close()));
  await Promise.all(libraries.map((libraryId) => removeLibrary(host.platform, libraryId)));
  await host.platform.dispose();
  await media?.stop();
  await rm(workspace, { recursive: true, force: true });
});

type Target = Parameters<Client["platform"]["core"]["guests"]["links"]["create"]>[0]["target"];

const linkFor = (
  ref: Extract<Target, { readonly kind: "item" }>["item"],
): Promise<Awaited<ReturnType<Client["platform"]["core"]["guests"]["links"]["create"]>>> =>
  host.platform.core.guests.links.create({ target: { kind: "item", item: ref } });

const openGuest = async (page: Page, url: string): Promise<void> => {
  try {
    await page.goto(url);
  } catch {
    throw new Error("Guest link navigation failed");
  }

  await expect(page.getByRole("heading", { name: "Open as a guest" })).toBeVisible();
  expect(new URL(page.url()).hash).toBe("");
  await page.getByLabel("Display name").fill("Visitor");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page).toHaveURL(/\/movies\/guest$/u);
};

const play = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const press = page.getByRole("button", { name: "Play", exact: true });

  if (await press.isVisible()) await press.click();
  await expectPlayingPast(page, 1);
};

test("a movie guest plays, seeks, resumes once, and stops on revoke", async ({ page }) => {
  test.setTimeout(120_000);
  let pageErrors = 0;
  page.on("pageerror", () => {
    pageErrors += 1;
  });
  const link = await linkFor({ domain: "movies", ref: { type: "title", id: titleId(MOVIE) } });
  await openGuest(page, link.url);
  await expect(page.getByRole("heading", { name: MOVIE })).toBeVisible();
  await play(page);
  await revealControls(page);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.keyboard.press("l");
  await expect.poll(async () => (await videoState(page)).currentTime).toBeGreaterThan(9);

  await Promise.all(
    ["Cast", "Watch together", "Episodes", "Search", "Home", "Settings", "Download"].map((name) =>
      expect(page.getByRole("button", { name, exact: true })).toBeHidden(),
    ),
  );
  await page.reload();
  await expect(page.getByRole("heading", { name: MOVIE })).toBeVisible();

  const activity = await host.platform.core.guests.links.activity({
    linkId: link.linkId,
    paginationOpts: { numItems: 50, cursor: null },
  });

  expect(activity.page).toHaveLength(1);
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/movies\/guest$/u);
  expect(pageErrors).toBe(0);
  await play(page);
  await host.platform.core.guests.links.revoke({ linkId: link.linkId });
  await expect(page.getByRole("heading", { name: "This link isn't available" })).toBeVisible();
  await expect(page.getByTestId("player-video")).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "This link isn't available" })).toBeVisible();
});

test("a guest with a clock past the link expiry keeps watching until the server ends the link", async ({
  page,
}) => {
  const link = await linkFor({ domain: "movies", ref: { type: "title", id: titleId(MOVIE) } });
  await openGuest(page, link.url);
  await expect(page.getByRole("heading", { name: MOVIE })).toBeVisible();
  await page.clock.setFixedTime(new Date(link.expiresAt + 60_000));
  await page.reload();
  await expect(page.getByRole("heading", { name: MOVIE })).toBeVisible();
  await play(page);
  await host.platform.core.guests.links.revoke({ linkId: link.linkId });
  await expect(page.getByRole("heading", { name: "This link isn't available" })).toBeVisible();
  await expect(page.getByTestId("player-video")).toHaveCount(0);
});

test("a guest whose identity check fails can try again and keep watching", async ({ page }) => {
  const link = await linkFor({ domain: "movies", ref: { type: "title", id: titleId(MOVIE) } });
  await openGuest(page, link.url);
  await expect(page.getByRole("heading", { name: MOVIE })).toBeVisible();
  const refusals = await refuseIdentityOnce(page, "internal");
  await page.reload();
  await expect.poll(refusals).toBe(1);
  await expect(page.getByRole("heading", { name: "Can't reach the server" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "This link isn't available" })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: MOVIE })).toBeVisible();
  await expect(page).toHaveURL(/\/movies\/guest$/u);
});

test("a guest whose shared item fails to load can try again", async ({ page }) => {
  const link = await linkFor({ domain: "movies", ref: { type: "title", id: titleId(MOVIE) } });
  await openGuest(page, link.url);
  await expect(page.getByRole("heading", { name: MOVIE })).toBeVisible();
  const refusals = await refuseQueryOnce(page, "movies/playback:get", "internal");
  await page.reload();
  await expect.poll(refusals).toBe(1);
  await expect(page.getByRole("heading", { name: "Can't reach the server" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "This link isn't available" })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: MOVIE })).toBeVisible();
});

test("a guest whose link lookup fails after opening can try again", async ({ page }) => {
  const link = await linkFor({ domain: "movies", ref: { type: "title", id: titleId(MOVIE) } });
  const refusals = await refuseQueryOnce(page, "core/guests:current", "internal");
  await page.goto(link.url);
  await page.getByLabel("Display name").fill("Visitor");
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect.poll(refusals).toBe(1);
  await expect(page.getByRole("heading", { name: "Can't reach the server" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "This link isn't available" })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page).toHaveURL(/\/movies\/guest$/u);
  await expect(page.getByRole("heading", { name: MOVIE })).toBeVisible();
});

test("a show lists episodes, but episode and file links cannot reach siblings", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const showId = titleId(SHOW);
  const link = await linkFor({ domain: "movies", ref: { type: "title", id: showId } });
  const context = await browser.newContext();
  const page = await context.newPage();
  pages.push(page);
  await openGuest(page, link.url);
  await expect(page.getByRole("region", { name: "Episodes" })).toContainText(EPISODES[1]);
  await page.getByRole("button", { name: new RegExp(EPISODES[0], "u") }).click();
  await expectPlayingPast(page, 1);
  await revealControls(page);
  await page.getByRole("button", { name: "Back to details", exact: true }).click();
  await expect(page.getByRole("heading", { name: SHOW, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Episodes" })).toContainText(EPISODES[1]);
  await expect(page.getByRole("heading", { level: 2 })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Play", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: new RegExp(EPISODES[1], "u") }).click();
  await expectPlayingPast(page, 1);

  const episodes = await host.platform.movies.playback.episodes({
    titleId: showId,
    seasonNumber: 1,
    paginationOpts: { numItems: 50, cursor: null },
  });

  const first = episodes.page[0];

  if (first === undefined) throw new Error("Guest episode fixture missing");

  const details = await host.platform.movies.playback.get({
    item: { type: "episode", id: first.id },
  });

  const file = details.versions[0];

  if (file === undefined) throw new Error("Guest file fixture missing");

  await Promise.all(
    [{ type: "episode", id: first.id } as const, { type: "file", id: file.id } as const].map(
      async (ref) => {
        const single = await linkFor({ domain: "movies", ref });
        const soloContext = await browser.newContext();
        const solo = await soloContext.newPage();
        pages.push(solo);
        await openGuest(solo, single.url);
        await expect(solo.getByRole("region", { name: "Episodes" })).toHaveCount(0);
        await expect(solo.getByText(EPISODES[1], { exact: true })).toHaveCount(0);
        await play(solo);
        await revealControls(solo);
        await expect(solo.getByRole("button", { name: "Episodes", exact: true })).toBeHidden();
        await solo.goto(`/movies/title/${showId}`);
        await expect(solo).toHaveURL(/\/movies\/guest$/u);
        await expect(solo.getByRole("region", { name: "Episodes" })).toHaveCount(0);
        await solo.getByRole("button", { name: "Leave", exact: true }).click();
        await expect(solo.getByRole("heading", { name: "Sign in." })).toBeVisible();
      },
    ),
  );
});

for (const path of [
  "/invite#mi_invalid.secret",
  "/reset#mr_invalid.secret",
  "/device?code=ABCD-EFGH",
]) {
  test(`a guest keeps the ${path.split("#")[0]} entrance`, async ({ page }) => {
    const link = await linkFor({ domain: "movies", ref: { type: "title", id: titleId(MOVIE) } });
    await openGuest(page, link.url);

    await page.goto(path);
    await expect
      .poll(() => `${new URL(page.url()).pathname}${new URL(page.url()).search}`)
      .toBe(path.split("#")[0]);
    await expect(page.locator("main")).not.toBeEmpty();
    await expect(page.getByRole("heading", { name: MOVIE })).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe("");
  });
}

test("a new household session wins a guest redemption race without retrying it", async ({
  page,
  context,
}) => {
  if (stack === null) return;
  const person = await createPerson(stack, "guest-race", "member");
  await signIn(page, person);
  const link = await linkFor({ domain: "movies", ref: { type: "title", id: titleId(MOVIE) } });
  await page.goto(link.url).catch(() => {
    throw new Error("Guest navigation failed");
  });
  await page.getByRole("button", { name: "Continue as a guest" }).click();
  await page.getByLabel("Display name").fill("Visitor");
  const arrived = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let redemptions = 0;
  await page.route("**/api/auth/sign-in", async (route) => {
    redemptions += 1;
    const response = await route.fetch();
    arrived.resolve();
    await release.promise;
    await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await arrived.promise;
  const other = await context.newPage();
  await other.goto("/home");
  await other.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(other.getByLabel("Username")).toBeVisible();
  await signIn(other, person);
  await expect(other).toHaveURL(/\/home$/u);
  release.resolve();
  await expect(page.getByRole("heading", { name: "Someone else signed in here" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open", exact: true })).toHaveCount(0);
  expect(redemptions).toBe(1);

  const activity = await host.platform.core.guests.links.activity({
    linkId: link.linkId,
    paginationOpts: { numItems: 50, cursor: null },
  });

  expect(activity.page).toHaveLength(1);
  await page.getByRole("button", { name: "Leave", exact: true }).click();
  await expect(page.getByRole("heading", { name: `Hi, ${person.username}.` })).toBeVisible();
  await other.reload();
  await expect(other.getByRole("heading", { name: `Hi, ${person.username}.` })).toBeVisible();
});

test("music returns a movie guest to exactly its shared item", async ({ page }) => {
  if (stack === null) return;
  const errors: Array<string> = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const link = await linkFor({ domain: "movies", ref: { type: "title", id: titleId(MOVIE) } });
  await openGuest(page, link.url);
  await expect(page.getByRole("heading", { name: MOVIE })).toBeVisible();
  await page.goto("/music/");
  await expect(page).toHaveURL(/\/movies\/guest$/u);
  expect(errors).toEqual([]);
  await expect(page.getByRole("heading", { name: MOVIE })).toBeVisible();
  await expect(page.getByRole("link", { name: "Search", exact: true })).toHaveCount(0);
});
