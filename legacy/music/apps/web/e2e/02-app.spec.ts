import { expect, test } from "@playwright/test";

import { ADMIN, seed, seedDevice, signIn, unique } from "./support";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  // Idempotent: ensures the admin, the /music library, and its songs.
  seed();
});

test("a wrong password shows the sign-in error", async ({ page }) => {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("That email and password don't match.");
  await expect(page.getByLabel("Password")).toHaveAttribute("aria-invalid", "true");
});

test("browse to an album and press play", async ({ page }) => {
  await signIn(page);
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Albums" })
    .click();
  await page.getByRole("link", { name: "Blue Lines" }).first().click();
  await expect(page.getByRole("heading", { name: "Blue Lines" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Play", exact: true }).first().click();

  const bar = page.getByRole("region", { name: "Player" });
  await expect(bar.getByRole("button", { name: "Safe From Harm", exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(page.locator("[role=row][aria-current=true]").first()).toContainText(
    "Safe From Harm",
  );

  await bar.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(bar.getByRole("button", { name: "Play", exact: true })).toBeVisible();
});

test("search shows results while typing and a no-results state", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("/");
  await expect(page).toHaveURL(/\/search/);

  await page.locator("#search-input").fill("portis");
  await expect(page.getByText("Top result")).toBeVisible();
  await expect(page.getByText("Portishead", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Glory Box").first()).toBeVisible();

  await page.locator("#search-input").fill("zzqxv nothing here");
  await expect(page.getByRole("heading", { name: "Not in your library" })).toBeVisible();
});

test("create a playlist and add a song to it", async ({ page }) => {
  const name = unique("Rainy Sunday");

  await signIn(page);
  await page.getByRole("button", { name: "New playlist" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name }).first()).toBeVisible();
  await expect(page.getByText("Let's find something for this playlist")).toBeVisible();

  await page.getByLabel("Search your library to add songs").fill("teardrop");
  await page.getByRole("button", { name: "Add" }).first().click();
  await expect(page.getByText(`Added to ${name}`)).toBeVisible();
  await expect(page.getByRole("table", { name: `Songs in ${name}` })).toContainText("Teardrop");

  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Albums" })
    .click();
  await page.getByRole("link", { name: "Dummy" }).first().click();
  await page.getByRole("row").filter({ hasText: "Glory Box" }).hover();
  await page.getByRole("button", { name: "More actions for Glory Box" }).last().click();
  await page.getByRole("menuitem", { name: "Add to playlist" }).hover();
  await page.getByRole("menuitem", { name }).click();
  // The toast from the first add can still be on screen with the same text, so take the newest.
  await expect(page.getByText(`Added to ${name}`).last()).toBeVisible();

  await page.getByRole("navigation", { name: "Library" }).getByRole("link", { name }).click();
  await expect(page.getByRole("table", { name: `Songs in ${name}` })).toContainText("Glory Box");
});

test("like a song and find it in Liked songs", async ({ page }) => {
  await signIn(page);
  await page.goto("/albums");
  await page.getByRole("link", { name: "Moon Safari" }).first().click();

  const row = page.getByRole("row").filter({ hasText: "Sexy Boy" });
  await row.hover();

  const heart = row.getByRole("button", { name: /like Sexy Boy/i });
  const liked = (await heart.getAttribute("aria-pressed")) === "true";

  if (liked) {
    await heart.click();
    await expect(heart).toHaveAttribute("aria-pressed", "false");
  }

  await heart.click();
  await expect(heart).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Liked Sexy Boy")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Liked songs" })
    .click();
  await expect(page.getByRole("table", { name: "Liked songs" })).toContainText("Sexy Boy");
});

test("create an API key that is shown once, then revoke it", async ({ page }) => {
  const name = unique("e2e agent");

  await signIn(page);
  await page.goto("/settings/keys");
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("heading", { name: "Copy your new key" })).toBeVisible();
  await expect(page.getByTestId("new-api-key")).not.toBeEmpty();
  await page.getByRole("button", { name: "Done" }).click();

  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("button", { name: "Revoke key" }).click();
  await expect(page.getByText(`Revoked ${name}`)).toBeVisible();
  await expect(row).toHaveCount(0);
});

test("the command menu runs a registry command with arguments", async ({ page }) => {
  await signIn(page);
  await page.goto("/albums");
  await page.getByRole("link", { name: "Blue Lines" }).first().click();
  await page.getByRole("button", { name: "Play", exact: true }).first().click();

  const shuffle = page
    .getByRole("region", { name: "Player" })
    .getByRole("button", { name: "Shuffle", exact: true });
  // Play starts the album in order, so shuffle is off.

  await expect(shuffle).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("ControlOrMeta+k");
  const menu = page.getByRole("dialog", { name: "Command menu" });
  await expect(menu).toBeVisible();
  await page.keyboard.type("shuffle on or off");
  await menu.getByRole("option", { name: /Turn shuffle on or off/ }).click();
  await expect(menu.getByRole("heading", { name: "Turn shuffle on or off" })).toBeVisible();
  await expect(menu.getByText("music playback shuffle").first()).toBeVisible();
  await menu.getByRole("button", { name: "Run" }).click();

  await expect(menu).toBeHidden();
  await expect(shuffle).toHaveAttribute("aria-pressed", "true");
});

test("an admin invites someone who joins with the link", async ({ page, browser }) => {
  await signIn(page);
  await page.goto("/settings/people");
  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByRole("button", { name: "Create invite" }).click();

  const link = await page.getByTestId("invite-link").textContent();
  expect(link).toContain("/invite/");

  const guest = await browser.newContext();
  const visitor = await guest.newPage();
  await visitor.goto(link ?? "");
  await expect(visitor.getByRole("heading", { name: /invited you/ })).toBeVisible();
  await visitor.getByLabel("Email").fill(`${unique("guest").replace(" ", "-")}@music.local`);
  await visitor.getByLabel("Your name").fill("Mateo");
  await visitor.getByLabel("Choose a password").fill("password123");
  await visitor.getByRole("button", { name: "Join" }).click();
  await expect(visitor.getByRole("navigation", { name: "Library" })).toBeVisible();

  await visitor.goto(link ?? "");
  await expect(visitor).toHaveURL(/\/$/);
  await guest.close();
});

test("remote control mode shows where music plays and controls it", async ({ page }) => {
  await signIn(page);
  await page.goto("/albums");
  await page.getByRole("link", { name: "Blue Lines" }).first().click();
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expect(
    page
      .getByRole("region", { name: "Player" })
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();

  // Another signed-in device takes over playback.
  seedDevice("Lucía's iPhone");

  await expect(
    page.getByRole("status").filter({ hasText: "Playing on Lucía's iPhone" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Play on another device" }).click();
  await expect(page.getByRole("menuitemradio", { name: /Lucía's iPhone/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");

  const bar = page.getByRole("region", { name: "Player" });
  await bar.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(bar.getByRole("button", { name: "Play", exact: true })).toBeVisible();
});
