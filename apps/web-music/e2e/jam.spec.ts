import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";

import { FIRST_SONG, SECOND_SONG, startMediaService, writeMusicLibrary } from "./media-service";
import type { MediaService } from "./media-service";
import { NO_STACK, createPerson, reachableStack, signIn, signInClient } from "./people";
import type { Person } from "./people";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

declare global {
  interface Window {
    musicJamMedia?: Set<HTMLMediaElement>;
  }
}

/** Collects every media element the page plays, for `audioAt`. */
const watchMedia = async (page: Page): Promise<void> => {
  await page.addInitScript({
    content: `
      window.musicJamMedia = new Set();
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        window.musicJamMedia.add(this);
        return play.call(this);
      };
    `,
  });
};

/** Where the page's playing audio stands, in seconds, and when, on the machine's clock. */
const audioAt = (page: Page): Promise<{ readonly seconds: number; readonly at: number }> =>
  page.evaluate(() => ({
    seconds: Math.max(
      0,
      ...[...(window.musicJamMedia ?? [])].map((media) => (media.paused ? 0 : media.currentTime)),
    ),
    at: Date.now(),
  }));

/** How far apart two pages play, in seconds, as of the same moment. */
const apart = async (one: Page, other: Page): Promise<number> => {
  const [a, b] = await Promise.all([audioAt(one), audioAt(other)]);

  return Math.abs(a.seconds - (b.seconds + (a.at - b.at) / 1000));
};

let media: MediaService | undefined;

let album = "";

test.beforeAll(async () => {
  if (stack === null) return;

  const library = await writeMusicLibrary();

  album = library.album;
  media = await startMediaService(stack, library.root);

  const admin = await createPerson(stack, "jam-admin", "admin");
  const platform = await signInClient(stack, admin);

  try {
    const { libraryId } = await platform.core.libraries.create({
      name: `Jam music ${admin.username}`,
      kind: "music",
      folders: [library.root],
    });

    await platform.core.permissions.grants.set({
      resource: { type: "library", id: libraryId },
      principal: { kind: "household" },
      level: "view",
    });

    await expect
      .poll(async () => (await platform.core.libraries.get({ libraryId })).scan?.status, {
        timeout: 60_000,
      })
      .toBe("succeeded");
  } finally {
    await platform.dispose();
  }
});

test.afterAll(async () => {
  await media?.stop();
});

/** A page of its own for `person`, signed in, that records what it plays. */
const pageFor = async (browser: Browser, baseURL: string | undefined, person: Person) => {
  const context = await browser.newContext(baseURL === undefined ? {} : { baseURL });
  const page = await context.newPage();

  await watchMedia(page);
  await signIn(page, person);

  return { page, close: () => context.close() };
};

/** Plays the fixture album from its first song, then starts a Jam from it and answers its link. */
const startJam = async (page: Page): Promise<string> => {
  await page.goto("/music/albums");
  await page.getByRole("link", { name: album }).first().click();
  await page
    .getByRole("main")
    .getByRole("row", { name: new RegExp(FIRST_SONG, "u") })
    .dblclick();

  return startJamFromPlayer(page);
};

