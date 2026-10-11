import { expect, test } from "@playwright/test";

import { ADMIN, hasUsers, seed } from "./support";

test("first run: create the admin, add a library folder, and scan it", async ({ page }) => {
  test.skip(
    await hasUsers(),
    "The backend already has accounts. Start from an empty backend to run first-run setup.",
  );

  await page.goto("/");
  await expect(page).toHaveURL(/\/setup/);
  await expect(page.getByRole("heading", { name: "Your music, your server." })).toBeVisible();

  await page.getByLabel("Name").fill(ADMIN.name);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill("short");
  await page.getByRole("button", { name: "Create admin account" }).click();
  await expect(page.getByText("Use at least 8 characters.")).toBeVisible();

  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Create admin account" }).click();
  await expect(page.getByRole("heading", { name: "Where's your music?" })).toBeVisible();

  await page.getByLabel("Library folder").fill("music");
  await page.getByRole("button", { name: "Start scanning" }).click();
  await expect(page.getByText("Use an absolute path that the server can read")).toBeVisible();

  await page.getByLabel("Library folder").fill("/music");
  await page.getByRole("button", { name: "Start scanning" }).click();
  await expect(page.getByRole("heading", { name: "Reading your library" })).toBeVisible();
  await expect(page.getByText("WAITING FOR THE SCANNER")).toBeVisible();

  // The media service claims the scan; the seed script stands in for it.
  seed(true);

  await expect(page.getByRole("heading", { name: "Your library is ready" })).toBeVisible();
  await expect(page.getByText("100%")).toBeVisible();

  await page.getByRole("button", { name: "Open my library" }).click();
  await expect(
    page.getByRole("heading", { name: /Good (morning|afternoon|evening), Lucía/ }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recently added" })).toBeVisible();
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Albums" })
    .click();
  await expect(page.getByRole("link", { name: "Blue Lines" }).first()).toBeVisible();
});
