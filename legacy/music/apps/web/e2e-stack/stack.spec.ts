import { Device, PlaybackState } from "@music/commands/models";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Schema } from "effect";

import { ADMIN, cli, cspViolations, expectAudioPast, isPlayingAudio, signIn } from "./support";

test.describe.configure({ mode: "serial" });

let apiKey = "";

const decodeDevices = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Device)));

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(PlaybackState));

const openFirstAlbum = async (page: Page): Promise<string> => {
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Albums" })
    .click();
  const card = page.locator("main a[href^='/albums/']").first();
  await expect(card).toBeVisible();
  const name = (await card.getAttribute("aria-label")) ?? (await card.textContent()) ?? "";
  await card.click();
  await expect(page).toHaveURL(/\/albums\/[^/]+$/);
  // The URL changes before the album page renders, so wait for its heading to replace the list's.
  const heading = page.getByRole("heading", { level: 1 }).first();
  await expect(heading).not.toHaveText("Albums");
  const title = (await heading.textContent()) ?? name;
  expect(title.length).toBeGreaterThan(0);

  return title;
};

test("first run: create the admin, add /music, and the real scanner indexes it", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup/);
  await page.getByLabel("Name").fill(ADMIN.name);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Create admin account" }).click();
  await expect(page.getByRole("heading", { name: "Where's your music?" })).toBeVisible();
  await page.getByLabel("Library folder").fill("/music");
  await page.getByRole("button", { name: "Start scanning" }).click();
  await expect(page.getByRole("heading", { name: "Your library is ready" })).toBeVisible({
    timeout: 120_000,
  });
  await page.getByRole("button", { name: "Open my library" }).click();
  await expect(page.getByRole("heading", { name: "Recently added" })).toBeVisible();
  await expect(page.locator("main img").first()).toBeVisible();
});

