import { expect, test } from "@playwright/test";

import { audioSeconds, watchMedia } from "./audio";
import { FIRST_SONG, SECOND_SONG, startMediaService, writeMusicLibrary } from "./media-service";
import type { MediaService } from "./media-service";
import {
  NO_STACK,
  addHouseholdLibrary,
  createPerson,
  reachableStack,
  signIn,
  signInClient,
} from "./people";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

let media: MediaService | undefined;

let album = "";

test.beforeAll(async () => {
  if (stack === null) return;

  const library = await writeMusicLibrary();
  const folder = library.root;

  album = library.album;
  media = await startMediaService(stack, folder);
  await addHouseholdLibrary(stack, folder);
});

test.afterAll(async () => {
  await media?.stop();
});

test("one sign-in at / opens /music signed in; a song plays and moves on to the next", async ({
  page,
}) => {
  if (stack === null) return;

  await watchMedia(page);

  const person = await createPerson(stack, "listener", "member");

  await signIn(page, person);
  await page.goto("/music/");

  await expect(page).toHaveURL(/\/music\/$/u);
  await expect(page.getByLabel("Username")).toHaveCount(0);

  await page.goto("/music/albums");
  await page.getByRole("link", { name: album }).first().click();
  await expect(page.getByRole("heading", { name: album })).toBeVisible();

  // A desktop row plays on a double click, as old music's did; its play button shows on hover.
  await page
    .getByRole("main")
    .getByRole("row", { name: new RegExp(FIRST_SONG, "u") })
    .dblclick();

  const player = page.getByRole("region", { name: "Player" });

  await expect(player.getByText(FIRST_SONG)).toBeVisible();
  await expect.poll(() => audioSeconds(page), { timeout: 30_000 }).toBeGreaterThan(1);
  await expect(player.getByText(SECOND_SONG)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => audioSeconds(page), { timeout: 30_000 }).toBeGreaterThan(0.5);
});

test("a member shares her private playlist with someone she picks, who then plays it", async ({
  browser,
  baseURL,
  page,
}) => {
  if (stack === null) return;

  const aiko = await createPerson(stack, "aiko", "member");
  const mateo = await createPerson(stack, "mateo", "member");
  const platform = await signInClient(stack, aiko);
  const name = `For Mateo ${aiko.username}`;

  const playlistId = await (async () => {
    try {
      const albums = await platform.music.albums.list({
        paginationOpts: { numItems: 100, cursor: null },
      });

      const found = albums.page.find((card) => card.title === album);

      if (found === undefined) throw new Error(`no album ${album}`);

      const tracks = await platform.music.albums.tracks({
        albumId: found.id,
        paginationOpts: { numItems: 100, cursor: null },
      });

      return (
        await platform.music.playlists.create({
          name,
          trackIds: tracks.page.map((track) => track.id),
        })
      ).playlistId;
    } finally {
      await platform.dispose();
    }
  })();

  await signIn(page, aiko);
  await page.goto(`/music/playlists/${playlistId}`);
  await page.getByRole("button", { name: "Share", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: `Share ${name}` });

  await expect(dialog.getByText("Nobody added yet.")).toBeVisible();
  await dialog.getByRole("button", { name: "Add someone" }).click();
  await expect(page.getByRole("menuitem", { name: new RegExp(aiko.username, "u") })).toHaveCount(0);
  await page.getByRole("menuitem", { name: `${mateo.username} · Member` }).click();

  const people = dialog.getByRole("list", { name: "People it is shared with" });

  await expect(people.getByText(mateo.username)).toBeVisible();

  const other = await browser.newContext(baseURL === undefined ? {} : { baseURL });

  try {
    const listener = await other.newPage();

    await watchMedia(listener);
    await signIn(listener, mateo);
    await listener.goto(`/music/playlists/${playlistId}`);
    await expect(listener.getByRole("heading", { name })).toBeVisible();
    await listener
      .getByRole("main")
      .getByRole("row", { name: new RegExp(FIRST_SONG, "u") })
      .dblclick();
    await expect(
      listener.getByRole("region", { name: "Player" }).getByText(FIRST_SONG),
    ).toBeVisible();
    await expect.poll(() => audioSeconds(listener), { timeout: 30_000 }).toBeGreaterThan(1);
  } finally {
    await other.close();
  }
});

test("a signed-out browser that opens /music goes to / to sign in", async ({ page }) => {
  await page.goto("/music/");
  await expect(page).toHaveURL(/\/$/u);
  await expect(page.getByLabel("Username")).toBeVisible();
});
