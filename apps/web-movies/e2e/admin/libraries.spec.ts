import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { drawPoster, encodeClip } from "../stack/fixture-library";
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
import type { Client } from "../stack/people";
import type { StackEnv } from "../stack/stack-env";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

const SETUP_TIMEOUT_MS = 180_000;

const SCAN_TIMEOUT_MS = 30_000;

const run = Date.now().toString(36);

let workspace = "";

let media: MediaService | undefined;

let admin: Client | undefined;

const withoutProvider = (env: StackEnv): StackEnv => ({
  ...env,
  mediaEnv: Object.fromEntries(
    Object.entries(env.mediaEnv).filter(([name]) => name !== "TMDB_API_KEY"),
  ),
});

const ARRIVAL_NFO = `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>Arrival</title>
  <year>2016</year>
  <uniqueid type="tmdb" default="true">329865</uniqueid>
</movie>
`;

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "movies-web-admin-"));

  const films = join(workspace, "Films");
  const arrival = join(films, "Arrival (2016)");

  await mkdir(arrival, { recursive: true });
  await Promise.all([
    encodeClip(join(arrival, "Arrival.2016.1080p.mkv")),
    writeFile(join(arrival, "movie.nfo"), ARRIVAL_NFO),
    drawPoster(browser, "Arrival", join(arrival, "poster.jpg")),
    encodeClip(join(films, "Stalker.1979.Criterion.mkv")),
    encodeClip(join(films, "The.Prestige.2006.mkv")),
  ]);
  buildMediaService();
});

test.afterAll(async () => {
  if (admin !== undefined) {
    const { platform } = admin;
    await removeLibrariesUnder(platform, workspace);
    await platform.dispose();
  }

  await media?.stop();

  if (workspace !== "") await rm(workspace, { recursive: true, force: true });
});

