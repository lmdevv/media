import { expect, test } from "@playwright/test";

import { Schema } from "effect";

import { ADMIN, joinAsNewMember, seed, seedDevice, signIn, unique } from "./support";

/** Any other fields, kept so a rewritten message still says everything the server sent. */
const Rest = [Schema.Record(Schema.String, Schema.Unknown)] as const;

/** One query change in a Convex sync-protocol message. */
const QueryChange = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    queryId: Schema.optionalKey(Schema.Finite),
    args: Schema.optionalKey(Schema.Unknown),
  }),
  Rest,
);

/** The parts of a Convex sync-protocol message the retry test reads. */
const SocketMessage = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    modifications: Schema.optionalKey(Schema.Array(QueryChange)),
  }),
  Rest,
);

const decodeSocketMessage = Schema.decodeUnknownSync(Schema.fromJsonString(SocketMessage));

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  // Idempotent: ensures the admin, the /music library, and its songs.
  seed();
});

test("a wrong password shows the sign-in error and logs nothing", async ({ page }) => {
  const errors: Array<string> = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Invalid email or password");
  await expect(page.getByLabel("Password")).toHaveAttribute("aria-invalid", "true");
  // A wrong password is an expected outcome, not a server error (ADS-109).
  expect(errors).toEqual([]);
});

test("Play on opens with nothing loaded, and never pops up by itself later", async ({
  page: admin,
  browser,
}) => {
  // A new member has never played anything, so the desktop player bar and its speaker are absent.
  const page = await joinAsNewMember(admin, browser);
  const bar = page.getByRole("region", { name: "Player" });
  const popover = page.getByText(/DEVICES? ONLINE/);
  const dialog = page.getByRole("dialog", { name: "Play on" });

  await expect(bar).toHaveCount(0);
  await page.keyboard.press("d");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("menuitemradio").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Albums" })
    .click();
  await page.getByRole("link", { name: "Moon Safari" }).first().click();
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(popover).toHaveCount(0);
  await expect(dialog).toHaveCount(0);

  await page.keyboard.press("d");
  await expect(popover).toBeVisible();
  await page.keyboard.press("Escape");
  await bar.getByRole("button", { name: "Pause", exact: true }).click();
  await page.context().close();
});

test("Play on opens while the media service is unreachable", async ({ page }) => {
  // This browser can't reach the media service, which is when moving playback elsewhere matters.
  await page.route(/\/media\/(health|stream)/, (route) => route.abort());
  await signIn(page);
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Albums" })
    .click();
  await page.getByRole("link", { name: "Dummy" }).first().click();
  await page.getByRole("button", { name: "Play", exact: true }).first().click();

  const bar = page.getByRole("region", { name: "Player" });

  await expect(bar.getByText("Playback is unavailable", { exact: false })).toBeVisible();
  await page.keyboard.press("d");
  await expect(page.getByText(/DEVICES? ONLINE/)).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Open the command menu" }).click();
  await page.keyboard.type("play on another device");
  await page
    .getByRole("dialog", { name: "Command menu" })
    .getByRole("option", { name: /Play on another device/ })
    .click();
  await expect(page.getByText(/DEVICES? ONLINE/)).toBeVisible();
  await page.keyboard.press("Escape");
});

