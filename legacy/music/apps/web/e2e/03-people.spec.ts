import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createInvite, freshEmail, join, seed, signIn, unique } from "./support";

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  // Idempotent: ensures the owner, the /music library, and its songs.
  seed();
});

/** Opens the actions menu of someone on the People screen and picks `item`. */
const personAction = async (page: Page, name: string, item: string): Promise<void> => {
  await page.getByRole("button", { name: `Actions for ${name}` }).click();
  await page.getByRole("menuitem", { name: item }).click();
};

test("an admin invites a guest, changes their role, resets, suspends, and removes them", async ({
  page,
  browser,
}) => {
  await signIn(page);

  const name = unique("Ana");
  const email = freshEmail("guest");
  const guest = await join(browser, await createInvite(page, "Guest"), email, name);

  // A guest hears nothing until added to a library, and has no API keys or server settings.
  await expect(guest.getByText("No library folder is shared with you yet")).toBeVisible();
  await guest.goto("/settings/account");
  await expect(guest.getByText(`${name} · Guest`)).toBeVisible();

  const nav = guest.getByRole("navigation", { name: "Settings" });

  await expect(nav.getByRole("link", { name: "Account" })).toBeVisible();
  await expect(nav.getByRole("link", { name: "API keys" })).toHaveCount(0);
  await expect(nav.getByRole("link", { name: "People" })).toHaveCount(0);

  await page.goto("/settings/people");

  const row = page.getByRole("listitem", { name });

  await expect(row.getByText("Guest", { exact: true })).toBeVisible();
  await expect(row.getByText(/Active/).first()).toBeAttached();

  await personAction(page, name, "Change role…");
  await page.getByRole("dialog").getByRole("button", { name: "Member" }).click();
  await page.getByRole("button", { name: "Save role" }).click();
  await expect(row.getByText("Member", { exact: true })).toBeVisible();

  // A reset link sets a new password, signs in, and ends the other sessions.
  await personAction(page, name, "Create password reset link…");
  await expect(page.getByText(/also turns off this person's API keys/)).toBeVisible();
  await page.getByRole("button", { name: "Create link" }).click();

  const resetLink = (await page.getByTestId("reset-link").textContent()) ?? "";

  expect(resetLink).toContain("/reset/");
  await page.getByRole("button", { name: "Done" }).click();

  const resetter = await (await browser.newContext()).newPage();

  await resetter.goto(resetLink);
  await expect(resetter.getByRole("heading", { name: "Choose a new password" })).toBeVisible();
  await expect(resetter.getByText(/also turns off this person's API keys/)).toBeVisible();
  await resetter.getByLabel("New password").fill("a-brand-new-password");
  await resetter.getByRole("button", { name: "Set password and sign in" }).click();
  await expect(resetter.getByRole("navigation", { name: "Library" })).toBeVisible();

  // The open tab notices at once: its reads fail and it offers to sign in again.
  await expect(guest.getByRole("heading", { name: "You're signed out" })).toBeVisible();

  await resetter.goto(resetLink);
  await expect(
    resetter.getByRole("heading", { name: "This reset link was already used" }),
  ).toBeVisible();
  await resetter.goto("/settings/account");
  await expect(resetter.getByText(`${name} · Member`)).toBeVisible();

  // Suspension locks them out at once, with a clear message at sign-in.
  await personAction(page, name, "Suspend…");
  await page.getByRole("button", { name: "Suspend", exact: true }).click();
  await expect(row.getByText("Suspended", { exact: true })).toBeVisible();

  // The open tab notices at once.
  await expect(resetter.getByRole("heading", { name: "You're signed out" })).toBeVisible();
  await resetter.getByRole("button", { name: "Sign in again" }).click();
  await resetter.getByLabel("Email").fill(email);
  await resetter.getByLabel("Password").fill("a-brand-new-password");
  await resetter.getByRole("button", { name: "Sign in" }).click();
  await expect(resetter.getByRole("alert")).toHaveText(
    "This account is suspended. Ask an admin on this server.",
  );

  await personAction(page, name, "Unsuspend");
  await expect(row.getByText("Suspended", { exact: true })).toHaveCount(0);

  await personAction(page, name, "Remove from server…");
  await expect(page.getByRole("dialog")).toContainText("playlists, likes, listening history");
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row).toHaveCount(0);
});

test("nobody can change the owner, and the owner can't change themselves", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/people");

  const owner = page.getByRole("listitem").filter({ hasText: "(you)" });

  await expect(owner.getByText("Owner", { exact: true })).toBeVisible();
  await expect(owner.getByRole("button", { name: /^Actions for/ })).toHaveCount(0);
});

test("an admin shares a library with specific people, then opens it to everyone again", async ({
  page,
  browser,
}) => {
  await signIn(page);

  const name = unique("Mateo");
  const member = await join(browser, await createInvite(page, "Member"), freshEmail("mem"), name);

  await expect(member.getByText("Recently added", { exact: true }).first()).toBeVisible();

  await page.goto("/settings/libraries");

  const card = page.getByRole("region", { name: "/music" });
  const renamed = unique("House");

  try {
    await card.getByRole("button", { name: /^Who can listen to \/music/ }).click();

    const dialog = page.getByRole("dialog", { name: "Who can listen" });

    await dialog.getByRole("button", { name: "Specific people" }).click();
    await expect(dialog.getByText("Only the people below")).toBeVisible();

    // Restricted, without the member: their home empties without a reload.
    await expect(member.getByText("No library folder is shared with you yet")).toBeVisible();

    await dialog.getByRole("button", { name: "Add someone" }).click();
    await page.getByRole("menuitem", { name: new RegExp(name) }).click();
    await expect(dialog.getByRole("list", { name: "People who can listen" })).toContainText(name);
    await expect(member.getByText("Recently added", { exact: true }).first()).toBeVisible();

    await dialog.getByRole("button", { name: `Remove ${name}` }).click();
    await expect(member.getByText("No library folder is shared with you yet")).toBeVisible();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(card.getByRole("button", { name: /Specific people/ })).toBeVisible();

    await card.getByRole("button", { name: "More actions for /music" }).click();
    await page.getByRole("menuitem", { name: "Rename…" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill(renamed);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(card.getByText(renamed)).toBeVisible();
  } finally {
    // The other specs expect /music shared with everyone under its usual name.
    await page.keyboard.press("Escape");
    await card.getByRole("button", { name: /^Who can listen to \/music/ }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Everyone" }).click();
    await expect(page.getByRole("dialog").getByText("Everyone on the server")).toBeVisible();
    await page.getByRole("button", { name: "Done" }).click();
    await expect(card.getByRole("button", { name: /^Who can listen.*: Everyone$/ })).toBeVisible();

    if (!(await card.getByText("Music", { exact: true }).isVisible())) {
      await card.getByRole("button", { name: "More actions for /music" }).click();
      await page.getByRole("menuitem", { name: "Rename…" }).click();
      await page.getByRole("textbox", { name: "Name" }).fill("Music");
      await page.getByRole("button", { name: "Save" }).click();
      await expect(card.getByText("Music", { exact: true })).toBeVisible();
    }
  }

  await expect(member.getByText("Recently added", { exact: true }).first()).toBeVisible();
});

// https://github.com/lmdevv/music/pull/27#discussion_r4274008577: the access dialog read the
// access list of a library the viewer can't manage, whose not_found took the screen down.
test("an admin sees another admin's private library read-only, and the screen stays up", async ({
  page,
  browser,
}) => {
  await signIn(page);

  const folder = unique("vault").replace(" ", "-");
  const admin = await join(browser, await createInvite(page, "Admin"), freshEmail("adm"), "Ada");

  await page.goto("/settings/libraries?add=1");
  await page.getByRole("textbox", { name: "Library folder" }).fill(`/${folder}`);
  await page.getByRole("button", { name: "Only me" }).click();
  // The server's owner manages every library, so nobody else can rename or rescan this one.
  await expect(page.getByText("Only you.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Add and scan" }).click();

  const own = page.getByRole("region", { name: `/${folder}` });

  await expect(own).toBeVisible();

  try {
    await admin.goto("/settings/libraries");

    // Listed by name, without its folder, actions, or access list.
    const theirs = admin.getByRole("region", { name: folder });

    await expect(theirs).toBeVisible();
    await expect(theirs.getByRole("button", { name: /^More actions/ })).toHaveCount(0);
    await expect(theirs.getByRole("button", { name: "Rescan" })).toHaveCount(0);

    await theirs.getByRole("button", { name: new RegExp(`^Who can listen to ${folder}`) }).click();

    const dialog = admin.getByRole("dialog", { name: "Who can listen" });

    await expect(dialog.getByText(/can change who listens to this folder/)).toBeVisible();
    // It offers nothing the admin can't do here.
    await expect(
      dialog.getByText(/Only the server's owner manages a library you can't hear/),
    ).toBeVisible();
    await expect(dialog.getByText(/rename|rescan|remove/)).toHaveCount(0);
    await expect(dialog.getByRole("list", { name: "People who can listen" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Done" }).click();

    await expect(admin.getByText("This screen didn't load")).toHaveCount(0);
    await expect(admin.getByRole("heading", { name: "Libraries" })).toBeVisible();
  } finally {
    await own.getByRole("button", { name: `More actions for /${folder}` }).click();
    await page.getByRole("menuitem", { name: "Remove from [music]…" }).click();
    await page.getByRole("button", { name: "Remove folder" }).click();
    await expect(own).toHaveCount(0);
  }
});