test("an admin adds a library in the account client, cancels and restarts its scan, reviews its files, fixes a match, and sees the folder go offline", async ({
  page,
}) => {
  if (stack === null) return;

  test.setTimeout(120_000);

  const person = await createPerson(stack, "admin");
  const name = `Films ${run}`;
  const root = join(workspace, "Films");

  admin = await signInClient(stack, person);
  await signIn(page, person);
  await page.goto(moviesPath("/admin/libraries"));
  await expect(page.getByRole("heading", { name: "Libraries" })).toBeVisible();

  await page.getByRole("link", { name: "Manage in account" }).click();
  await expect(page).toHaveURL(/:\d+\/admin\/libraries$/u);
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("Folders, one per line").fill(root);
  await page.getByRole("button", { name: "Add library" }).click();
  await expect(page.getByRole("link", { name })).toBeVisible();

  await page.goto(moviesPath("/admin/libraries"));

  const row = page.getByRole("rowgroup").filter({ hasText: name });
  await expect(row).toContainText(root);
  await expect(row).toContainText("Queued");

  // The queued scan cancels from its row, and the command menu cancels the next one.
  await row.getByRole("button", { name: `Cancel the scan of ${name}` }).click();
  await expect(row.getByRole("button", { name: `Scan ${name} now` })).toBeVisible();
  await row.getByRole("button", { name: `Scan ${name} now` }).click();
  await expect(row).toContainText("Queued");
  await page.keyboard.press("ControlOrMeta+k");
  await page.getByRole("combobox").fill("cancel scan");
  await page.getByRole("option", { name: "Cancel scan" }).click();
  await expect(row.getByRole("button", { name: `Scan ${name} now` })).toBeVisible();
  await row.getByRole("button", { name: `Scan ${name} now` }).click();
  await expect(row).toContainText("Queued");

  media = await startMediaService(withoutProvider(stack), [workspace]);
  await expect(row).toContainText("Ready", { timeout: SCAN_TIMEOUT_MS });
  await expect(row).toContainText("3 titles");

  await row.getByRole("link", { name }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();

  const files = page.getByRole("table", { name: "Files" });
  const fileRow = (file: string) => files.getByRole("row").filter({ hasText: file });
  const filter = (label: string) => page.getByRole("radio", { name: new RegExp(`^${label}`, "u") });

  // One row per file: what it plays as, its name with the whole path on hover, quality, and state.
  await expect(fileRow("Arrival.2016.1080p.mkv")).toContainText("Arrival (2016)");
  await expect(
    fileRow("Arrival.2016.1080p.mkv").getByText("Arrival.2016.1080p.mkv"),
  ).toHaveAttribute("title", join(root, "Arrival (2016)", "Arrival.2016.1080p.mkv"));
  await expect(fileRow("Stalker.1979.Criterion.mkv")).toContainText("Unmatched");
  await expect(fileRow("Stalker.1979.Criterion.mkv")).toContainText(/\d+p · /u);
  await expect(fileRow("The.Prestige.2006.mkv")).toBeVisible();
  await expect(filter("Unmatched")).toContainText(/\d/u);

  await rm(join(root, "The.Prestige.2006.mkv"));
  await page.getByRole("button", { name: "Scan now" }).click();
  await expect(fileRow("The.Prestige.2006.mkv")).toContainText("Missing", {
    timeout: SCAN_TIMEOUT_MS,
  });
  await expect(fileRow("The.Prestige.2006.mkv")).toContainText("since");
  await expect(fileRow("Arrival.2016.1080p.mkv")).not.toContainText("Missing");

  // The banner counts the missing files since the first went, and reviews them.
  const notice = page.getByRole("note");
  await expect(notice).toContainText("1 file disappeared since");
  await notice.getByRole("button", { name: "Review 1 missing" }).click();
  await expect(filter("Missing")).toHaveAttribute("aria-checked", "true");
  await expect(fileRow("The.Prestige.2006.mkv")).toBeVisible();
  await expect(fileRow("Stalker.1979.Criterion.mkv")).toBeHidden();
  await expect(notice.getByRole("button", { name: "Review 1 missing" })).toBeHidden();

  await filter("All").click();
  await page.getByLabel("Filter by title or filename").fill("criterion");
  await expect(fileRow("Arrival.2016.1080p.mkv")).toBeHidden();

  await fileRow("Stalker.1979.Criterion.mkv").getByRole("link", { name: "Fix match" }).click();
  await expect(page.getByRole("heading", { name: "Fix match" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText(
    "TMDB search isn’t available on this server",
  );
  await page.getByLabel("Title", { exact: true }).fill("Stalker (Criterion)");
  await page.getByRole("button", { name: "Apply match" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(fileRow("Stalker.1979.Criterion.mkv")).toContainText("Stalker (Criterion)");
  await expect(fileRow("Stalker.1979.Criterion.mkv")).toContainText("Matched by hand");

  await fileRow("Arrival.2016.1080p.mkv").getByRole("link", { name: "Arrival (2016)" }).click();
  const poster = page.getByRole("img", { name: "Arrival" });
  await expect(poster).toHaveAttribute("src", /\/artwork\/.*[?&]ticket=/u);
  await expect
    .poll(() => poster.evaluate((image) => image instanceof HTMLImageElement && image.naturalWidth))
    .toBeGreaterThan(0);
  await page.getByRole("link", { name: "Cancel" }).click();

  await rename(root, `${root}-offline`);
  await page.getByRole("button", { name: "Scan now" }).click();
  await expect(page.getByRole("heading", { name: "Can’t reach your NAS" })).toBeVisible({
    timeout: SCAN_TIMEOUT_MS,
  });
  await expect(page.getByText(/Offline since/u)).toBeVisible();
  await page.getByRole("button", { name: "View log" }).click();
  await expect(page.getByRole("dialog", { name: "Last scan" })).toContainText(root);
  await page.keyboard.press("Escape");

  await rename(`${root}-offline`, root);
  await page.getByRole("button", { name: "Retry now" }).click();
  await expect(page.getByRole("heading", { name: "Can’t reach your NAS" })).toBeHidden({
    timeout: SCAN_TIMEOUT_MS,
  });
  await expect(fileRow("Arrival.2016.1080p.mkv")).toBeVisible();
});
