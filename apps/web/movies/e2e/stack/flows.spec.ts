import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

import { clientErrors } from "./client-errors";
import { generateFixtureLibrary } from "./fixture-library";
import { createLibrary, removeLibrary, scanStatus, waitForScan } from "./libraries";
import type { LibraryId } from "./libraries";
import { buildMediaService, startMediaService } from "./media-service";
import type { MediaService } from "./media-service";
import {
  NO_STACK,
  createPerson,
  moviesPath,
  reachableStack,
  signIn,
  signInClient,
  signedInPage,
} from "./people";
import type { Client, Person } from "./people";

test.use({ trace: "off", screenshot: "off", video: "off" });

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

const run = Date.now().toString(36);

const mod = process.platform === "darwin" ? "Meta" : "Control";

const SETUP_TIMEOUT_MS = 180_000;

const SCAN_TIMEOUT_MS = 60_000;

let context: BrowserContext;

let page: Page;

let media: MediaService | undefined;

let admin: Client | undefined;

let person: Person | undefined;

let workspace = "";

let libraryRoot = "";

let nasRoot = "";

const libraries: Array<LibraryId> = [];

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "media-web-e2e-"));
  libraryRoot = join(workspace, "library");
  nasRoot = join(workspace, "nas");
  await mkdir(libraryRoot, { recursive: true });
  await generateFixtureLibrary(browser, join(libraryRoot, "Movies"), join(nasRoot, "Shows"));
  buildMediaService();
  person = await createPerson(stack, "admin");
  admin = await signInClient(stack, person);
  context = await browser.newContext();
  page = await context.newPage();
  await signIn(page, person);
});

test.afterAll(async () => {
  if (stack === null) return;

  await context.close();

  if (admin !== undefined) {
    const { platform } = admin;

    await Promise.all(libraries.map((libraryId) => removeLibrary(platform, libraryId)));
    await platform.dispose();
  }

  await media?.stop();
  await rm(workspace, { recursive: true, force: true });
});

const signedIn = (): Client => {
  if (admin === undefined) throw new Error("The admin did not sign in");

  return admin;
};

const restartMedia = async (roots: ReadonlyArray<string>): Promise<void> => {
  if (stack === null) return;

  await media?.stop();
  media = await startMediaService(stack, roots);
};

