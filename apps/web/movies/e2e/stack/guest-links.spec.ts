import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

import { generateFixtureLibrary } from "./fixture-library";
import { createLibrary, removeLibrary, waitForScan } from "./libraries";
import type { LibraryId } from "./libraries";
import { buildMediaService, startMediaService } from "./media-service";
import type { MediaService } from "./media-service";
import { NO_STACK, createPerson, moviesPath, reachableStack, signIn, signInClient } from "./people";
import type { Client } from "./people";

test.use({ trace: "off", screenshot: "off", video: "off" });

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

let context: BrowserContext | undefined;

let page: Page;

let media: MediaService | undefined;

let admin: Client | undefined;

let workspace = "";

const libraries: Array<LibraryId> = [];

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;
  test.setTimeout(180_000);
  workspace = await mkdtemp(join(tmpdir(), "media-guest-e2e-"));
  const movies = join(workspace, "Movies");
  await generateFixtureLibrary(browser, movies, join(workspace, "Shows"));
  buildMediaService();
  const person = await createPerson(stack, "guest-admin");
  admin = await signInClient(stack, person);

  const libraryId = await createLibrary(
    admin.platform,
    { name: "Guest movies", folders: [movies] },
    false,
  );

  libraries.push(libraryId);
  media = await startMediaService(stack, [workspace]);
  await waitForScan(admin.platform, libraryId).catch((cause: unknown) => {
    throw new Error(`The guest fixture did not scan:\n${media?.logs() ?? "No media service"}`, {
      cause,
    });
  });
  context = await browser.newContext();
  page = await context.newPage();
  await signIn(page, person);
});

test.afterAll(async () => {
  await context?.close();

  if (admin !== undefined) {
    const { platform } = admin;
    await Promise.all(libraries.map((libraryId) => removeLibrary(platform, libraryId)));
    await platform.dispose();
  }

  await media?.stop();

  if (workspace !== "") await rm(workspace, { recursive: true, force: true });
});

const signedIn = (): Client => {
  if (admin === undefined) throw new Error("The admin did not sign in");

  return admin;
};

test.describe("guest links", () => {
  test("an allowed maker creates and revokes a title link; a member without leave has no entry", async ({
    browser,
  }) => {
    if (stack === null) return;
    const { platform } = signedIn();
    const guestAddress = "http://guests.example.test";
    const originalPolicy = await platform.core.guests.status();
    await platform.core.guests.configure({ enabled: true, address: guestAddress });

    try {
      const titles = await platform.movies.titles.search({ query: "Arrival" });
      const title = titles[0];

      if (title === undefined) throw new Error("the scanned title is missing");

      const member = await createPerson(stack, "guest-member", "member");
      const libraryId = libraries[0];

      if (libraryId === undefined) throw new Error("the movies library is missing");
      const memberClient = await signInClient(stack, member);
      const me = await memberClient.platform.core.auth.sessions.current();
      await platform.core.permissions.grants.set({
        resource: { type: "library", id: libraryId },
        principal: { kind: "user", userId: me.userId },
        level: "view",
      });
      const memberContext = await browser.newContext();

      try {
        const memberPage = await memberContext.newPage();
        let policyLoaded = false;
        memberPage.on("websocket", (socket) => {
          socket.on("framereceived", ({ payload }) => {
            if (/"mayShare"\s*:\s*false/u.test(payload.toString())) policyLoaded = true;
          });
        });
        await signIn(memberPage, member);
        await memberPage.goto(moviesPath(`/title/${title.id}`));
        await expect(memberPage.getByRole("button", { name: "Add to My List" })).toBeVisible();
        await expect.poll(() => policyLoaded).toBe(true);
        await memberPage.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
        await expect(
          memberPage.getByRole("button", { name: "Guest link", exact: true }),
        ).toHaveCount(0);
      } finally {
        await memberContext.close();
        await memberClient.platform.dispose();
      }

      await page.goto(moviesPath(`/title/${title.id}`));
      await page.addStyleTag({
        content: '[data-sensitive="guest-link"] { visibility: hidden !important; }',
      });
      await page.getByRole("button", { name: "Guest link", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: `Share ${title.name}` });
      await expect(dialog.getByLabel("Expires in days")).toHaveValue("7");
      await dialog.getByRole("button", { name: "Create link", exact: true }).click();

      const addressMatches = await dialog
        .getByLabel("New guest link")
        .evaluate(
          (element, expected) =>
            element instanceof HTMLInputElement && new URL(element.value).origin === expected,
          guestAddress,
        );

      expect(addressMatches).toBe(true);
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(dialog.getByLabel("New guest link")).toHaveCount(1);
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(dialog.getByLabel("New guest link")).toHaveCount(1);
      await expect(dialog.getByRole("region", { name: "Your guest links" })).toContainText("open");
      await dialog.getByRole("button", { name: "Copy", exact: true }).click();
      await expect(dialog.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await page.getByRole("button", { name: "Guest link", exact: true }).click();
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
            row.target.item.ref.id === title.id &&
            row.state === "revoked",
        ),
      ).toBe(true);
    } finally {
      await platform.core.guests.configure({
        enabled: originalPolicy.enabled,
        address: originalPolicy.address,
      });
    }
  });
});
