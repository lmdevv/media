import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JobId } from "@media/contracts/ids";
import { expect, test } from "@playwright/test";

import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import { NO_STACK, ownedStack, signInOwner, useSession } from "./session";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

const SETUP_TIMEOUT_MS = 180_000;

const BACKUP_TIMEOUT_MS = 120_000;

let workspace = "";

let media: MediaService | undefined;

test.beforeAll(async () => {
  if (stack === null) return;
  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "movies-web-backups-"));
  buildMediaService();
  media = await startMediaService(stack, [workspace]);

  const owner = await signInOwner(stack);

  const active = async () =>
    (await owner.sdk.query("jobs.list", { kind: "backup", limit: 100 })).filter(
      (job) => job.status === "pending" || job.status === "running",
    ).length;

  await expect.poll(active, { timeout: BACKUP_TIMEOUT_MS }).toBe(0);
});

test.afterAll(async () => {
  await media?.stop();

  if (workspace !== "") await rm(workspace, { recursive: true, force: true });
});

test("an admin backs up now from the command menu and asks before restoring", async ({ page }) => {
  if (stack === null) return;
  test.setTimeout(BACKUP_TIMEOUT_MS + 60_000);

  const owner = await signInOwner(stack);
  const mod = process.platform === "darwin" ? "Meta" : "Control";
  const before = new Set((await owner.sdk.query("backups.list", {})).map((backup) => backup.id));

  const jobsBefore = new Set(
    (await owner.sdk.query("jobs.list", { kind: "backup", limit: 100 })).map((job) => job.id),
  );

  const queued = async (): Promise<JobId | null> =>
    (await owner.sdk.query("jobs.list", { kind: "backup", limit: 100 })).find(
      (job) => !jobsBefore.has(job.id),
    )?.id ?? null;

  await useSession(page, owner);
  await page.goto("/admin/backups");
  await expect(page.getByRole("heading", { level: 1, name: "Backups" })).toBeVisible();

  await page.keyboard.press(`${mod}+k`);
  await page.getByRole("combobox").fill("back up now");
  await page.keyboard.press("Enter");

  await expect.poll(queued).not.toBeNull();
  const jobId = await queued();

  if (jobId === null) throw new Error("Back up now queued nothing");

  await expect
    .poll(async () => (await owner.sdk.query("jobs.get", { jobId })).status, {
      timeout: BACKUP_TIMEOUT_MS,
    })
    .toBe("succeeded");

  const recorded = async () =>
    (await owner.sdk.query("backups.list", {})).find(
      (backup) => !before.has(backup.id) && backup.trigger === "manual",
    ) ?? null;

  await expect.poll(recorded).not.toBeNull();
  const archive = await recorded();

  if (archive === null) throw new Error("The backup job recorded no archive");

  const row = page.getByRole("row").filter({ hasText: archive.fileName });
  await expect(row).toContainText("Manual");
  await expect(row).toContainText("today");
  await expect(page.getByRole("button", { name: "Back up now" })).toBeEnabled();

  await row.getByRole("button", { name: /Restore/u }).click();
  await expect(row).toContainText("Selected");
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText(
    "Everything since then is replaced, and everyone is signed out while the server restarts.",
  );
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).toBeHidden();
  await expect(row).not.toContainText("Selected");
});
