import { JobId, LibraryId } from "@music/commands/ids";
import { Device, Job, PlaybackState } from "@music/commands/models";
import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";
import { Schema } from "effect";

import {
  ADMIN,
  cli,
  container,
  convexAdmin,
  convexImport,
  cspViolations,
  expectAudioPast,
  isPlayingAudio,
  signIn,
} from "./support";

test.describe.configure({ mode: "serial" });

let apiKey = "";

const decodeDevices = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Device)));

const decodeState = Schema.decodeUnknownSync(Schema.fromJsonString(PlaybackState));

const decodeJob = Schema.decodeUnknownSync(Schema.fromJsonString(Job));

/** A row of `convex data users --format jsonl`. */
const decodeUserRow = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({ _id: Schema.String, email: Schema.optionalKey(Schema.String) }),
  ),
);

/** A row of `convex data devices --format jsonl`. */
const decodeDeviceRow = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ deviceId: Schema.String })),
);

/** The time `days` days ago, in epoch milliseconds. */
const daysAgo = (days: number): number => Date.now() - days * 24 * 60 * 60 * 1000;

/** The JSON rows of `convex data` output. */
const rows = <Row>(decode: (line: string) => Row, output: string): ReadonlyArray<Row> =>
  output
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map(decode);

const decodeCreated = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ libraryId: LibraryId, jobId: JobId })),
);

const openFirstAlbum = async (page: Page): Promise<string> => {
  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Albums" })
    .click();
  const card = page.locator("main a[href^='/albums/']").first();
  await expect(card).toBeVisible();
  const name = (await card.getAttribute("aria-label")) ?? (await card.textContent()) ?? "";
  await card.click();
  await expect(page).toHaveURL(/\/albums\/[^/]+$/);
  // The URL changes before the album page renders, so wait for its heading to replace the list's.
  const heading = page.getByRole("heading", { level: 1 }).first();
  await expect(heading).not.toHaveText("Albums");
  const title = (await heading.textContent()) ?? name;
  expect(title.length).toBeGreaterThan(0);

  return title;
};

test("first run: create the admin, add /music, and the real scanner indexes it", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/setup/);
  await page.getByLabel("Name").fill(ADMIN.name);
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password").fill(ADMIN.password);
  await page.getByRole("button", { name: "Create admin account" }).click();
  await expect(page.getByRole("heading", { name: "Where's your music?" })).toBeVisible();
  await page.getByLabel("Library folder").fill("/music");
  await page.getByRole("button", { name: "Start scanning" }).click();
  await expect(page.getByRole("heading", { name: "Your library is ready" })).toBeVisible({
    timeout: 120_000,
  });
  await page.getByRole("button", { name: "Open my library" }).click();
  await expect(page.getByRole("heading", { name: "Recently added" })).toBeVisible();
  await expect(page.locator("main img").first()).toBeVisible();
});

test("an album plays real audio, pauses, and skips", async ({ page }) => {
  await signIn(page);
  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();

  const bar = page.getByRole("region", { name: "Player" });
  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expectAudioPast(page, 2);

  await bar.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(bar.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect.poll(() => isPlayingAudio(page)).toBe(false);

  await bar.getByRole("button", { name: "Play", exact: true }).click();
  await expectAudioPast(page, 1);
  const before = await page.locator("[role=row][aria-current=true]").first().textContent();
  await bar.getByRole("button", { name: "Next", exact: true }).click();
  await expect
    .poll(() => page.locator("[role=row][aria-current=true]").first().textContent())
    .not.toBe(before);
  await expectAudioPast(page, 1);
});

test("Ctrl+N and Ctrl+P move through the command menu", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("ControlOrMeta+k");
  const menu = page.getByRole("dialog", { name: "Command menu" });
  // With no query, a "Now playing" row can arrive after the first row was selected, and the
  // selection stays put. A query selects its first result once the search settles; wait for that
  // result, or Ctrl+N can land on the list from before the query.
  const options = menu.getByRole("option");
  const third = await options.nth(2).boundingBox();

  if (third === null) throw new Error("The command menu has fewer than three rows");
  const rest = { x: third.x + third.width / 2, y: third.y + third.height / 2 };
  // The mouse rests over the list. Chromium reports rows moving under a resting pointer as a
  // move to the same spot, which must not take the row the keyboard picked.
  await page.mouse.move(rest.x, rest.y);

  const press = async (key: string): Promise<void> => {
    await page.keyboard.press(key);
    await page.mouse.move(rest.x, rest.y);
  };

  await menu.getByRole("combobox").fill("queue");
  await expect(options.first()).toHaveId("command-open-queue");
  await expect(options.first()).toHaveAttribute("aria-selected", "true");

  await press("Control+n");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await press("Control+n");
  await expect(options.nth(2)).toHaveAttribute("aria-selected", "true");
  await press("Control+p");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
});

