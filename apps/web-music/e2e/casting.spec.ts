/**
 * Chromecast from `/music` against the real media server. Google's Cast SDK is replaced by a
 * scripted fake (`cast-fake.ts`), so the app's loader, the receiver credential the media server
 * lends for each song, Connect's reports, and the receiver's commands run for real; the test plays
 * the receiver, which fetches what it is told to play.
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { isReceiverCredential } from "@media/contracts/cast";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";

import { audioSeconds, watchMedia } from "./audio";
import { advanceReceiver, castFake, installCastFake, receiver } from "./cast-fake";
import { FIRST_SONG, startMediaService, writeMusicLibrary } from "./media-service";
import type { MediaService } from "./media-service";
import {
  NO_STACK,
  addHouseholdLibrary,
  createPerson,
  reachableStack,
  signIn,
  signInClient,
} from "./people";
import type { Person } from "./people";

const run = promisify(execFile);

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

/** Long enough to pause, seek, and move inside one song. */
const SONG_SECONDS = 180;

/** An MP3 every Chromecast decodes, which casts as its original file. */
const MP3_SONG = "Third Tone";

let media: MediaService | undefined;

let album = "";

let person: Person;

interface OpenBrowser {
  readonly context: BrowserContext;
  readonly page: Page;
}

const browsers: Array<OpenBrowser> = [];