test("browse to an album and press play", async ({ page }) => {
  await signIn(page);
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Albums" })
    .click();
  await page.getByRole("link", { name: "Blue Lines" }).first().click();
  await expect(page.getByRole("heading", { name: "Blue Lines" }).first()).toBeVisible();

  await page.getByRole("button", { name: "Play", exact: true }).first().click();

  const bar = page.getByRole("region", { name: "Player" });
  await expect(bar.getByRole("button", { name: "Safe From Harm", exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expect(page.locator("[role=row][aria-current=true]").first()).toContainText(
    "Safe From Harm",
  );

  await bar.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(bar.getByRole("button", { name: "Play", exact: true })).toBeVisible();
});

test("search shows results while typing and a no-results state", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("/");
  await expect(page).toHaveURL(/\/search/);

  await page.locator("#search-input").fill("portis");
  await expect(page.getByText("Top result")).toBeVisible();
  await expect(page.getByText("Portishead", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Glory Box").first()).toBeVisible();

  await page.locator("#search-input").fill("zzqxv nothing here");
  await expect(page.getByRole("heading", { name: "Not in your library" })).toBeVisible();
});

test("create a playlist and add a song to it", async ({ page }) => {
  const name = unique("Rainy Sunday");

  await signIn(page);
  await page.getByRole("button", { name: "New playlist" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { name }).first()).toBeVisible();
  await expect(page.getByText("Let's find something for this playlist")).toBeVisible();

  await page.getByLabel("Search your library to add songs").fill("teardrop");
  await page.getByRole("button", { name: "Add" }).first().click();
  await expect(page.getByText(`Added to ${name}`)).toBeVisible();
  await expect(page.getByRole("table", { name: `Songs in ${name}` })).toContainText("Teardrop");

  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Albums" })
    .click();
  await page.getByRole("link", { name: "Dummy" }).first().click();
  await page.getByRole("row").filter({ hasText: "Glory Box" }).hover();
  await page.getByRole("button", { name: "More actions for Glory Box" }).last().click();
  await page.getByRole("menuitem", { name: "Add to playlist" }).hover();
  await page.getByRole("menuitem", { name }).click();
  // The toast from the first add can still be on screen with the same text, so take the newest.
  await expect(page.getByText(`Added to ${name}`).last()).toBeVisible();

  await page.getByRole("navigation", { name: "Library" }).getByRole("link", { name }).click();
  await expect(page.getByRole("table", { name: `Songs in ${name}` })).toContainText("Glory Box");
});

test("a playlist deleted in another session shows that, and the player keeps going", async ({
  page,
  browser,
}) => {
  const name = unique("Doomed");

  await signIn(page);
  await page.goto("/albums");
  await page.getByRole("link", { name: "Blue Lines" }).first().click();
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  const bar = page.getByRole("region", { name: "Player" });
  await expect(bar.getByRole("button", { name: "Safe From Harm", exact: true })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "New playlist" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();

  const other = await browser.newContext();
  const elsewhere = await other.newPage();
  await signIn(elsewhere);
  await elsewhere.getByRole("navigation", { name: "Library" }).getByRole("link", { name }).click();
  await elsewhere.getByRole("button", { name: `More actions for ${name}` }).click();
  await elsewhere.getByRole("menuitem", { name: "Delete playlist…" }).click();
  await elsewhere.getByRole("button", { name: "Delete playlist" }).click();
  await expect(elsewhere).toHaveURL(/\/playlists$/);
  await other.close();

  await expect(page.getByRole("heading", { name: "This playlist was deleted" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Library" })).toBeVisible();
  await expect(bar.getByRole("button", { name: "Safe From Harm", exact: true })).toBeVisible();
  // The stand-in streams a tone, so the song is still playing; the stack suite checks real audio.
  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Back to playlists" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Playlists" })).toBeVisible();
  await bar.getByRole("button", { name: "Pause", exact: true }).click();
});

test("links to missing screens show a not-found state inside the app", async ({ page }) => {
  await signIn(page);

  await page.goto("/albums/not-an-album");
  await expect(
    page.getByRole("heading", { name: "This album isn't in your library anymore" }),
  ).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Library" })).toBeVisible();
  await page.getByRole("link", { name: "Back to albums" }).click();
  await expect(page).toHaveURL(/\/albums$/);

  await page.goto("/nowhere/at-all");
  await expect(page.getByRole("heading", { name: "There's nothing here" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Library" })).toBeVisible();
  await page.getByRole("link", { name: "Go to Home" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("Try again subscribes again after a screen's data failed to load", async ({ page }) => {
  // Fails the album screen's results on the Convex socket, as a server error would, until the
  // test lets them through. The boundary also resets when the route's match changes, so failing
  // only the first result could let the screen recover before "Try again" is pressed.
  const albumQueries = new Set<number>();
  let failing = true;

  await page.routeWebSocket(/\/api\/.*\/sync/, (socket) => {
    const server = socket.connectToServer();

    socket.onMessage((message) => {
      const text = String(message);
      const sent = decodeSocketMessage(text);

      for (const change of sent.modifications ?? []) {
        if (
          change.type === "Add" &&
          change.queryId !== undefined &&
          JSON.stringify(change.args).includes("albums.get")
        ) {
          albumQueries.add(change.queryId);
        }
      }

      server.send(text);
    });
    server.onMessage((message) => {
      const text = String(message);
      const received = decodeSocketMessage(text);

      const target = (received.modifications ?? []).find(
        (change) =>
          change.type === "QueryUpdated" &&
          change.queryId !== undefined &&
          albumQueries.has(change.queryId),
      );

      if (!failing || received.type !== "Transition" || target === undefined) {
        socket.send(text);

        return;
      }

      socket.send(
        JSON.stringify({
          ...received,
          modifications: (received.modifications ?? []).map((change) =>
            change === target
              ? {
                  type: "QueryFailed",
                  queryId: change.queryId,
                  errorMessage: "[Request ID: e2e] Server Error",
                  logLines: [],
                  journal: null,
                }
              : change,
          ),
        }),
      );
    });
  });

  await signIn(page);
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Albums" })
    .click();
  await page.getByRole("link", { name: "Blue Lines" }).first().click();
  await expect(page.getByRole("heading", { name: "This screen didn't load" })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Library" })).toBeVisible();

  failing = false;
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Blue Lines" }).first()).toBeVisible();
});

test("removing a queue row from the keyboard keeps focus in the queue", async ({ page }) => {
  await signIn(page);
  await page.goto("/albums");
  await page.getByRole("link", { name: "Mezzanine" }).first().click();
  await page.getByRole("button", { name: "Play", exact: true }).first().click();

  const bar = page.getByRole("region", { name: "Player" });

  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await bar.getByRole("button", { name: "Queue" }).click();

  const remove = page
    .getByRole("complementary", { name: "Queue" })
    .getByRole("button", { name: /^Remove .* from the queue$/ });

  const second = (await remove.nth(1).getAttribute("aria-label")) ?? "";

  await remove.first().focus();
  await page.keyboard.press("Enter");
  // ADS-107: focus moves to the row that took the removed one's place, not to the page.
  await expect(page.getByRole("button", { name: second, exact: true })).toBeFocused();
  await bar.getByRole("button", { name: "Pause", exact: true }).click();
});

test("removing a row in the Now Playing queue keeps focus there, and Play on opens above it", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/albums");
  await page.getByRole("link", { name: "Mezzanine" }).first().click();
  await page.getByRole("button", { name: "Play", exact: true }).first().click();

  const bar = page.getByRole("region", { name: "Player" });

  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await bar.getByRole("button", { name: "Open Now Playing" }).click();

  const nowPlaying = page.getByRole("dialog", { name: "Now Playing" });

  await nowPlaying.getByRole("button", { name: "Queue", exact: true }).first().click();

  const remove = nowPlaying.getByRole("button", { name: /^Remove .* from the queue$/ });
  const second = (await remove.nth(1).getAttribute("aria-label")) ?? "";

  await remove.first().focus();
  await page.keyboard.press("Enter");
  // The dialog takes focus when the removed button unmounts; focus still moves to the next row.
  await expect(nowPlaying.getByRole("button", { name: second, exact: true })).toBeFocused();

  // The player bar's speaker is under Now Playing, so Play on opens as a dialog above it.
  await page.keyboard.press("d");
  await expect(page.getByRole("dialog", { name: "Play on" })).toBeVisible();
  await expect(page.getByText(/DEVICES? ONLINE/)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await bar.getByRole("button", { name: "Pause", exact: true }).click();
});

test("the phone Now Playing opens the one shared Play on sheet", async ({ browser }) => {
  const phone = await browser.newContext({ hasTouch: true });
  const page = await phone.newPage();

  // Sign in at desktop width (the helper waits for the sidebar), then use the phone layout.
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /^Open Now Playing/ }).click();
  await page.getByRole("button", { name: /^Play on another device\. Now:/ }).click();
  await expect(page.getByRole("dialog", { name: "Play on" })).toHaveCount(1);
  await page.keyboard.press("d");
  await expect(page.getByRole("dialog", { name: "Play on" })).toHaveCount(0);
  await page.keyboard.press("d");

  const sheet = page.getByRole("dialog", { name: "Play on" });

  await expect(sheet).toHaveCount(1);
  // A tap inside the sheet is not an outside press for Now Playing underneath, which stays open.
  await sheet.getByRole("menuitemradio").nth(1).tap();
  await page.keyboard.press("Escape");
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Now Playing" })).toBeVisible();
  await phone.close();
});

test("like a song and find it in Liked songs", async ({ page }) => {
  await signIn(page);
  await page.goto("/albums");
  await page.getByRole("link", { name: "Moon Safari" }).first().click();

  const row = page.getByRole("row").filter({ hasText: "Sexy Boy" });
  await row.hover();

  const heart = row.getByRole("button", { name: /like Sexy Boy/i });
  const liked = (await heart.getAttribute("aria-pressed")) === "true";

  if (liked) {
    await heart.click();
    await expect(heart).toHaveAttribute("aria-pressed", "false");
  }

  await heart.click();
  await expect(heart).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByText("Liked Sexy Boy")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Liked songs" })
    .click();
  await expect(page.getByRole("table", { name: "Liked songs" })).toContainText("Sexy Boy");
});

test("create an API key that is shown once, then revoke it", async ({ page }) => {
  const name = unique("e2e agent");

  await signIn(page);
  await page.goto("/settings/keys");
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByLabel("Name").fill(name);
  await page.getByRole("button", { name: "Create key" }).click();
  await expect(page.getByRole("heading", { name: "Copy your new key" })).toBeVisible();
  await expect(page.getByTestId("new-api-key")).not.toBeEmpty();
  await page.getByRole("button", { name: "Done" }).click();

  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "Revoke" }).click();
  await page.getByRole("button", { name: "Revoke key" }).click();
  await expect(page.getByText(`Revoked ${name}`)).toBeVisible();
  await expect(row).toHaveCount(0);
});

test("the command menu runs a registry command with arguments", async ({ page }) => {
  await signIn(page);
  await page.goto("/albums");
  await page.getByRole("link", { name: "Blue Lines" }).first().click();
  await page.getByRole("button", { name: "Play", exact: true }).first().click();

  const shuffle = page
    .getByRole("region", { name: "Player" })
    .getByRole("button", { name: "Shuffle", exact: true });
  // Play starts the album in order, so shuffle is off.

  await expect(shuffle).toHaveAttribute("aria-pressed", "false");

  await page.keyboard.press("ControlOrMeta+k");
  const menu = page.getByRole("dialog", { name: "Command menu" });
  await expect(menu).toBeVisible();
  await page.keyboard.type("shuffle on or off");
  await menu.getByRole("option", { name: /Turn shuffle on or off/ }).click();
  await expect(menu.getByRole("heading", { name: "Turn shuffle on or off" })).toBeVisible();
  await expect(menu.getByText("music playback shuffle").first()).toBeVisible();
  await menu.getByRole("button", { name: "Run" }).click();

  await expect(menu).toBeHidden();
  await expect(shuffle).toHaveAttribute("aria-pressed", "true");
});

test("an admin invites someone who joins with the link", async ({ page, browser }) => {
  await signIn(page);
  await page.goto("/settings/people");
  await page.getByRole("button", { name: "Invite" }).click();
  await page.getByRole("button", { name: "Create invite" }).click();

  const link = await page.getByTestId("invite-link").textContent();
  expect(link).toContain("/invite/");

  const guest = await browser.newContext();
  const visitor = await guest.newPage();
  await visitor.goto(link ?? "");
  await expect(visitor.getByRole("heading", { name: /invited you/ })).toBeVisible();
  await visitor.getByLabel("Email").fill(`${unique("guest").replace(" ", "-")}@music.local`);
  await visitor.getByLabel("Your name").fill("Mateo");
  await visitor.getByLabel("Choose a password").fill("password123");
  await visitor.getByRole("button", { name: "Join" }).click();
  await expect(visitor.getByRole("navigation", { name: "Library" })).toBeVisible();

  await visitor.goto(link ?? "");
  await expect(visitor).toHaveURL(/\/$/);
  await guest.close();
});

test("remote control mode shows where music plays and controls it", async ({ page }) => {
  await signIn(page);
  await page.goto("/albums");
  await page.getByRole("link", { name: "Blue Lines" }).first().click();
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expect(
    page
      .getByRole("region", { name: "Player" })
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();

  // Another signed-in device takes over playback.
  seedDevice("Lucía's iPhone");

  await expect(
    page.getByRole("status").filter({ hasText: "Playing on Lucía's iPhone" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Play on another device" }).click();
  await expect(page.getByRole("menuitemradio", { name: /Lucía's iPhone/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("Escape");

  const bar = page.getByRole("region", { name: "Player" });
  await bar.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(bar.getByRole("button", { name: "Play", exact: true })).toBeVisible();
});