test("search finds songs from the scanned library", async ({ page }) => {
  await signIn(page);
  const album = await openFirstAlbum(page);
  await page.keyboard.press("/");
  await expect(page).toHaveURL(/\/search/);
  const word = album.split(" ")[0] ?? album;
  await page.locator("#search-input").fill(word);
  await expect(page.getByText("Top result")).toBeVisible();
});

test("search ignores accents and shows the original title", async ({ page }) => {
  await signIn(page);
  await page.goto("/search");
  await page.locator("#search-input").fill("doppelganger");
  const top = page.locator("section", { has: page.getByRole("heading", { name: "Top result" }) });
  await expect(top.getByText("Doppelgänger", { exact: true })).toBeVisible();
});

test("an API key drives the CLI, and the CLI controls the browser's playback", async ({ page }) => {
  await signIn(page);
  await page.goto("/settings/keys");
  await page.getByRole("button", { name: "New key" }).click();
  await page.getByLabel("Name").fill("stack e2e");
  await page.getByRole("button", { name: "Create key" }).click();
  apiKey = (await page.getByTestId("new-api-key").textContent())?.trim() ?? "";
  expect(apiKey).toMatch(/^mk_/);
  await page.getByRole("button", { name: "Done" }).click();

  expect(cli(apiKey, ["whoami"])).toContain(ADMIN.email);

  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expectAudioPast(page, 1);

  cli(apiKey, ["pause"]);
  const bar = page.getByRole("region", { name: "Player" });
  await expect(bar.getByRole("button", { name: "Play", exact: true })).toBeVisible();
  await expect.poll(() => isPlayingAudio(page)).toBe(false);

  cli(apiKey, ["resume"]);
  await expect(bar.getByRole("button", { name: "Pause", exact: true })).toBeVisible();
  await expectAudioPast(page, 1);
});

test("playback moves to a second browser and the first one stops", async ({ page, browser }) => {
  await signIn(page);
  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expectAudioPast(page, 2);

  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await other.newPage();
  await signIn(phone);
  await expect(phone.getByRole("button", { name: /Open Now Playing/ })).toBeVisible();

  const devices = decodeDevices(cli(apiKey, ["devices", "list", "--json"]));
  const state = decodeState(cli(apiKey, ["now", "--json"]));

  const target = devices.find((device) => device.online && device.id !== state.activeDevice?.id);
  expect(target).toBeDefined();
  cli(apiKey, ["playback", "transfer", target?.id ?? ""]);

  await expect.poll(() => isPlayingAudio(page)).toBe(false);
  await expectAudioPast(phone, 1);
  await expect(page.getByText(/Playing on /).first()).toBeVisible();
  await other.close();
});

test("the app runs under its Content-Security-Policy and security headers", async ({ page }) => {
  const response = await page.request.get("/");
  const headers = response.headers();

  expect(headers["content-security-policy"]).toContain("script-src 'self';");
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["x-frame-options"]).toBe("DENY");

  await signIn(page);
  await expect(page.locator("main img").first()).toBeVisible();
  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expectAudioPast(page, 1);
  await page.keyboard.press("/");
  await page.locator("#search-input").fill("a");
  await expect(page.getByText("Top result")).toBeVisible();

  expect(await cspViolations(page)).toEqual([]);
});

test("a numeric search and the Add folder dialog keep their screens", async ({ page }) => {
  await signIn(page);
  await page.goto("/search");
  await page.locator("#search-input").fill("1999");
  await expect(page).toHaveURL(/q=1999/);
  await expect(page.getByRole("heading", { name: "Not in your library" })).toBeVisible();

  await page.goto("/settings/libraries");
  await page.getByRole("button", { name: "Add folder" }).click();
  await expect(page).toHaveURL(/add=1/);
  await expect(page.getByRole("textbox", { name: "Library folder" })).toBeFocused();
});