test("an album plays real audio, pauses, and skips", async ({ page }) => {
  await signIn(page);
  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();

  const bar = page.getByRole("region", { name: "Player" });
  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expectAudioPast(page, 2);

  await bar.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(bar.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect.poll(() => isPlayingAudio(page)).toBe(false);

  await bar.getByRole("button", { name: "Play", exact: true }).click();
  await expectAudioPast(page, 1);
  const before = await page.locator("[role=row][aria-current=true]").first().textContent();
  await bar.getByRole("button", { name: "Next", exact: true }).click();
  await expect
    .poll(() => page.locator("[role=row][aria-current=true]").first().textContent())
    .not.toBe(before);
  await expectAudioPast(page, 1);
});

test("search finds songs from the scanned library", async ({ page }) => {
  await signIn(page);
  const album = await openFirstAlbum(page);
  await page.keyboard.press("/");
  await expect(page).toHaveURL(/\/search/);
  const word = album.split(" ")[0] ?? album;
  await page.locator("#search-input").fill(word);
  await expect(page.getByText("Top result")).toBeVisible();
});

test("an API key drives the CLI, and the CLI controls the browser's playback", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/keys");
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByLabel("Name").fill("stack e2e");
  await page.getByRole("button", { name: "Create key" }).click();
  apiKey = (await page.getByTestId("new-api-key").textContent())?.trim() ?? "";
  expect(apiKey).toMatch(/^mk_/);
  await page.getByRole("button", { name: "Done" }).click();

  expect(cli(apiKey, ["whoami"])).toContain(ADMIN.email);

  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expectAudioPast(page, 1);

  cli(apiKey, ["pause"]);
  const bar = page.getByRole("region", { name: "Player" });
  await expect(bar.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect.poll(() => isPlayingAudio(page)).toBe(false);

  cli(apiKey, ["resume"]);
  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expectAudioPast(page, 1);
});

test("playback moves to a second browser and the first one stops", async ({ page, browser }) => {
  await signIn(page);
  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expectAudioPast(page, 2);

  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await other.newPage();
  await signIn(phone);
  await expect(phone.getByRole("button", { name: /Open Now Playing/ })).toBeVisible();

  const devices = decodeDevices(cli(apiKey, ["devices", "list", "--json"]));
  const state = decodeState(cli(apiKey, ["now", "--json"]));

  const target = devices.find((device) => device.online && device.id !== state.activeDevice?.id);
  expect(target).toBeDefined();
  cli(apiKey, ["playback", "transfer", target?.id ?? ""]);

  await expect.poll(() => isPlayingAudio(page)).toBe(false);
  await expectAudioPast(phone, 1);
  await expect(page.getByText(/Playing on /).first()).toBeVisible();
  await other.close();
});

test("the app runs under its Content-Security-Policy and security headers", async ({ page }) => {
  const response = await page.request.get("/");
  const headers = response.headers();

  expect(headers["content-security-policy"]).toContain("script-src 'self';");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");

  await signIn(page);
  await expect(page.locator("main img").first()).toBeVisible();
  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expectAudioPast(page, 1);
  await page.keyboard.press("/");
  await page.locator("#search-input").fill("a");
  await expect(page.getByText("Top result")).toBeVisible();

  expect(await cspViolations(page)).toEqual([]);
});

test("a numeric search and the Add folder dialog keep their screens", async ({ page }) => {
  await signIn(page);
  await page.goto("/search");
  await page.locator("#search-input").fill("1999");
  await expect(page).toHaveURL(/q=1999/);
  await expect(page.getByRole("heading", { name: "Not in your library" })).toBeVisible();

  await page.goto("/settings/libraries");
  await page.getByRole("button", { name: "Add folder" }).click();
  await expect(page).toHaveURL(/add=1/);
  await expect(page.getByRole("textbox", { name: "Library folder" })).toBeFocused();
});

test("playlists: create with N, add from a song's menu, remove, rename, and delete", async ({
  page,
}) => {
  const errors: Array<string> = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await signIn(page);
  await openFirstAlbum(page);

  // The name field has focus when the dialog opens, so typing and Enter create the playlist.
  await page.keyboard.press("n");
  await expect(page.getByRole("dialog", { name: "New playlist" })).toBeVisible();
  await page.keyboard.type("Road trip");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/playlists\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Road trip" })).toBeVisible();

  await page.goBack();
  const row = page.locator("main [role=row]").nth(1);
  const title = (await row.locator("[role=cell]").nth(1).textContent())?.trim() ?? "";
  await row.hover();
  await row.getByRole("button", { name: `More actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Add to playlist" }).click();
  await page.getByRole("menuitem", { name: "Road trip" }).click();
  await expect(page.getByText("Added to Road trip")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: /Road trip/ })
    .click();
  const added = page.locator("main [role=row]").filter({ hasText: title });
  await expect(added).toBeVisible();
  await added.hover();
  await added.getByRole("button", { name: `More actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Remove from this playlist" }).click();
  await expect(page.getByText("Let's find something for this playlist")).toBeVisible();

  await page.getByRole("button", { name: "More actions for Road trip" }).click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Night drive");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Night drive" })).toBeVisible();

  await page.getByRole("button", { name: "More actions for Night drive" }).click();
  await page.getByRole("menuitem", { name: "Delete playlist…" }).click();
  await page.getByRole("button", { name: "Delete playlist" }).click();
  await expect(page).toHaveURL(/\/playlists$/);
  await expect(page.getByText("Deleted Night drive")).toBeVisible();
  await expect(page.getByRole("link", { name: /Night drive/ })).toHaveCount(0);
  expect(errors.filter((text) => text.includes("Playlist not found"))).toEqual([]);
});

test("home and artists show each artist's art", async ({ page }) => {
  await signIn(page);

  const recent = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Recently played artists" }),
  });

  const circles = recent.locator("a[href^='/artists/']");

  await expect(circles.first()).toBeVisible();
  await expect(recent.locator("a[href^='/artists/'] img")).toHaveCount(await circles.count());

  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Artists" })
    .click();

  const artists = page.locator("main a[href^='/artists/']");

  await expect(artists.first()).toBeVisible();
  await expect(page.locator("main a[href^='/artists/'] img")).toHaveCount(await artists.count());
});

