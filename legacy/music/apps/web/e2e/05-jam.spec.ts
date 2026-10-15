import { expect, test } from "@playwright/test";
import type { Browser, BrowserContextOptions, Page } from "@playwright/test";

import { createInvite, freshEmail, join, seed, seedDevice, signIn, unique } from "./support";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  // Idempotent: ensures the owner, the /music library, and its songs.
  seed();
});

/**
 * Set `JAM_VIDEO_DIR` to record both browsers. The Jam link and its QR code are blurred in the
 * recording: they let anyone in.
 */
const videoDir = process.env["JAM_VIDEO_DIR"];

const recording = (): BrowserContextOptions =>
  videoDir === undefined
    ? { viewport: { width: 1280, height: 800 } }
    : {
        viewport: { width: 1280, height: 800 },
        recordVideo: { dir: videoDir, size: { width: 1280, height: 800 } },
      };

const hideSecrets = async (page: Page): Promise<void> => {
  if (videoDir === undefined) return;

  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      const style = document.createElement("style");

      style.textContent =
        '[data-testid="jam-link"], [aria-label="QR code for the Jam link"] { filter: blur(8px); }';
      document.head.append(style);
    });
  });
};

/** A new browser for `page`'s signed-in person, recorded when asked, so setup stays off camera. */
const reopen = async (browser: Browser, page: Page): Promise<Page> => {
  const context = await browser.newContext({
    ...recording(),
    storageState: await page.context().storageState(),
  });

  const fresh = await context.newPage();

  await hideSecrets(fresh);

  return fresh;
};

const bar = (page: Page) => page.getByRole("region", { name: "Player" });

const band = (page: Page) => page.getByRole("status", { name: "Jam" });

/** Opens the Jam link as someone signed in and joins. */
const joinJam = async (page: Page, link: string): Promise<void> => {
  await page.goto(link);
  await page.getByRole("button", { name: "Join", exact: true }).click();
  await expect(page.getByText("You're in the Jam")).toBeVisible();
};

test("a Jam from link to end: join, add a song, follow a skip, remove, end", async ({
  page,
  browser,
}) => {
  test.setTimeout(120_000);
  const friend = unique("Noor");

  // Off camera: the host signs in and invites a friend, who makes an account.
  await signIn(page);

  const invited = await join(
    browser,
    await createInvite(page, "Member"),
    freshEmail("noor"),
    friend,
  );

  const host = await reopen(browser, page);
  const member = await reopen(browser, invited);

  await invited.context().close();

  // The host plays an album on their kitchen speaker and starts a Jam from the queue panel.
  await host.goto("/albums");
  await host.getByRole("link", { name: "Blue Lines" }).first().click();
  await host.getByRole("button", { name: "Play", exact: true }).first().click();
  await expect(
    bar(host).getByRole("button", { name: "Safe From Harm", exact: true }),
  ).toBeVisible();
  seedDevice("Kitchen speaker");
  await bar(host).getByRole("button", { name: "Queue", exact: true }).click();
  await host
    .getByRole("complementary", { name: "Queue" })
    .getByRole("button", { name: "Start a Jam" })
    .click();
  await host.getByRole("dialog").getByRole("button", { name: "Start a Jam" }).click();
  const link = await host.getByTestId("jam-link").inputValue();

  expect(link).toMatch(/\/jam\/[a-z0-9]+$/u);
  await host.keyboard.press("Escape");

  // The friend opens the link: the landing page names the host, then they're in, listening along.
  await member.goto(link);
  await expect(member.getByRole("heading", { name: /Jam$/u })).toBeVisible();
  await joinJam(member, link);
  await expect(band(member)).toContainText("listening along here");
  await expect(
    bar(member).getByRole("button", { name: "Safe From Harm", exact: true }),
  ).toBeVisible();

  // They add a song; the host's queue says who added it.
  await member.goto("/albums");
  await member.getByRole("link", { name: "Moon Safari" }).first().click();
  await member.getByRole("row").filter({ hasText: "Sexy Boy" }).hover();
  await member.getByRole("button", { name: "More actions for Sexy Boy" }).last().click();
  await member.getByRole("menuitem", { name: "Add to queue" }).click();
  await expect(member.getByText("Added Sexy Boy to the queue")).toBeVisible();
  await expect(
    host.getByRole("complementary", { name: "Queue" }).getByTestId("queue-row").filter({
      hasText: "Sexy Boy",
    }),
  ).toContainText(`Added by ${friend}`);

  // The host skips; the friend's player follows.
  await bar(host).getByRole("button", { name: "Next", exact: true }).click();
  await expect(bar(member).getByRole("button", { name: "One Love", exact: true })).toBeVisible();

  // The host removes them: the band goes, their own player is back, and the link won't let them in.
  await band(host).getByRole("button", { name: "Manage" }).click();
  await host.getByRole("button", { name: `Remove ${friend} from the Jam` }).click();
  await expect(band(member)).toHaveCount(0);
  await expect(bar(member).getByRole("button", { name: "One Love", exact: true })).toHaveCount(0);
  // Until a new link, nobody new comes straight in, so they can't return as someone new either.
  await expect(host.getByText("New people need your OK because you removed someone")).toBeVisible();
  await member.goto(link);
  await member.getByRole("button", { name: "Ask to join", exact: true }).click();
  await expect(member.getByText("The host removed you from this Jam")).toBeVisible();

  // A new link lets them back; then the host ends the Jam and they get their own player back.
  await host.getByRole("button", { name: "New link" }).click();
  await expect(host.getByTestId("jam-link")).not.toHaveValue(link);
  const fresh = await host.getByTestId("jam-link").inputValue();

  await joinJam(member, fresh);
  await expect(band(member)).toBeVisible();
  await host.getByRole("button", { name: "End Jam" }).click();
  await expect(band(member)).toContainText("The Jam ended");
  await band(member).getByRole("button", { name: "Back to your music" }).click();
  await member.getByRole("dialog").getByRole("button", { name: "Back to your music" }).click();
  await expect(band(member)).toHaveCount(0);
  await expect(band(host)).toHaveCount(0);

  await host.context().close();
  await member.context().close();
});
