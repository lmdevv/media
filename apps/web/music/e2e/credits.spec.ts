import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { startMediaService, writeSongs } from "./media-service";
import type { MediaService } from "./media-service";
import {
  NO_STACK,
  addManagedLibrary,
  createPerson,
  reachableStack,
  signIn,
  signInClient,
} from "./people";
import type { ManagedLibrary } from "./people";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

/** This run's names, so artists and albums from earlier runs on the same stack never match. */
const run = Math.random().toString(36).slice(2, 7);

const ANA = `Ana Vega ${run}`;

const BRUNO = `Bruno Sol ${run}`;

/** A featured artist only a title names. */
const CORA = `Cora Lux ${run}`;

/** The credit two artists share: Ana has a song of her own, so it splits into both of them. */
const DUET = `${ANA} & ${BRUNO}`;

const SOLO_ALBUM = `On My Own ${run}`;

const DUETS_ALBUM = `Duets ${run}`;

const SHARED_SONG = "Shared Song";

const FEATURED_SONG = `Night Ride (feat. ${CORA})`;

let media: MediaService | undefined;

let library: ManagedLibrary | undefined;

let duetsAlbumId = "";

test.beforeAll(async () => {
  if (stack === null) return;

  const root = mkdtempSync(join(tmpdir(), "music-e2e-credits-"));
  const tone = { seconds: 4, frequency: 330 };

  await writeSongs(root, [
    { ...tone, title: "Solo Song", artist: ANA, albumArtist: ANA, album: SOLO_ALBUM, track: 1 },
    {
      ...tone,
      title: SHARED_SONG,
      artist: DUET,
      albumArtist: ANA,
      album: DUETS_ALBUM,
      track: 1,
    },
    {
      ...tone,
      title: FEATURED_SONG,
      artist: ANA,
      albumArtist: ANA,
      album: DUETS_ALBUM,
      track: 2,
    },
  ]);

  media = await startMediaService(stack, root);
  library = await addManagedLibrary(stack, root);

  const platform = await signInClient(stack, library.manager);

  try {
    const found = await platform.music.library.search({ query: DUETS_ALBUM, limit: 5 });
    const album = found.albums.find((each) => each.title === DUETS_ALBUM);

    if (album === undefined) throw new Error(`no album ${DUETS_ALBUM}`);

    duetsAlbumId = album.id;
  } finally {
    await platform.dispose();
  }
});

test.afterAll(async () => {
  await media?.stop();
});

/** The shared song's row on its album's page. */
const sharedRow = (page: Page): Locator =>
  page.getByRole("main").getByRole("row", { name: new RegExp(SHARED_SONG, "u") });

test("each artist a song credits links to their own page, which lists the song once", async ({
  page,
}) => {
  if (stack === null) return;

  await signIn(page, await createPerson(stack, "listener", "member"));
  await page.goto(`/music/albums/${duetsAlbumId}`);

  // The album is Ana's; its song names both artists under its title, each a link.
  await expect(page.getByRole("heading", { name: DUETS_ALBUM })).toBeVisible();

  const row = sharedRow(page);

  await expect(row.getByRole("link", { name: ANA, exact: true })).toBeVisible();
  await expect(row.getByRole("link", { name: BRUNO, exact: true })).toBeVisible();
  await expect(row).toContainText(DUET);

  // A song whose artist is the album's names its featured artist too.
  const featured = page.getByRole("main").getByRole("row", { name: /Night Ride/u });

  await expect(featured.getByRole("link", { name: CORA, exact: true })).toBeVisible();
  await expect(featured).toContainText(`${ANA} & ${CORA}`);

  await row.getByRole("link", { name: BRUNO, exact: true }).click();
  await expect(page.getByRole("heading", { name: BRUNO, level: 1 })).toBeVisible();

  // Bruno has no album of his own; the song he shares lists once among his songs.
  const songs = page.getByRole("region", { name: "Songs" });

  await expect(songs.getByText(SHARED_SONG, { exact: true })).toHaveCount(1);
  await expect(songs.getByRole("link", { name: ANA, exact: true })).toBeVisible();

  await page.goBack();
  await sharedRow(page).getByRole("link", { name: ANA, exact: true }).click();
  await expect(page.getByRole("heading", { name: ANA, level: 1 })).toBeVisible();

  const anaSongs = page.getByRole("region", { name: "Songs" });

  await expect(anaSongs.getByText(SHARED_SONG, { exact: true })).toHaveCount(1);
  await expect(anaSongs.getByText("Solo Song", { exact: true })).toHaveCount(1);
});

test("a manager keeps a credit together, its song credits one artist, and removing that splits it", async ({
  page,
}) => {
  if (stack === null || library === undefined) return;

  await signIn(page, library.manager);
  await page.goto(`/admin/libraries/${library.libraryId}`);
  await page.getByRole("link", { name: "Correct artist credits" }).click();
  await expect(page.getByRole("heading", { name: "Artist credits", level: 1 })).toBeVisible();

  const credit = page
    .getByRole("list", { name: "Credits" })
    .getByRole("listitem", { name: DUET, exact: true });

  const correction = page
    .getByRole("list", { name: "Corrections" })
    .getByRole("listitem", { name: DUET, exact: true });

  await expect(credit).toContainText(`Credits ${ANA} and ${BRUNO}`);
  await expect(page.getByText("0 of 256 corrections")).toBeVisible();

  await credit.getByRole("button", { name: "Correct" }).click();

  const dialog = page.getByRole("dialog", { name: `Correct ${DUET}` });

  await dialog.getByRole("radio", { name: "Keep together" }).click();
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Correction saved")).toBeVisible();
  await expect(correction).toContainText("Kept together");
  await expect(page.getByText("1 of 256 corrections")).toBeVisible();
  // The core credits the song anew a moment later.
  await expect(credit).toContainText("One artist", { timeout: 30_000 });

  await page.goto(`/music/albums/${duetsAlbumId}`);
  await expect(sharedRow(page).getByRole("link", { name: DUET, exact: true })).toBeVisible();
  await expect(sharedRow(page).getByRole("link", { name: BRUNO, exact: true })).toHaveCount(0);

  await page.goto(`/admin/libraries/${library.libraryId}/credits`);
  await correction.getByRole("button", { name: "Remove correction" }).click();
  await expect(page.getByText("Correction removed")).toBeVisible();
  await expect(correction).toHaveCount(0);
  await expect(credit).toContainText(`Credits ${ANA} and ${BRUNO}`, { timeout: 30_000 });

  await page.goto(`/music/albums/${duetsAlbumId}`);
  await expect(sharedRow(page).getByRole("link", { name: ANA, exact: true })).toBeVisible();
  await expect(sharedRow(page).getByRole("link", { name: BRUNO, exact: true })).toBeVisible();
});

test("an admin who doesn't manage the library sees no artist credits to correct", async ({
  page,
}) => {
  if (stack === null || library === undefined) return;

  // The household may play the library; only the admin who made it manages it.
  await signIn(page, await createPerson(stack, "other-admin", "admin"));
  await page.goto(`/admin/libraries/${library.libraryId}`);
  await expect(
    page.getByRole("heading", { name: `Music ${library.manager.username}` }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Artist credits" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Correct artist credits" })).toHaveCount(0);

  await page.goto(`/admin/libraries/${library.libraryId}/credits`);
  await expect(
    page.getByText("Only a manager of this library can correct its artist credits."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Correct" })).toHaveCount(0);
});