test("playlists: create with N, add from a song's menu, remove, rename, and delete", async ({
  page,
}) => {
  const errors: Array<string> = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await signIn(page);
  await openFirstAlbum(page);

  // The name field has focus when the dialog opens, so typing and Enter create the playlist.
  await page.keyboard.press("n");
  await expect(page.getByRole("dialog", { name: "New playlist" })).toBeVisible();
  await page.keyboard.type("Road trip");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/playlists\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "Road trip" })).toBeVisible();

  await page.goBack();
  const row = page.locator("main [role=row]").nth(1);
  const title = (await row.locator("[role=cell]").nth(1).textContent())?.trim() ?? "";
  await row.hover();
  await row.getByRole("button", { name: `More actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Add to playlist" }).click();
  await page.getByRole("menuitem", { name: "Road trip" }).click();
  await expect(page.getByText("Added to Road trip")).toBeVisible();

  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: /Road trip/ })
    .click();
  const added = page.locator("main [role=row]").filter({ hasText: title });
  await expect(added).toBeVisible();
  await added.hover();
  await added.getByRole("button", { name: `More actions for ${title}` }).click();
  await page.getByRole("menuitem", { name: "Remove from this playlist" }).click();
  await expect(page.getByText("Let's find something for this playlist")).toBeVisible();

  await page.getByRole("button", { name: "More actions for Road trip" }).click();
  await page.getByRole("menuitem", { name: "Rename…" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Night drive");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { level: 1, name: "Night drive" })).toBeVisible();

  await page.getByRole("button", { name: "More actions for Night drive" }).click();
  await page.getByRole("menuitem", { name: "Delete playlist…" }).click();
  await page.getByRole("button", { name: "Delete playlist" }).click();
  await expect(page).toHaveURL(/\/playlists$/);
  await expect(page.getByText("Deleted Night drive")).toBeVisible();
  await expect(page.getByRole("link", { name: /Night drive/ })).toHaveCount(0);
  expect(errors.filter((text) => text.includes("Playlist not found"))).toEqual([]);
});

test("home and artists show each artist's art", async ({ page }) => {
  await signIn(page);

  const recent = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Recently played artists" }),
  });

  const circles = recent.locator("a[href^='/artists/']");

  await expect(circles.first()).toBeVisible();
  await expect(recent.locator("a[href^='/artists/'] img")).toHaveCount(await circles.count());

  await page
    .getByRole("navigation", { name: "Library" })
    .getByRole("link", { name: "Artists" })
    .click();

  const artists = page.locator("main a[href^='/artists/']");

  await expect(artists.first()).toBeVisible();
  await expect(page.locator("main a[href^='/artists/'] img")).toHaveCount(await artists.count());
});

test("a phone shows where the music plays while another device plays it", async ({
  page,
  browser,
}) => {
  await signIn(page);
  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expectAudioPast(page, 1);

  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await other.newPage();

  await signIn(phone);

  const mini = phone.getByRole("button", { name: /Open Now Playing: .+, playing on / });

  await expect(mini).toBeVisible();
  await expect(mini.getByText(/^Playing on /)).toBeVisible();
  expect(await isPlayingAudio(phone)).toBe(false);

  await mini.click();
  await expect(phone.getByRole("status").filter({ hasText: /^Playing on / })).toBeVisible();
  await other.close();
});

test("the seek and volume sliders are named and work from the keyboard", async ({ page }) => {
  await signIn(page);
  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expectAudioPast(page, 1);

  const bar = page.getByRole("region", { name: "Player" });
  const seek = bar.getByRole("slider", { name: "Seek" });
  const volume = bar.getByRole("slider", { name: "Volume" });

  await expect(seek).toBeVisible();
  await volume.focus();

  const before = Number(await volume.getAttribute("aria-valuenow"));

  await page.keyboard.press("ArrowLeft");
  await expect
    .poll(async () => Number(await volume.getAttribute("aria-valuenow")))
    .toBeLessThan(before);
});

test("the song menu's Q, Shift+Enter, and L keys do what the menu shows", async ({ page }) => {
  await signIn(page);
  await openFirstAlbum(page);

  // The first song row (any library has one); its menu button names the song.
  const row = page
    .locator("main [role=row]")
    .filter({ has: page.getByRole("button", { name: /^More actions for / }) })
    .first();

  const menu = row.getByRole("button", { name: /^More actions for / });
  await row.hover();
  const label = (await menu.getAttribute("aria-label")) ?? "";
  const title = label.replace(/^More actions for /, "");
  expect(title.length).toBeGreaterThan(0);

  // Keys reach the menu once it has focus, as after any click.
  const openMenu = async (): Promise<void> => {
    await row.hover();
    await menu.click();
    await expect(page.getByRole("menu")).toBeFocused();
  };

  await openMenu();
  await page.keyboard.press("q");
  await expect(page.getByText(`Added ${title} to the queue`)).toBeVisible();
  await expect(page.getByRole("menu")).toBeHidden();

  await openMenu();
  await page.keyboard.press("Shift+Enter");
  await expect(page.getByText(`${title} plays next`)).toBeVisible();

  await openMenu();
  await page.keyboard.press("l");
  await expect(page.getByText(`Liked ${title}`)).toBeVisible();
  await page.goto("/liked");
  await expect(page.locator("main [role=row]").filter({ hasText: title })).toBeVisible();
});

test("phone queue keeps the transport on screen and the device list fits", async ({ browser }) => {
  for (let index = 0; index < 12; index += 1) {
    cli(apiKey, [
      "devices",
      "heartbeat",
      "--device-id",
      `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      "--name",
      `Old laptop ${index}`,
      "--kind",
      "web",
    ]);
  }

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await context.newPage();

  await signIn(phone);
  await phone.goto("/albums");
  await phone.locator("main a[href^='/albums/']").first().click();
  await phone.getByRole("button", { name: "Play", exact: true }).first().click();
  await expectAudioPast(phone, 1);
  await phone.getByRole("button", { name: /Open Now Playing/ }).click();
  await phone.getByRole("button", { name: "Queue", exact: true }).click();

  const fits = async (name: RegExp | string): Promise<boolean> => {
    const box = await phone.getByRole("button", { name, exact: true }).last().boundingBox();

    return box !== null && box.y >= 0 && box.y + box.height <= 844;
  };

  await expect.poll(() => fits("Next")).toBe(true);
  await expect.poll(() => fits("Hide queue")).toBe(true);

  await phone.getByRole("button", { name: /Play on another device/ }).click();

  const list = phone.getByRole("menu", { name: "Play on" });

  await expect(list.getByRole("menuitemradio", { name: /Old laptop 11/ })).toBeAttached();

  // The sheet slides in; poll until it settles.
  await expect
    .poll(async () => {
      const box = await list.boundingBox();

      return box !== null && box.y + box.height <= 844;
    })
    .toBe(true);
  await context.close();
});

