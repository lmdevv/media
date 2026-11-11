import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { removeLibrariesUnder } from "../stack/libraries";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import {
  NO_STACK,
  createPerson,
  moviesPath,
  reachableStack,
  signIn,
  signInClient,
} from "../stack/people";
import type { Client, Person } from "../stack/people";
import { startJellyfinSource } from "./jellyfin-source";
import type { JellyfinSource } from "./jellyfin-source";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

const SETUP_TIMEOUT_MS = 300_000;

const IMPORT_TIMEOUT_MS = 180_000;

const run = Date.now().toString(36);

let workspace = "";

let source: JellyfinSource | undefined;

let media: MediaService | undefined;

let owner: Client | undefined;

/** The person here that Jellyfin's `admin` imports into. */
let viewer: Person | undefined;

test.beforeAll(async () => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "movies-web-migration-"));
  source = await startJellyfinSource(workspace);
  buildMediaService();
  media = await startMediaService(stack, [workspace]);
  owner = await signInClient(stack, await createPerson(stack, "admin"));
  viewer = await createPerson(stack, `jellyfin-${run}`, "member");
});

test.afterAll(async () => {
  if (owner !== undefined) {
    const { platform } = owner;

    await removeLibrariesUnder(platform, workspace);
    await platform.dispose();
  }

  await media?.stop();
  await source?.stop();

  if (workspace !== "") await rm(workspace, { recursive: true, force: true });
});

test("Couldn't connect shows why under the address or the key", async ({ page }) => {
  if (owner === undefined || source === undefined) throw new Error("Setup did not finish");

  await signIn(page, owner.person);
  await page.goto(moviesPath("/admin/libraries"));
  await page
    .getByRole("navigation", { name: "Settings" })
    .getByRole("link", { name: "Import" })
    .click();
  await expect(page.getByRole("heading", { name: "Import from Jellyfin or Plex" })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Jellyfin" })).toBeChecked();
  await expect(page.getByText("Emby")).toHaveCount(0);

  await page.getByLabel("Server URL").fill("http://127.0.0.1:1");
  await page.getByLabel("API key").fill("anything");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Nothing answered at this address.")).toBeVisible();
  await expect(page.getByLabel("Server URL")).toHaveAttribute("aria-invalid", "true");

  await page.getByLabel("Server URL").fill(source.url);
  await page.getByLabel("API key").fill("not-the-key");
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByText("Jellyfin didn’t accept this API key.")).toBeVisible();
  await expect(page.getByLabel("API key")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByText("Nothing answered at this address.")).toHaveCount(0);

  await page.getByRole("radio", { name: "Plex" }).click();
  await expect(page.getByLabel("Plex token")).toBeVisible();
});

test("an admin connects, reviews, imports, and lands on Done", async ({ page }) => {
  if (owner === undefined || source === undefined) throw new Error("Setup did not finish");

  test.setTimeout(IMPORT_TIMEOUT_MS + 60_000);

  const mod = process.platform === "darwin" ? "Meta" : "Control";

  if (stack === null || viewer === undefined) throw new Error("Setup did not finish");

  await signIn(page, owner.person);
  await page.goto(moviesPath("/admin/libraries"));
  await expect(page.getByRole("heading", { level: 1, name: "Libraries" })).toBeVisible();
  await page.keyboard.press(`${mod}+k`);
  await page.getByRole("combobox").fill("jellyfin");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/movies\/admin\/migration$/u);

  await page.getByLabel("Server URL").fill(source.url);
  await page.getByLabel("API key").fill(source.apiKey);
  await page.getByRole("button", { name: "Connect" }).click();
  await expect(page.getByRole("heading", { name: "Ready to import" })).toBeVisible();

  const admin = page.getByLabel("admin", { exact: true });
  const bob = page.getByLabel("bob", { exact: true });
  await expect(admin).toHaveValue("skip");
  await expect(bob).toHaveValue("skip");
  await expect(page.getByText("admin, bob won’t be imported")).toBeVisible();

  await admin.selectOption({ label: viewer.username });
  await expect(page.getByText("user · admin", { exact: true })).toBeVisible();
  await expect(page.getByText("bob won’t be imported")).toBeVisible();

  const libraries = page.getByRole("region", { name: "Libraries · used in place" });
  await expect(libraries).toContainText(join(workspace, "movies"));
  await expect(libraries).toContainText(join(workspace, "shows"));
  await expect(libraries).toContainText("Movies · new");

  await page.getByRole("button", { name: "Import" }).click();
  await expect(page).toHaveURL(/\/movies\/admin\/migration\?run=/u);
  await expect(page.getByRole("heading", { name: "Importing from Jellyfin" })).toBeVisible();
  await expect(page.getByRole("progressbar", { name: "Import from Jellyfin" })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Imported from Jellyfin" })).toBeVisible({
    timeout: IMPORT_TIMEOUT_MS,
  });
  await expect(page.getByText("libraries added")).toBeVisible();

  const imported = await signInClient(stack, viewer);

  try {
    const myList = await imported.platform.movies.myList.list({
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(myList.page.map((title) => title.name)).toEqual(["Fixture Show"]);

    const resume = await imported.platform.movies.history.continueWatching();

    expect(resume.map((row) => row.title.name)).toContain("Remux Fixture");
  } finally {
    await imported.platform.dispose();
  }

  await page.reload();
  await expect(page.getByRole("heading", { name: "Imported from Jellyfin" })).toBeVisible();
  await page.getByRole("link", { name: "Go to Home" }).click();
  await expect(page).toHaveURL(/\/movies\/$/u);
});