const openMenu = async (target: Page): Promise<void> => {
  await expect(target.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await target.keyboard.press(`${mod}+k`);
  await expect(target.getByRole("combobox")).toBeFocused();
};

const capture = async (target: Page, name: string): Promise<void> => {
  const folder = process.env["E2E_SCREENSHOTS"];

  if (folder === undefined || folder === "") return;

  await target.waitForLoadState("networkidle");
  await target.waitForTimeout(400);

  await target.getByRole("button", { name: /TanStack Router/u }).evaluateAll((buttons) => {
    for (const button of buttons) {
      if (button instanceof HTMLElement) button.style.visibility = "hidden";
    }
  });

  await target.screenshot({ path: `${folder}/${name}.png` });
};

test("a new library waits for the media service in the corner card, then fills Home", async () => {
  const { platform } = signedIn();
  const name = `Movies ${run}`;

  await page.goto(moviesPath());

  libraries.push(
    await createLibrary(platform, { name, folders: [join(libraryRoot, "Movies")] }, false),
  );

  const toast = page.getByRole("region", { name: "Library scan" });

  await expect(toast).toContainText(`Scanning ${name}`);
  await expect(toast).toContainText("Waiting for the media service");
  await capture(page, "05-07-scanning");

  await restartMedia([libraryRoot]);
  await expect(toast).toHaveCount(0, { timeout: 30_000 });
  await expect(
    page.getByRole("region", { name: "Recently added" }).getByRole("link", { name: "Arrival" }),
  ).toBeVisible();
});

test("a scan of a folder the media service may not read fails, and succeeds once it may", async () => {
  const { platform } = signedIn();
  const shows = join(nasRoot, "Shows");

  const libraryId = await createLibrary(
    platform,
    { name: `Shows ${run}`, folders: [shows] },
    false,
  );

  libraries.push(libraryId);

  await expect
    .poll(() => scanStatus(platform, libraryId), { timeout: SCAN_TIMEOUT_MS })
    .toBe("failed");
  expect((await platform.core.libraries.get({ libraryId })).scan?.error).toContain(
    "outside LIBRARY_ROOTS",
  );

  await restartMedia([libraryRoot, nasRoot]);
  await platform.core.libraries.scan({ libraryId });
  await waitForScan(platform, libraryId);
});

test("home shows the library; a title opens, joins My List, and the keyboard navigates", async () => {
  await page.goto(moviesPath());

  const recent = page.getByRole("region", { name: "Recently added" });

  await expect(recent.getByRole("link", { name: "Arrival" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Shows" })).toBeVisible();
  await capture(page, "05-01-home");

  await recent.getByRole("link", { name: "Arrival" }).click();
  await expect(page.getByRole("heading", { name: "ARRIVAL" })).toBeVisible();
  await expect(page.getByText("PG-13", { exact: true })).toBeVisible();
  await expect(page.getByText("HEVC", { exact: true })).toBeVisible();
  await capture(page, "05-02-movie");

  await page.getByRole("button", { name: "Add to My List" }).click();
  await expect(page.getByRole("button", { name: "Remove from My List" })).toBeVisible();

  await page.keyboard.press("g");
  await page.keyboard.press("l");
  await expect(page).toHaveURL(/\/movies\/my-list$/u);
  await expect(page.getByRole("link", { name: /Arrival/u })).toBeVisible();

  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page).toHaveURL(/\/movies\/shows$/u);
  await page.getByRole("link", { name: /Severance/u }).click();
  await expect(page.getByRole("region", { name: "Episodes" })).toBeVisible();
  await expect(page.getByText("Good News About Hell", { exact: true })).toBeVisible();
  await capture(page, "05-03-show");

  await openMenu(page);
  await capture(page, "12-01-menu");
  await page.getByRole("combobox").fill("Dune");
  await expect(
    page.getByRole("group", { name: "Titles" }).getByRole("option", { name: /Dune Part Two/u }),
  ).toBeVisible();
  await capture(page, "12-02-menu-search");
  await page.getByRole("combobox").fill("movies");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/movies\/movies$/u);
  await expect(page.getByRole("link", { name: /Sicario/u })).toBeVisible();
});

test("a kid limited to PG finds what they may see and nothing rated above it", async ({
  browser,
}) => {
  if (stack === null) return;

  const { platform } = signedIn();
  const kid = await createPerson(stack, "kid", "member");
  const kidClient = await signInClient(stack, kid);
  const { userId } = await kidClient.platform.core.auth.sessions.current();

  await kidClient.platform.dispose();

  await platform.core.restrictions.set({
    userId,
    restrictions: { maxMovieAge: 7, hideUnrated: false, hideExplicitMusic: false, libraries: null },
  });
  await Promise.all(
    libraries.map((libraryId) =>
      platform.core.permissions.grants.set({
        resource: { type: "library", id: libraryId },
        principal: { kind: "user", userId },
        level: "view",
      }),
    ),
  );

  const tab = await signedInPage(browser, kid);

  try {
    await tab.goto(moviesPath());
    await openMenu(tab);
    await tab.getByRole("combobox").fill("Totoro");
    await expect(
      tab
        .getByRole("group", { name: "Titles" })
        .getByRole("option", { name: /My Neighbor Totoro/u }),
    ).toBeVisible();
    await capture(tab, "06-02-kids-results");

    await tab.getByRole("combobox").fill("Sicario");
    await expect(tab.getByRole("group", { name: "Titles" })).toHaveCount(0);
    await tab.keyboard.press("Escape");

    await tab.goto(moviesPath(`/search?q=${encodeURIComponent("Sicario")}`));
    await expect(tab.getByRole("heading", { name: "No results for “Sicario”" })).toBeVisible();
    await capture(tab, "06-03-no-results");
  } finally {
    await tab.context().close();
  }
});

test("app errors reach the server's log while signed in, never while signed out", async ({
  browser,
}) => {
  if (stack === null) return;

  const { platform } = signedIn();
  const signedOut = await browser.newContext();
  const stranger = await signedOut.newPage();
  const strangerReports: Array<string> = [];

  stranger.on("request", (request) => {
    if (request.url().includes("/api/client-errors")) strangerReports.push(request.url());
  });

  await stranger.goto(moviesPath());
  await expect(stranger).toHaveURL(/\/$/u);
  await expect(stranger.getByRole("button", { name: "Sign in" })).toBeVisible();
  await stranger.evaluate((message) => {
    void Promise.reject(new Error(message));
  }, `signed-out-${run}`);

  await page.goto(moviesPath("/dev/crash"));
  await expect(page.getByRole("heading", { name: "Something went wrong" })).toBeVisible();
  await page.evaluate((message) => {
    void Promise.reject(new Error(message));
  }, `signed-in-${run}`);

  const reported = async () => clientErrors(stack.mediaUrl, await platform.session.accessToken());

  await expect
    .poll(reported)
    .toEqual(
      expect.arrayContaining([
        "route This screen crashed on purpose",
        `unhandled-rejection signed-in-${run}`,
      ]),
    );
  expect((await reported()).join("\n")).not.toContain(`signed-out-${run}`);
  expect(strangerReports).toStrictEqual([]);
  await signedOut.close();
});

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
