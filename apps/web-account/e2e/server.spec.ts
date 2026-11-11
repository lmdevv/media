import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { mediaEnv, startMediaServer } from "./media-server";
import type { MediaServer } from "./media-server";
import { createPerson, openPlatform, signIn } from "./people";
import type { Person } from "./people";
import { stackEnv } from "./stack";

const stack = stackEnv();

const env = mediaEnv();

test.skip(stack === null || env === null, "needs scripts/dev-stack.sh up");

test.describe.configure({ mode: "serial" });

const SETUP_TIMEOUT_MS = 180_000;

const BACKUP_TIMEOUT_MS = 120_000;

let media: MediaServer | undefined;

let admin: Person | undefined;

test.beforeAll(async () => {
  if (stack === null || env === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  media = await startMediaServer(env);
  admin = await createPerson(stack, "mateo", "admin");
});

test.afterAll(async () => {
  await media?.stop();
});

const signedIn = (): Person => {
  if (admin === undefined) throw new Error("The admin was not made");

  return admin;
};

/** Signs `person` in at `/` and waits for their home. */
const signInHome = async (page: Page, person: Person): Promise<void> => {
  await signIn(page, person);
  await expect(page.getByRole("heading", { name: `Hi, ${person.username}.` })).toBeVisible();
};

test("Server shows the media server running, its encoder, and its address", async ({ page }) => {
  if (media === undefined) throw new Error("The media server did not start");

  await signInHome(page, signedIn());
  await page.goto("/admin/server");
  await expect(page.getByRole("heading", { level: 1, name: "Server" })).toBeVisible();
  await expect(page.getByText(/· media service running$/u)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Software encoding with ffmpeg")).toBeVisible();
  await expect(page.getByText(media.url, { exact: false }).first()).toBeVisible();
});

test("an admin backs up now, sees it listed, and asks before restoring", async ({ page }) => {
  if (stack === null) return;

  test.setTimeout(BACKUP_TIMEOUT_MS + 60_000);

  const person = signedIn();
  const platform = openPlatform(stack);

  try {
    await platform.session.signInWithPassword(person);

    const listed = async () =>
      (
        await platform.core.server.backups.list({
          paginationOpts: { numItems: 100, cursor: null },
        })
      ).page;

    const before = new Set((await listed()).map((backup) => backup.id));

    await signInHome(page, person);
    await page.goto("/admin/backups");
    await expect(page.getByRole("heading", { level: 1, name: "Backups" })).toBeVisible();
    await page.getByRole("button", { name: "Back up now" }).click();

    await expect(
      page.getByRole("button", { name: /^(Backup queued|Backing up…)$/u }),
    ).toBeDisabled();

    const recorded = async () =>
      (await listed()).find((backup) => !before.has(backup.id) && backup.trigger === "manual") ??
      null;

    await expect.poll(recorded, { timeout: BACKUP_TIMEOUT_MS }).not.toBeNull();

    const archive = await recorded();

    if (archive === null) throw new Error("The backup recorded no archive");

    expect(archive.fileName).toMatch(/^media-manual-.*\.zip$/u);

    const row = page
      .getByRole("list", { name: "Backups" })
      .getByRole("listitem")
      .filter({ hasText: archive.fileName });

    await expect(row).toContainText("Manual");
    await expect(row).toContainText("today");
    await expect(page.getByRole("button", { name: "Back up now" })).toBeEnabled();

    await row.getByRole("button", { name: /^Restore / }).click();

    const confirm = row.getByRole("note");

    await expect(confirm).toContainText(
      "is replaced, and everyone signs in again while the server restarts.",
    );
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(row.getByRole("button", { name: /^Restore / })).toBeVisible();
  } finally {
    await platform.dispose();
  }
});
