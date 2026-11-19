import { expect, test } from "@playwright/test";

import { startMediaService, writeMusicLibrary } from "./media-service";
import type { MediaService } from "./media-service";
import {
  NO_STACK,
  addHouseholdLibrary,
  createPerson,
  reachableStack,
  signIn,
  signInClient,
} from "./people";

// The dialog copies the one-time address; CI's headless Chromium refuses the clipboard without these.
test.use({
  trace: "off",
  screenshot: "off",
  video: "off",
  permissions: ["clipboard-read", "clipboard-write"],
});

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
  test("a song's one-time address survives its playlist row disappearing and hides after remote revoke", async ({
    page,
  }) => {
    if (stack === null) return;
    const maker = await createPerson(stack, "song-maker", "admin");
    const platform = await signInClient(stack, maker);
    const originalPolicy = await platform.core.guests.status();

    try {
      await platform.core.guests.configure({
        enabled: true,
        address: "http://guests.example.test",
      });

      const albums = await platform.music.albums.list({
        paginationOpts: { numItems: 100, cursor: null },
      });

      const shared = albums.page.find((row) => row.title === album);

      if (shared === undefined) throw new Error("fixture album missing");

      const tracks = await platform.music.albums.tracks({
        albumId: shared.id,
        paginationOpts: { numItems: 100, cursor: null },
      });

      const track = tracks.page[0];

      if (track === undefined) throw new Error("fixture song missing");

      const { playlistId } = await platform.music.playlists.create({
        name: "Temporary songs",
        trackIds: [track.id],
      });

      await signIn(page, maker);
      await page.goto(`/music/playlists/${playlistId}`);
      await page.addStyleTag({
        content: '[data-sensitive="guest-link"] { visibility: hidden !important; }',
      });
      await page
        .getByRole("button", { name: `More actions for ${track.title}`, exact: true })
        .click();
      await page.getByRole("menuitem", { name: "Guest link", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `Share ${track.title}` });
      await dialog.getByRole("button", { name: "Create link", exact: true }).click();
      await expect(dialog.getByLabel("New guest link")).toHaveCount(1);

      const items = await platform.music.playlists.items({
        playlistId,
        paginationOpts: { numItems: 100, cursor: null },
      });

      const item = items.page[0];

      if (item === undefined) throw new Error("playlist entry missing");
      await platform.music.playlists.removeItem({ playlistId, itemId: item.itemId });
      await expect(
        page.getByRole("button", { name: `More actions for ${track.title}`, exact: true }),
      ).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel("New guest link")).toHaveCount(1);
      await dialog.getByRole("button", { name: "Copy", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toBeVisible();

      const listed = await platform.core.guests.links.list({
        whose: "mine",
        target: { kind: "item", item: { domain: "music", ref: { type: "track", id: track.id } } },
        paginationOpts: { numItems: 25, cursor: null },
      });

      const link = listed.page[0];

      if (link === undefined) throw new Error("created link missing");
      await platform.core.guests.links.revoke({ linkId: link.linkId });
      await expect(dialog.getByLabel("New guest link")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toHaveCount(0);
      await expect(dialog.getByRole("region", { name: "Your guest links" })).toContainText(
        "revoked",
      );
      await platform.core.guests.configure({ enabled: false, address: originalPolicy.address });
      await expect(dialog).toHaveCount(0);
      await platform.core.guests.configure({
        enabled: true,
        address: "http://guests.example.test",
      });
      await expect(dialog).toHaveCount(0);
    } finally {
      await platform.core.guests.configure({
        enabled: originalPolicy.enabled,
        address: originalPolicy.address,
      });
      await platform.dispose();
    }
  });
});