/** Starts a Jam from the song the page's player shows, with its queue, and answers its link. */
const startJamFromPlayer = async (page: Page): Promise<string> => {
  await expect(page.getByRole("region", { name: "Player" }).getByText(FIRST_SONG)).toBeVisible();

  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await page
    .getByRole("complementary", { name: "Queue" })
    .getByRole("button", { name: "Start a Jam" })
    .click();

  const panel = page.getByRole("dialog", { name: "Start a Jam" });

  await panel.getByRole("button", { name: "Start a Jam" }).click();

  const link = page.getByRole("dialog", { name: "Your Jam" }).getByTestId("jam-link");

  await expect(link).toHaveValue(/\/music\/jam#mt_/u);

  const value = await link.inputValue();

  // The panel is modal: the player bar behind it answers only once it closes.
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Your Jam" })).toHaveCount(0);

  return value;
};

/** The host's Jam panel, opened from the Jam band. */
const openJam = async (page: Page) => {
  await page.getByRole("status", { name: "Jam" }).getByRole("button", { name: "Manage" }).click();

  return page.getByRole("dialog", { name: "Your Jam" });
};

test("two members join a Jam by its link, play in step, add, reorder, and move on together", async ({
  browser,
  baseURL,
}) => {
  if (stack === null) return;

  const [hostPerson, aikoPerson, mateoPerson] = await Promise.all([
    createPerson(stack, "lucia", "member"),
    createPerson(stack, "aiko", "member"),
    createPerson(stack, "mateo", "member"),
  ]);

  const host = await pageFor(browser, baseURL, hostPerson);
  const aiko = await pageFor(browser, baseURL, aikoPerson);
  const mateo = await pageFor(browser, baseURL, mateoPerson);

  try {
    const link = await startJam(host.page);

    // Members follow while they join, so the session pauses first: queue changes land before
    // the songs, six seconds each, move on.
    const hostPlayer = host.page.getByRole("region", { name: "Player" });

    await hostPlayer.getByRole("button", { name: "Pause", exact: true }).click();

    await Promise.all(
      [aiko, mateo].map(async (member) => {
        await member.page.goto(link);
        await expect(member.page.getByRole("status", { name: "Jam" })).toContainText(
          `${hostPerson.username}'s Jam`,
        );
        await expect(
          member.page.getByRole("region", { name: "Player" }).getByText(FIRST_SONG),
        ).toBeVisible();
      }),
    );

    const panel = await openJam(host.page);

    await expect(panel.getByRole("list", { name: "People in the Jam" })).toContainText(
      aikoPerson.username,
    );

    // The host lets people add; Aiko queues the first song again, after the second.
    await panel.getByRole("switch", { name: "People can add songs" }).click();
    await host.page.keyboard.press("Escape");

    await aiko.page.getByRole("link", { name: "Albums" }).first().click();
    await aiko.page.getByRole("link", { name: album }).first().click();
    await aiko.page
      .getByRole("button", { name: `More actions for ${FIRST_SONG}` })
      .first()
      .click();
    await aiko.page.getByRole("menuitem", { name: "Add to queue" }).click();
    await expect(aiko.page.getByText(`Added ${FIRST_SONG} to the queue`)).toBeVisible();

    const hostQueue = host.page.getByRole("complementary", { name: "Queue" });

    await expect(hostQueue.getByText(`Added by ${aikoPerson.username}`)).toBeVisible();

    // The host moves Aiko's entry to the front: every member sees the new order.
    await hostQueue.getByRole("button", { name: `Move ${FIRST_SONG}`, exact: true }).focus();
    await host.page.keyboard.press("ArrowUp");

    await mateo.page.getByRole("button", { name: "Queue", exact: true }).click();

    // The panel's first row is the song playing; what plays next follows it.
    const mateoNext = (at: number) =>
      mateo.page
        .getByRole("complementary", { name: "Queue" })
        .getByTestId("queue-row")
        .nth(at + 1);

    await expect(mateoNext(0)).toContainText(FIRST_SONG);
    await expect(mateoNext(0)).toContainText(`Added by ${aikoPerson.username}`);
    await expect(mateoNext(1)).toContainText(SECOND_SONG);

    // Played on, every member hears the song in step and moves on to the queued one together.
    await hostPlayer.getByRole("button", { name: "Play", exact: true }).click();

    await Promise.all(
      [aiko, mateo].map((member) =>
        expect
          .poll(async () => (await audioAt(member.page)).seconds, { timeout: 30_000 })
          .toBeGreaterThan(1),
      ),
    );

    await expect.poll(() => apart(aiko.page, mateo.page), { timeout: 15_000 }).toBeLessThan(0.25);
    await expect.poll(() => apart(host.page, aiko.page), { timeout: 15_000 }).toBeLessThan(0.25);

    // Aiko's song plays now: only the second song is still to come.
    await expect(mateoNext(0)).toContainText(SECOND_SONG, { timeout: 30_000 });

    await Promise.all(
      [host, aiko, mateo].map((member) =>
        expect
          .poll(async () => (await audioAt(member.page)).seconds, { timeout: 30_000 })
          .toBeGreaterThan(0.5),
      ),
    );

    await expect.poll(() => apart(aiko.page, mateo.page), { timeout: 15_000 }).toBeLessThan(0.25);

    // Paused, the host plays a song from the album now: it plays for everyone, as old jams' host
    // played a list.
    await hostPlayer.getByRole("button", { name: "Pause", exact: true }).click();
    await Promise.all(
      [aiko, mateo].map((member) =>
        expect.poll(async () => (await audioAt(member.page)).seconds, { timeout: 15_000 }).toBe(0),
      ),
    );
    await host.page
      .getByRole("main")
      .getByRole("row", { name: new RegExp(SECOND_SONG, "u") })
      .dblclick();
    await Promise.all(
      [host, aiko, mateo].map((member) =>
        expect
          .poll(async () => (await audioAt(member.page)).seconds, { timeout: 30_000 })
          .toBeGreaterThan(0.5),
      ),
    );
  } finally {
    await Promise.all([host.close(), aiko.close(), mateo.close()]);
  }
});

test("an approval Jam holds a member until the host lets her in, and refuses her adds while adding is off", async ({
  browser,
  baseURL,
}) => {
  if (stack === null) return;

  const [hostPerson, guestPerson] = await Promise.all([
    createPerson(stack, "host", "member"),
    createPerson(stack, "waiting", "member"),
  ]);

  const host = await pageFor(browser, baseURL, hostPerson);
  const guest = await pageFor(browser, baseURL, guestPerson);

  try {
    const link = await startJam(host.page);
    const panel = await openJam(host.page);

    await panel.getByRole("radio", { name: "You approve" }).click();

    await guest.page.goto(link);
    await expect(guest.page.getByRole("status", { name: "Jam" })).toContainText(
      `Waiting to join ${hostPerson.username}'s Jam`,
    );

    const waiting = panel.getByRole("list", { name: "Waiting to join" });

    await expect(waiting).toContainText(guestPerson.username);
    await waiting.getByRole("button", { name: "Let in" }).click();

    await expect(guest.page.getByRole("status", { name: "Jam" })).toContainText(
      `${hostPerson.username}'s Jam`,
    );

    await guest.page.getByRole("link", { name: "Albums" }).first().click();
    await guest.page.getByRole("link", { name: album }).first().click();
    await guest.page
      .getByRole("button", { name: `More actions for ${SECOND_SONG}` })
      .first()
      .click();
    await guest.page.getByRole("menuitem", { name: "Add to queue" }).click();
    await expect(
      guest.page.getByText("The host turned off adding songs in this Jam"),
    ).toBeVisible();
  } finally {
    await Promise.all([host.close(), guest.close()]);
  }
});

test("a locked Jam turns a new member away", async ({ browser, baseURL }) => {
  if (stack === null) return;

  const [hostPerson, guestPerson] = await Promise.all([
    createPerson(stack, "locker", "member"),
    createPerson(stack, "late", "member"),
  ]);

  const host = await pageFor(browser, baseURL, hostPerson);
  const guest = await pageFor(browser, baseURL, guestPerson);

  try {
    const link = await startJam(host.page);
    const panel = await openJam(host.page);

    await panel.getByRole("radio", { name: "Locked" }).click();
    await guest.page.goto(link);
    await expect(guest.page.getByRole("heading", { name: "This Jam is locked" })).toBeVisible();
    await expect(guest.page.getByRole("status", { name: "Jam" })).toHaveCount(0);
  } finally {
    await Promise.all([host.close(), guest.close()]);
  }
});

test("a Jam started from a long queue holds all of it, page after page, and a member takes out their own at its end", async ({
  browser,
  baseURL,
}) => {
  if (stack === null) return;

  const [hostPerson, aikoPerson] = await Promise.all([
    createPerson(stack, "long", "member"),
    createPerson(stack, "aiko", "member"),
  ]);

  const platform = await signInClient(stack, hostPerson);

  try {
    const albums = await platform.music.albums.list({
      paginationOpts: { numItems: 100, cursor: null },
    });

    const found = albums.page.find((card) => card.title === album);

    if (found === undefined) throw new Error(`no album ${album}`);

    const tracks = await platform.music.albums.tracks({
      albumId: found.id,
      paginationOpts: { numItems: 100, cursor: null },
    });

    const [first, second] = tracks.page;

    if (first === undefined || second === undefined) throw new Error("the album has two songs");

    // The host's own queue: 300 songs, more than two of the core's pages of a Jam's queue for a
    // person in no group, which hold 140 entries each.
    await platform.music.queue.play({
      trackIds: Array.from({ length: 300 }, (_, at) => (at % 2 === 0 ? first.id : second.id)),
    });
  } finally {
    await platform.dispose();
  }

  const host = await pageFor(browser, baseURL, hostPerson);
  const aiko = await pageFor(browser, baseURL, aikoPerson);

  try {
    // Starting the Jam fills it with the 299 songs after the first, a call's worth at a time.
    await host.page.goto("/music/");

    const link = await startJamFromPlayer(host.page);
    const panel = await openJam(host.page);

    await panel.getByRole("switch", { name: "People can add songs" }).click();
    await host.page.keyboard.press("Escape");

    await aiko.page.goto(link);
    await expect(aiko.page.getByRole("status", { name: "Jam" })).toContainText(
      `${hostPerson.username}'s Jam`,
    );

    await aiko.page.getByRole("button", { name: "Queue", exact: true }).click();

    const rows = aiko.page.getByRole("complementary", { name: "Queue" }).getByTestId("queue-row");

    // The song playing, then every song the host had queued after it.
    await expect(rows).toHaveCount(300, { timeout: 30_000 });

    await aiko.page.getByRole("link", { name: "Albums" }).first().click();
    await aiko.page.getByRole("link", { name: album }).first().click();
    await aiko.page
      .getByRole("button", { name: `More actions for ${FIRST_SONG}` })
      .first()
      .click();
    await aiko.page.getByRole("menuitem", { name: "Add to queue" }).click();
    await expect(aiko.page.getByText(`Added ${FIRST_SONG} to the queue`)).toBeVisible();
    await expect(rows).toHaveCount(301);

    const last = rows.last();

    await last.scrollIntoViewIfNeeded();
    await expect(last).toContainText(`Added by ${aikoPerson.username}`);
    await last.hover();
    await last.getByRole("button", { name: `Remove ${FIRST_SONG} from the queue` }).click();

    await expect(rows).toHaveCount(300);
    await expect(rows.last()).toContainText(`Added by ${hostPerson.username}`);
  } finally {
    await Promise.all([host.close(), aiko.close()]);
  }
});
