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

test.use({ trace: "off", screenshot: "off", video: "off" });

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

  // A desktop row plays on a double click; its play button shows on hover.
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

test.describe("guest links", () => {
  test("a maker shares an album from its menu, copies once, and revokes; a member without leave has no entry", async ({
    page,
    browser,
  }) => {
    if (stack === null) return;
    const maker = await createPerson(stack, "guest-maker", "admin");
    const member = await createPerson(stack, "guest-member", "member");
    const platform = await signInClient(stack, maker);
    const guestAddress = "http://guests.example.test";
    const originalPolicy = await platform.core.guests.status();
    const memberContext = await browser.newContext();

    try {
      await platform.core.guests.configure({ enabled: true, address: guestAddress });

      const albums = await platform.music.albums.list({
        paginationOpts: { numItems: 100, cursor: null },
      });

      const shared = albums.page.find((row) => row.title === album);

      if (shared === undefined) throw new Error("the fixture album is missing");
      const path = `/music/albums/${shared.id}`;
      const memberPage = await memberContext.newPage();
      let policyLoaded = false;
      memberPage.on("websocket", (socket) => {
        socket.on("framereceived", ({ payload }) => {
          if (/"mayShare"\s*:\s*false/u.test(payload.toString())) policyLoaded = true;
        });
      });
      await signIn(memberPage, member);
      await memberPage.goto(path);
      await memberPage.getByRole("button", { name: `More actions for ${album}` }).click();
      await expect.poll(() => policyLoaded).toBe(true);
      await memberPage.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await expect(
        memberPage.getByRole("menuitem", { name: "Guest link", exact: true }),
      ).toHaveCount(0);
      await signIn(page, maker);
      await page.goto(path);
      await page.addStyleTag({
        content: '[data-sensitive="guest-link"] { visibility: hidden !important; }',
      });
      await page.getByRole("button", { name: `More actions for ${album}` }).click();
      await page.getByRole("menuitem", { name: "Guest link", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `Share ${album}` });
      await dialog.getByRole("button", { name: "Create link", exact: true }).click();

      const addressMatches = await dialog
        .getByLabel("New guest link")
        .evaluate(
          (element, expected) =>
            element instanceof HTMLInputElement && new URL(element.value).origin === expected,
          guestAddress,
        );

      expect(addressMatches).toBe(true);
      await expect(dialog.getByRole("region", { name: "Your guest links" })).toContainText("open");
      await dialog.getByRole("button", { name: "Copy", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: `More actions for ${album}` }).click();
      await page.getByRole("menuitem", { name: "Guest link", exact: true }).click();
      await expect(dialog.getByLabel("New guest link")).toHaveCount(0);
      await dialog.getByRole("button", { name: "Revoke", exact: true }).click();
      await expect(dialog.getByRole("region", { name: "Your guest links" })).toContainText(
        "revoked",
      );

      const listed = await platform.core.guests.links.list({
        whose: "mine",
        paginationOpts: { numItems: 100, cursor: null },
      });

      expect(
        listed.page.some(
          (row) =>
            row.target?.kind === "item" &&
            row.target.item.ref.id === shared.id &&
            row.state === "revoked",
        ),
      ).toBe(true);
    } finally {
      await platform.core.guests.configure({
        enabled: originalPolicy.enabled,
        address: originalPolicy.address,
      });
      await memberContext.close();
      await platform.dispose();
    }
  });
});