test("a phone shows where the music plays while another device plays it", async ({
  page,
  browser,
}) => {
  await signIn(page);
  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expectAudioPast(page, 1);

  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await other.newPage();

  await signIn(phone);

  const mini = phone.getByRole("button", { name: /Open Now Playing: .+, playing on / });

  await expect(mini).toBeVisible();
  await expect(mini.getByText(/^Playing on /)).toBeVisible();
  expect(await isPlayingAudio(phone)).toBe(false);

  await mini.click();
  await expect(phone.getByRole("status").filter({ hasText: /^Playing on / })).toBeVisible();
  await other.close();
});

test("the seek and volume sliders are named and work from the keyboard", async ({ page }) => {
  await signIn(page);
  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expectAudioPast(page, 1);

  const bar = page.getByRole("region", { name: "Player" });
  const seek = bar.getByRole("slider", { name: "Seek" });
  const volume = bar.getByRole("slider", { name: "Volume" });

  await expect(seek).toBeVisible();
  await volume.focus();

  const before = Number(await volume.getAttribute("aria-valuenow"));

  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(async () => Number(await volume.getAttribute("aria-valuenow")))
    .toBeLessThan(before);
});

test("the song menu's Q, Shift+Enter, and L keys do what the menu shows", async ({ page }) => {
  await signIn(page);
  await openFirstAlbum(page);

  // The first song row (any library has one); its menu button names the song.
  const row = page
    .locator("main [role=row]")
    .filter({ has: page.getByRole("button", { name: /^More actions for / }) })
    .first();

  const menu = row.getByRole("button", { name: /^More actions for / });
  await row.hover();
  const label = (await menu.getAttribute("aria-label")) ?? "";
  const title = label.replace(/^More actions for /, "");
  expect(title.length).toBeGreaterThan(0);

  // Keys reach the menu once it has focus, as after any click.
  const openMenu = async (): Promise<void> => {
    await row.hover();
    await menu.click();
    await expect(page.getByRole("menu")).toBeFocused();
  };

  await openMenu();
  await page.keyboard.press("q");
  await expect(page.getByText(`Added ${title} to the queue`)).toBeVisible();
  await expect(page.getByRole("menu")).toBeHidden();

  await openMenu();
  await page.keyboard.press("Shift+Enter");
  await expect(page.getByText(`${title} plays next`)).toBeVisible();

  await openMenu();
  await page.keyboard.press("l");
  await expect(page.getByText(`Liked ${title}`)).toBeVisible();
  await page.goto("/liked");
  await expect(page.locator("main [role=row]").filter({ hasText: title })).toBeVisible();
});

test("phone queue keeps the transport on screen and the device list fits", async ({ browser }) => {
  for (let index = 0; index < 12; index += 1) {
    cli(apiKey, [
      "devices",
      "heartbeat",
      "--device-id",
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      "--name",
      `Old laptop ${index}`,
      "--kind",
      "web",
    ]);
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await context.newPage();

  await signIn(phone);
  await phone.goto("/albums");
  await phone.locator("main a[href^='/albums/']").first().click();
  await phone.getByRole("button", { name: "Play", exact: true }).first().click();
  await expectAudioPast(phone, 1);
  await phone.getByRole("button", { name: /Open Now Playing/ }).click();
  await phone.getByRole("button", { name: "Queue", exact: true }).click();

  const fits = async (name: RegExp | string): Promise<boolean> => {
    const box = await phone.getByRole("button", { name, exact: true }).last().boundingBox();

    return box !== null && box.y >= 0 && box.y + box.height <= 844;
  };

  await expect.poll(() => fits("Next")).toBe(true);
  await expect.poll(() => fits("Hide queue")).toBe(true);

  await phone.getByRole("button", { name: /Play on another device/ }).click();

  const list = phone.getByRole("menu", { name: "Play on" });

  await expect(list.getByRole("menuitemradio", { name: /Old laptop 11/ })).toBeAttached();

  // The sheet slides in; poll until it settles.
  await expect
    .poll(async () => {
      const box = await list.boundingBox();

      return box !== null && box.y + box.height <= 844;
    })
    .toBe(true);
  await context.close();
});

test("Esc closes the desktop queue panel", async ({ page }) => {
  await signIn(page);
  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await page.getByRole("region", { name: "Player" }).getByRole("button", { name: "Queue" }).click();
  await expect(page.getByRole("complementary", { name: "Queue" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Queue" })).toBeHidden();
});