test("Esc closes the desktop queue panel", async ({ page }) => {
  await signIn(page);
  await openFirstAlbum(page);
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await page.getByRole("region", { name: "Player" }).getByRole("button", { name: "Queue" }).click();
  await expect(page.getByRole("complementary", { name: "Queue" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("complementary", { name: "Queue" })).toBeHidden();
});

test("the sign-in screen shows the release version", async ({ page }) => {
  // Every package carries the release version; the CLI prints its own.
  const version = cli(apiKey, ["--version"]).trim();

  expect(version).toMatch(/^\d+\.\d+\.\d+/);

  await page.goto("/sign-in");
  await expect(page.getByText(`· V${version}`)).toBeVisible();
});

test("album cards and song rows expose their play buttons", async ({ page }) => {
  await signIn(page);
  await page.goto("/albums");
  const card = page.locator("main a[href^='/albums/']").first();
  const album = (await card.locator("span").first().textContent())?.trim() ?? "";

  await card.hover();
  await page.getByRole("button", { name: `Play ${album}`, exact: true }).click();
  await expect(
    page
      .getByRole("region", { name: "Player" })
      .getByRole("button", { name: "Pause", exact: true }),
  ).toBeVisible();

  await page.goto("/songs");

  const row = page
    .locator("main [role=row]")
    .filter({ has: page.getByRole("button", { name: /^More actions for / }) })
    .first();

  // No hover: role queries skip display:none, so finding it proves screen readers can, and
  // focusing it and pressing Enter is how a keyboard plays the song.
  const play = row.getByRole("button", { name: /^Play / });

  await expect(play).toHaveCount(1);
  await play.focus();
  await page.keyboard.press("Enter");
  await expect(row).toHaveAttribute("aria-current", "true");
});

test("the last song in the queue stops at its end instead of starting over", async ({ page }) => {
  // Its waits (audio start, reaching the end, and a stopped window past one report) can add up
  // to more than the default 120 seconds on a slow machine.
  test.setTimeout(180_000);
  cli(apiKey, ["playback", "shuffle", "--no-on"]);
  cli(apiKey, ["playback", "repeat", "off"]);

  await signIn(page);
  await openFirstAlbum(page);

  const last = page
    .locator("main [role=row]")
    .filter({ has: page.getByRole("button", { name: /^More actions for / }) })
    .last();

  const label =
    (await last.getByRole("button", { name: /^More actions for / }).getAttribute("aria-label")) ??
    "";

  const title = label.replace(/^More actions for /, "");

  await last.hover();
  await last.getByRole("button", { name: `Play ${title}`, exact: true }).click();
  await expectAudioPast(page, 1);

  const playing = decodeState(cli(apiKey, ["now", "--json"]));
  const durationMs = playing.queue[playing.index]?.durationMs ?? 0;

  expect(playing.index).toBe(playing.queue.length - 1);
  cli(apiKey, ["playback", "seek", "--position-ms", String(Math.max(0, durationMs - 3000))]);

  // The song reaches its end and playback stops there.
  await expect
    .poll(() => decodeState(cli(apiKey, ["now", "--json"])).playing, { timeout: 60_000 })
    .toBe(false);

  // The player reports its position every 15 seconds; a report that still says "playing" would
  // restart the song, so it must stay stopped past one.
  const stoppedAt = Date.now();

  await expect
    .poll(
      async () =>
        Date.now() - stoppedAt > 17_000 &&
        !(await isPlayingAudio(page)) &&
        !decodeState(cli(apiKey, ["now", "--json"])).playing,
      { timeout: 30_000, intervals: [1000] },
    )
    .toBe(true);
  await expect(
    page.getByRole("region", { name: "Player" }).getByRole("button", { name: "Play", exact: true }),
  ).toBeVisible();
});

test("the command menu rescans the only library folder with Enter", async ({ page }) => {
  await signIn(page);
  await page.keyboard.press("Control+k");
  await page.getByRole("combobox").fill("Rescan a library folder");

  const menu = page.getByRole("dialog");

  // The only folder is already picked, so Enter runs the command.
  await expect(
    menu.getByRole("option", { name: /^Rescan a library folder/, selected: true }),
  ).toBeVisible();
  await expect(menu.getByRole("option", { name: /^\/music/, selected: true })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(menu.getByText("Scanning /music", { exact: true })).toBeVisible();
  await expect(menu.getByRole("alert")).toHaveCount(0);
});

test("adding a folder that doesn't exist shows the failed scan and keeps open lists working", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/albums");
  await expect(page.locator("main a[href^='/albums/']").first()).toBeVisible();

  const created = decodeCreated(
    cli(apiKey, ["libraries", "create", "--name", "Nowhere", "--path", "/nowhere", "--json"]),
  );

  try {
    await expect
      .poll(() => decodeJob(cli(apiKey, ["jobs", "get", created.jobId, "--json"])).status)
      .toBe("failed");

    // Every open list re-ran with the new folder in your libraries; none may fail.
    await expect(page.getByText("This screen didn't load")).toHaveCount(0);
    await expect(page.locator("main a[href^='/albums/']").first()).toBeVisible();

    await page.goto("/settings/libraries");
    const card = page.getByRole("region", { name: "/nowhere" });
    await expect(card.getByText("Scan failed")).toBeVisible();
    await expect(card.getByText(/unavailable/)).toBeVisible();
  } finally {
    // A failed cleanup must not hide the assertion that failed first; report it instead.
    try {
      cli(apiKey, ["libraries", "delete", created.libraryId]);
    } catch (cause) {
      console.warn(`Could not remove the /nowhere library ${created.libraryId}`, cause);
    }
  }
});

test("phone forms keep their buttons on screen", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const phone = await context.newPage();

  const onScreen = async (name: string): Promise<boolean> => {
    const box = await phone.getByRole("button", { name, exact: true }).boundingBox();

    return box !== null && box.x >= 0 && box.x + box.width <= 390;
  };

  await signIn(phone);
  await phone.goto("/songs");
  await expect.poll(() => onScreen("Shuffle all")).toBe(true);
  await phone.goto("/settings/account");
  await expect.poll(() => onScreen("Save")).toBe(true);
  await context.close();
});

test("devices silent for a day leave Play on, and the daily prune deletes old ones", async ({
  page,
}) => {
  test.skip(container() === "", "needs MUSIC_CONTAINER, which scripts/stack-e2e.sh sets");

  const admin = rows(decodeUserRow, convexAdmin(["data", "users", "--format", "jsonl"])).find(
    (user) => user.email === ADMIN.email,
  );

  if (admin === undefined) throw new Error(`No user row for ${ADMIN.email}`);

  const closed = { deviceId: "00000000-0000-4000-9000-000000000001", name: "Closed tab" };
  const ancient = { deviceId: "00000000-0000-4000-9000-000000000002", name: "Ancient laptop" };
  const speaker = { deviceId: "00000000-0000-4000-9000-000000000003", name: "Paused speaker" };

  // Heartbeats always record the current time, so the long-silent devices are imported.
  convexImport("devices", [
    { ...closed, userId: admin._id, kind: "web", lastSeenAt: daysAgo(2) },
    { ...ancient, userId: admin._id, kind: "web", lastSeenAt: daysAgo(40) },
    { ...speaker, userId: admin._id, kind: "web", lastSeenAt: daysAgo(40) },
  ]);

  // A paused session stays on the speaker, which keeps it listed and kept however old it is.
  cli(apiKey, ["playback", "pause"]);
  cli(apiKey, ["playback", "transfer", speaker.deviceId]);

  const names = (args: ReadonlyArray<string> = []): ReadonlyArray<string> =>
    decodeDevices(cli(apiKey, ["devices", "list", ...args, "--json"])).map((device) => device.name);

  expect(names()).toContain(speaker.name);
  expect(names()).not.toContain(closed.name);
  expect(names()).not.toContain(ancient.name);
  // The device asking is listed however long it was silent.
  expect(names(["--device-id", closed.deviceId])).toContain(closed.name);

  await signIn(page);
  await page.getByRole("button", { name: /Play on another device/ }).click();

  const list = page.getByRole("menu", { name: "Play on" });

  await expect(list.getByRole("menuitemradio", { name: /Paused speaker/ })).toBeVisible();
  await expect(list.getByRole("menuitemradio", { name: /Closed tab|Ancient laptop/ })).toHaveCount(
    0,
  );

  convexAdmin(["run", "maintenance:pruneStaleDevices", "{}"]);

  const kept = rows(
    decodeDeviceRow,
    convexAdmin(["data", "devices", "--format", "jsonl", "--limit", "1000"]),
  ).map((device) => device.deviceId);

  expect(kept).toContain(speaker.deviceId);
  expect(kept).toContain(closed.deviceId);
  expect(kept).not.toContain(ancient.deviceId);
});

test("data saver plays through HTML audio, starts a first play at once, and seeks", async ({
  page,
}) => {
  await signIn(page);
  await page.goto("/settings/playback");

  const dataSaver = page
    .getByRole("radiogroup", { name: "Streaming quality" })
    .getByRole("radio", { name: "Data saver" });

  await dataSaver.click();
  await expect(dataSaver).toHaveAttribute("aria-checked", "true");
  await openFirstAlbum(page);

  /**
   * Where in the song the playing data saver stream is, in seconds, or -1 while none plays. A
   * stream opened part-way (`&start=<ms>`) starts its own time at that offset.
   */
  const dataSaverAt = (): Promise<number> =>
    page.evaluate(() =>
      Math.max(
        -1,
        ...[...(window.musicTestMedia ?? [])].flatMap((element) =>
          !element.paused && element.src.includes("p=aac-128")
            ? [
                element.currentTime +
                  Number(new URL(element.src).searchParams.get("start") ?? "0") / 1000,
              ]
            : [],
        ),
      ),
    );

  // No song has played at 128 kbps yet, so this one is transcoded as it plays.
  const tappedAt = Date.now();
  await page.getByRole("button", { name: "Play", exact: true }).first().click();
  await expect.poll(dataSaverAt, { intervals: [50] }).toBeGreaterThan(0.02);
  const firstAudioMs = Date.now() - tappedAt;

  console.log(`data saver first play: audio after ${firstAudioMs} ms`);
  expect(firstAudioMs).toBeLessThan(3000);

  const bar = page.getByRole("region", { name: "Player" });
  await bar.getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(() => isPlayingAudio(page)).toBe(false);
  cli(apiKey, ["playback", "seek", "--position-ms", "3000"]);
  await expect.poll(() => decodeState(cli(apiKey, ["now", "--json"])).positionMs).toBe(3000);

  // Playing on from where it paused would take more than two seconds to get there.
  const resumedAt = Date.now();
  await bar.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(dataSaverAt, { intervals: [50] }).toBeGreaterThanOrEqual(3);
  expect(Date.now() - resumedAt).toBeLessThan(2000);
});