test.beforeAll(async () => {
  if (stack === null) return;

  const library = await writeMusicLibrary(SONG_SECONDS);
  const [artist = ""] = await readdir(library.root);
  const folder = join(library.root, artist, library.album);

  await run(process.env["FFMPEG_PATH"] ?? "ffmpeg", [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=550:sample_rate=44100:duration=${String(SONG_SECONDS)}`,
    "-metadata",
    `title=${MP3_SONG}`,
    "-metadata",
    `artist=${artist}`,
    "-metadata",
    `album_artist=${artist}`,
    "-metadata",
    `album=${library.album}`,
    "-metadata",
    "track=3",
    join(folder, `03 ${MP3_SONG}.mp3`),
  ]);

  album = library.album;
  media = await startMediaService(stack, library.root);
  await addHouseholdLibrary(stack, library.root);
  person = await createPerson(stack, "aiko", "member");
});

test.afterAll(async () => {
  await Promise.all(browsers.map(({ context }) => context.close()));
  await media?.stop();
});

/** A browser of its own, one device, with the person signed in at `/music/`. */
const openBrowser = async (
  browser: Browser,
  baseURL: string | undefined,
  { cast }: { readonly cast: boolean },
): Promise<Page> => {
  const context = await browser.newContext(baseURL === undefined ? {} : { baseURL });
  const page = await context.newPage();

  if (cast) await installCastFake(page);
  await watchMedia(page);
  await signIn(page, person);
  await page.goto("/music/");
  browsers.push({ context, page });

  return page;
};

const playSong = async (page: Page, title: string): Promise<void> => {
  await page.goto("/music/albums");
  await page.getByRole("link", { name: album }).first().click();
  await expect(page.getByRole("heading", { name: album })).toBeVisible();
  await page
    .getByRole("main")
    .getByRole("row", { name: new RegExp(title, "u") })
    .dblclick();
  await expect.poll(() => audioSeconds(page), { timeout: 30_000 }).toBeGreaterThan(1);
};

const playerOf = (page: Page) => page.getByRole("region", { name: "Player" });

/** Opens "Play on" and connects to the fake Chromecast. */
const castToTv = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Play on another device" }).click();
  await page.getByRole("menuitem", { name: /Chromecast/u }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Playing on Living Room TV" }),
  ).toBeVisible();
  await expect.poll(async () => (await receiver(page)).playerState).toBe("PLAYING");
};

/** The ticket parameter of a URL the receiver was given or fetched. */
const credentialOf = (url: string): string => new URL(url).searchParams.get("ticket") ?? "";

let laptop: Page;

test("a Chromecast shows in Play on, and casting moves the song here to the TV with a receiver credential", async ({
  browser,
  baseURL,
}) => {
  laptop = await openBrowser(browser, baseURL, { cast: true });
  await playSong(laptop, FIRST_SONG);
  await castFake(laptop, "devicesAppear");

  const before = await audioSeconds(laptop);

  await castToTv(laptop);

  const [load] = (await receiver(laptop)).loads;

  // A FLAC song: a codec not every Chromecast plays casts as the AAC transcode.
  expect(load).toMatchObject({
    contentType: "audio/mp4",
    streamType: "BUFFERED",
    title: FIRST_SONG,
    autoplay: true,
  });
  expect(load?.artist).not.toBeNull();
  expect(load?.contentId).toMatch(
    /\/media\/music\/stream\/[\w-]+\?ticket=r1\.[\w-]{43}&p=aac-320$/u,
  );
  expect(isReceiverCredential(credentialOf(load?.contentId ?? ""))).toBe(true);
  expect(load?.currentTime).toBeGreaterThanOrEqual(Math.floor(before));
  await expect
    .poll(async () => (await receiver(laptop)).fetches.map(({ status }) => status), {
      timeout: 30_000,
    })
    .toEqual([expect.any(Number)]);
  expect((await receiver(laptop)).fetches[0]?.status).toBeLessThan(300);
  // The browser let go of its own sound.
  await expect.poll(() => audioSeconds(laptop)).toBe(0);
  await laptop.screenshot({ path: test.info().outputPath("cast-music.png") });
});

test("another of the person's browsers lists the cast, and its pause reaches the TV", async ({
  browser,
  baseURL,
}) => {
  const desk = await openBrowser(browser, baseURL, { cast: false });

  await expect(desk.getByRole("status").filter({ hasText: "Playing on" })).toBeVisible({
    timeout: 15_000,
  });
  await desk.getByRole("button", { name: "Play on another device" }).click();
  await expect(
    desk.getByRole("menuitemradio").filter({ hasText: "Casting to Living Room TV" }),
  ).toBeVisible();
  await desk.screenshot({ path: test.info().outputPath("cast-device-list.png") });
  await desk.keyboard.press("Escape");

  await playerOf(desk).getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => (await receiver(laptop)).isPaused).toBe(true);
  await desk.screenshot({ path: test.info().outputPath("connect-pause.png") });

  await playerOf(desk).getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await receiver(laptop)).isPaused).toBe(false);
  // The rest is this browser's alone: a Jam would play on every page of the person's (ADR 0017).
  await desk.context().close();
});

test("ending the cast brings the song back to the browser where the TV was", async () => {
  await advanceReceiver(laptop, 40);
  await castFake(laptop, "disconnect");
  await expect(
    laptop.getByRole("status").filter({ hasText: "Playing on Living Room TV" }),
  ).toHaveCount(0);
  await expect.poll(() => audioSeconds(laptop), { timeout: 30_000 }).toBeGreaterThan(40);
  expect(await audioSeconds(laptop)).toBeLessThan(50);
});

test("a Jam plays here: starting one ends the cast, and Play on offers no Chromecast in it", async () => {
  // Old music had no casting, so neither has a Jam (ADR 0018).
  await castFake(laptop, "devicesAppear");
  await castToTv(laptop);
  await playerOf(laptop).getByRole("button", { name: "Queue", exact: true }).click();
  await laptop
    .getByRole("complementary", { name: "Queue" })
    .getByRole("button", { name: "Start a Jam" })
    .click();
  await laptop
    .getByRole("dialog", { name: "Start a Jam" })
    .getByRole("button", { name: "Start a Jam" })
    .click();
  await expect(laptop.getByRole("dialog", { name: "Your Jam" })).toBeVisible();
  await laptop.keyboard.press("Escape");

  await expect.poll(async () => (await receiver(laptop)).castState).toBe("NOT_CONNECTED");
  await expect(
    laptop.getByRole("status").filter({ hasText: "Playing on Living Room TV" }),
  ).toHaveCount(0);
  await expect.poll(() => audioSeconds(laptop), { timeout: 30_000 }).toBeGreaterThan(0);

  await laptop.getByRole("button", { name: "Play on another device" }).click();
  await expect(laptop.getByRole("menuitemradio", { name: /This browser/u })).toBeVisible();
  await expect(laptop.getByRole("menuitem", { name: /Chromecast/u })).toHaveCount(0);
  await laptop.keyboard.press("Escape");

  await laptop.getByRole("status", { name: "Jam" }).getByRole("button", { name: "Manage" }).click();
  await laptop
    .getByRole("dialog", { name: "Your Jam" })
    .getByRole("button", { name: "End Jam" })
    .click();
  await expect(laptop.getByRole("dialog", { name: "Your Jam" })).toHaveCount(0);
});

test("an MP3 every Chromecast decodes casts as its original file", async () => {
  await playSong(laptop, MP3_SONG);
  await castFake(laptop, "devicesAppear");
  await castToTv(laptop);

  const load = (await receiver(laptop)).loads.at(-1);

  expect(load).toMatchObject({ contentType: "audio/mpeg", title: MP3_SONG });
  expect(load?.contentId).toMatch(/\?ticket=r1\.[\w-]{43}&p=original$/u);
  await expect
    .poll(async () => (await receiver(laptop)).fetches.at(-1)?.status, { timeout: 30_000 })
    .toBe(206);
});

test("signing out mid-cast ends the receiver's stream", async () => {
  if (stack === null) return;

  const fetched = (await receiver(laptop)).fetches.at(-1)?.url ?? "";

  expect(isReceiverCredential(credentialOf(fetched))).toBe(true);

  // The browser's own sign-in ends, as signing it out from another of the person's devices does.
  const platform = await signInClient(stack, person);

  try {
    const sessions = await platform.core.auth.sessions.list({
      paginationOpts: { numItems: 50, cursor: null },
    });

    await Promise.all(
      sessions.page
        .filter((each) => !each.current)
        .map((each) => platform.core.auth.sessions.end({ sessionId: each.sessionId })),
    );
  } finally {
    await platform.dispose();
  }

  await expect
    .poll(
      async () => {
        const answer = await fetch(fetched, { headers: { range: "bytes=0-1023" } });

        await answer.body?.cancel();

        return answer.status;
      },
      { timeout: 30_000 },
    )
    .toBe(410);
});
