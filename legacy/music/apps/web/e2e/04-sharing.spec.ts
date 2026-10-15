import { expect, test } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { createInvite, freshEmail, join, seed, seedDevice, signIn, unique } from "./support";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  // Idempotent: ensures the owner, the /music library, and its songs.
  seed();
});

/** The titles of the songs in "Next up", in order, read from their drag handles. */
const upNext = async (queue: Locator): Promise<ReadonlyArray<string>> =>
  (
    await queue
      .getByRole("button", { name: /^Move / })
      .evaluateAll((handles) => handles.map((handle) => handle.getAttribute("aria-label")))
  ).map((label) => (label ?? "").replace(/^Move /u, ""));

/** The song titles of a playlist's table, in order. */
const playlistOrder = async (page: Page, name: string): Promise<ReadonlyArray<string>> =>
  (
    await page
      .getByRole("table", { name: `Songs in ${name}` })
      .getByRole("button", { name: /^Move / })
      .evaluateAll((handles) => handles.map((handle) => handle.getAttribute("aria-label")))
  ).map((label) => (label ?? "").replace(/^Move /u, ""));

test("reorder the queue with the keyboard and by dragging", async ({ page }) => {
  await signIn(page);
  await page.goto("/albums");
  await page.getByRole("link", { name: "Blue Lines" }).first().click();
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  // A stand-in speaker plays, so this browser shows the queue without needing audio.
  seedDevice("Kitchen speaker");

  await page.getByRole("button", { name: "Queue", exact: true }).click();
  const queue = page.getByRole("complementary", { name: "Queue" });

  // The queue this test just started, not one left from an earlier run.
  await expect(queue.getByRole("button", { name: "Now playing: Safe From Harm" })).toBeAttached();
  await expect.poll(async () => (await upNext(queue)).length).toBe(8);
  const before = await upNext(queue);
  const [first, second, third] = before;

  // Keyboard: focus the third song's handle and press the up arrow.
  await queue.getByRole("button", { name: `Move ${third}`, exact: true }).focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => upNext(queue)).toEqual([first, third, second, ...before.slice(3)]);

  // Drag: drop the first song on the lower half of the third row.
  const rows = queue
    .getByTestId("queue-row")
    .filter({ has: page.getByRole("button", { name: /^Move / }) });

  const target = await rows.nth(2).boundingBox();

  if (target === null) throw new Error("The third row is not on screen");
  await rows.nth(0).hover();
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height * 0.75, {
    steps: 8,
  });
  await page.mouse.up();
  await expect.poll(() => upNext(queue)).toEqual([third, second, first, ...before.slice(3)]);
});

test("share a playlist: a collaborator adds a song, the owner reorders, then stops sharing", async ({
  page,
  browser,
}) => {
  const name = unique("Road trip");
  const friend = unique("Noor");

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await signIn(page);

  // A friend joins the server.
  const other = await join(browser, await createInvite(page, "Member"), freshEmail("noor"), friend);

  // The owner makes a playlist from an album the friend can hear too: the copy the friend's
  // library lists, since an earlier test may leave a private copy of the same files.
  await other.goto("/albums");
  await other.getByRole("link", { name: "Dummy" }).first().click();
  await expect(other.getByRole("heading", { name: "Dummy" }).first()).toBeVisible();
  const album = other.url();

  await page.goto("/");
  await page.getByRole("button", { name: "New playlist" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name }).first()).toBeVisible();
  await page.goto(album);
  await page.getByRole("button", { name: "More actions for Dummy" }).first().click();
  await page.getByRole("menuitem", { name: "Add to playlist" }).hover();
  await page.getByRole("menuitem", { name }).click();
  await expect(page.getByText(`Added to ${name}`)).toBeVisible();

  // The owner shares it with them as a collaborator, and copies the link.
  await page.getByRole("navigation", { name: "Library" }).getByRole("link", { name }).click();
  await page.getByRole("button", { name: "Share", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: `Share ${name}` });

  await dialog.getByRole("button", { name: "Add someone" }).click();
  await page.getByRole("menuitem", { name: `${friend} · Member` }).click();
  await dialog
    .getByRole("group", { name: `What ${friend} can do` })
    .getByRole("button", { name: "Can edit" })
    .click();
  await expect(
    dialog.getByRole("group", { name: `What ${friend} can do` }).getByRole("button", {
      name: "Can edit",
    }),
  ).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Copy link" }).click();
  await expect(page.getByText("Link copied")).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());

  expect(link).toMatch(/\/playlists\//u);
  await dialog.getByRole("button", { name: "Done" }).click();

  // The friend finds it under "Shared with you" and adds a song from another album.
  await other.reload();
  const shared = other.getByRole("region", { name: "Shared with you" }).first();

  await shared.getByRole("link", { name }).click();
  await expect(other.getByRole("table", { name: `Songs in ${name}` })).toContainText("Glory Box");
  await other.goto("/albums");
  await other.getByRole("link", { name: "Moon Safari" }).first().click();
  await other.getByRole("row").filter({ hasText: "Sexy Boy" }).hover();
  await other.getByRole("button", { name: "More actions for Sexy Boy" }).last().click();
  await other.getByRole("menuitem", { name: "Add to playlist" }).hover();
  await other.getByRole("menuitem", { name }).click();
  await expect(other.getByText(`Added to ${name}`)).toBeVisible();

  // The owner sees who added it, and moves it to the top with the keyboard.
  const table = page.getByRole("table", { name: `Songs in ${name}` });

  await expect(table.getByRole("row").filter({ hasText: "Sexy Boy" })).toContainText(
    `Added by ${friend}`,
  );
  const before = await playlistOrder(page, name);

  const handle = table.getByRole("button", { name: "Move Sexy Boy", exact: true });

  // One step at a time, each landing before the next, as someone pressing the key would see it.
  // The press goes to the handle each time: the row re-renders as the list moves.
  await Array.from({ length: before.length - 1 }, (_, step) => step).reduce<Promise<void>>(
    async (previous, step) => {
      await previous;
      await handle.press("ArrowUp");
      await expect
        .poll(async () => (await playlistOrder(page, name)).indexOf("Sexy Boy"))
        .toBe(before.length - 2 - step);
    },
    Promise.resolve(),
  );
  await expect
    .poll(() => playlistOrder(page, name))
    .toEqual(["Sexy Boy", ...before.filter((title) => title !== "Sexy Boy")]);

  // The owner stops sharing: the friend's link now opens the no-access state.
  await page.getByRole("button", { name: "Share", exact: true }).first().click();
  await page.getByRole("button", { name: "Stop sharing", exact: true }).click();
  await expect(page.getByText(`Stopped sharing ${name}`)).toBeVisible();
  await other.goto(link);
  await expect(other.getByRole("heading", { name: "You can't open this playlist" })).toBeVisible();
  await other.close();
});
