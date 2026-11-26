import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Milliseconds } from "@media/contracts/units";
import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";

import { createLibrary, removeLibrary, titlesByName } from "../stack/libraries";
import type { LibraryId, TitleId } from "../stack/libraries";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import {
  NO_STACK,
  createPerson,
  moviesPath,
  reachableStack,
  signInClient,
  signedInPage,
} from "../stack/people";
import type { Client } from "../stack/people";
import {
  HAVE_CURRENT_DATA,
  encodeClip,
  episodeNfo,
  expectPlayingPast,
  movieNfo,
  offline,
  revealControls,
  showNfo,
  videoState,
  writeText,
} from "./playback-stack";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

const SETUP_TIMEOUT_MS = 240_000;

/** Members of a session stay within a quarter second of each other. */
const IN_STEP_MS = 250;

const run = Date.now().toString(36);

const MOVIE = "Harbor Lights";

const SHOW = "Ferry Crossings";

const EPISODES = ["First Crossing", "Second Crossing"] as const;

const EPISODE_SECONDS = 20;

let workspace = "";

let media: MediaService | undefined;

let host: Client;

const libraries: Array<LibraryId> = [];

const titles = new Map<string, TitleId>();

const pages: Array<Page> = [];

const titleId = (name: string): TitleId => {
  const id = titles.get(name);

  if (id === undefined) throw new Error(`No title named ${name}`);

  return id;
};

/** Where each page's video stands at one instant, playing ones carried to the latest reading. */
const positionsNow = async (watching: ReadonlyArray<Page>): Promise<ReadonlyArray<number>> => {
  const readings = await Promise.all(watching.map((page) => videoState(page)));
  const latest = Math.max(...readings.map((reading) => reading.at));

  return readings.map(
    (reading) => reading.currentTime * 1000 + (reading.paused ? 0 : latest - reading.at),
  );
};

const spreadNow = async (watching: ReadonlyArray<Page>): Promise<number> => {
  const positions = await positionsNow(watching);

  return Math.max(...positions) - Math.min(...positions);
};

/** The spread between the pages at `count` readings half a second apart. */
const spreadsOver = async (
  watching: ReadonlyArray<Page>,
  count: number,
  taken: ReadonlyArray<number> = [],
): Promise<ReadonlyArray<number>> => {
  if (count === 0) return taken;

  const spread = await spreadNow(watching);

  await watching[0]?.waitForTimeout(500);

  return spreadsOver(watching, count - 1, [...taken, spread]);
};

/** Waits until every page stays within `IN_STEP_MS` of the others for three readings in a row. */
const expectInStep = async (watching: ReadonlyArray<Page>, timeout = 20_000): Promise<void> => {
  let inRow = 0;

  await expect
    .poll(
      async () => {
        inRow = (await spreadNow(watching)) < IN_STEP_MS ? inRow + 1 : 0;

        return inRow;
      },
      { timeout, intervals: [250] },
    )
    .toBeGreaterThanOrEqual(3);
};

const member = async (browser: Browser, label: string): Promise<Page> => {
  if (stack === null) throw new Error(NO_STACK);

  const page = await signedInPage(browser, await createPerson(stack, label));

  pages.push(page);

  return page;
};

const startSession = async (page: Page): Promise<string> => {
  await revealControls(page);
  await page.getByRole("button", { name: "Watch together" }).click();

  const link = page.getByLabel("Session link");

  await expect(link).toContainText("/together#mt_");

  const address = (await link.textContent()) ?? "";

  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();

  const opened = new URL(address);

  return `${opened.pathname}${opened.hash}`;
};

const delayFirstEpisodeLookup = async (page: Page): Promise<() => boolean> => {
  let delayed = false;

  await page.routeWebSocket("**/api/*/sync", (socket) => {
    const server = socket.connectToServer();
    let sending = Promise.resolve();

    socket.onMessage((message) => {
      sending = sending.then(async () => {
        if (!delayed && message.includes('"udfPath":"movies/titles:episode"')) {
          delayed = true;
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        }

        return server.send(message);
      });
    });
  });

  return () => delayed;
};

/**
 * Holds each `core.together.heartbeat` the page sends, the clock samples its player's follower
 * takes as it starts included, until the returned function sends them on; other frames pass.
 */
const holdHeartbeats = async (page: Page): Promise<() => void> => {
  const held: Array<() => void> = [];
  let holding = true;

  await page.routeWebSocket("**/api/*/sync", (socket) => {
    const server = socket.connectToServer();

    socket.onMessage((message) => {
      if (holding && message.includes('"udfPath":"core/together:heartbeat"')) {
        held.push(() => {
          server.send(message);
        });
      } else {
        server.send(message);
      }
    });
  });

  return () => {
    holding = false;
    held.splice(0).forEach((send) => {
      send();
    });
  };
};

/** The status of the host's movies session clock, or null while the host is in none. */
const hostClockStatus = async (): Promise<string | null> => {
  const current = await host.platform.core.together.get({ domain: "movies" });

  return current?.state === "joined" ? current.clock.status : null;
};

test.beforeAll(async () => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "media-web-together-"));

  const films = join(workspace, "Films");
  const shows = join(workspace, "Shows");
  const movieFolder = join(films, `${MOVIE} (2022)`);
  const season = join(shows, `${SHOW} (2021)`, "Season 01");

  await Promise.all([
    encodeClip(join(movieFolder, `${MOVIE} (2022).mp4`), {
      seconds: 180,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(movieFolder, "movie.nfo"), movieNfo(MOVIE, 2022)),
    writeText(join(shows, `${SHOW} (2021)`, "tvshow.nfo"), showNfo(SHOW, 2021)),
    ...EPISODES.flatMap((name, index) => {
      const stem = join(season, `${SHOW} - S01E0${String(index + 1)}`);

      return [
        encodeClip(`${stem}.mp4`, {
          seconds: EPISODE_SECONDS,
          video: "h264",
          audio: [{ codec: "aac", language: "eng" }],
        }),
        writeText(`${stem}.nfo`, episodeNfo(1, index + 1, name)),
      ];
    }),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  host = await signInClient(stack, await createPerson(stack, "host"));

  libraries.push(
    await createLibrary(host.platform, { name: `Together films ${run}`, folders: [films] }),
    await createLibrary(host.platform, { name: `Together shows ${run}`, folders: [shows] }),
  );

  await Promise.all(
    libraries.map((libraryId) =>
      host.platform.core.permissions.grants.set({
        resource: { type: "library", id: libraryId },
        principal: { kind: "household" },
        level: "view",
      }),
    ),
  );

  const scanned = await Promise.all(libraries.map((id) => titlesByName(host.platform, id)));

  for (const byName of scanned) byName.forEach((id, name) => titles.set(name, id));
});

test.afterEach(async () => {
  await Promise.all(pages.splice(0).map((page) => page.context().close()));
});

test.afterAll(async () => {
  if (stack === null) return;

  await Promise.all(libraries.map((libraryId) => removeLibrary(host.platform, libraryId)));
  await media?.stop();
  await rm(workspace, { recursive: true, force: true });
});

test("a host and two members watch together in step, and only the host moves the clock", async ({
  browser,
}) => {
  test.setTimeout(180_000);

  const hostPage = await signedInPage(browser, host.person);

  pages.push(hostPage);

  const [aiko, mateo] = await Promise.all([member(browser, "aiko"), member(browser, "mateo")]);

  await hostPage.goto(moviesPath(`/watch/${titleId(MOVIE)}?start=0`));
  await expectPlayingPast(hostPage, 1);

  const link = await startSession(hostPage);

  await Promise.all([aiko.goto(link), mateo.goto(link)]);
  await Promise.all([expectPlayingPast(aiko, 3), expectPlayingPast(mateo, 3)]);
  await expectInStep([hostPage, aiko, mateo]);

  await expect(hostPage.getByRole("region", { name: "Watching together" })).toContainText("aiko");

  // A member without control is refused and stays on the clock.
  await aiko.keyboard.press("Space");
  await expect(aiko.getByText(/can pause or seek/u).first()).toBeVisible();
  await expect.poll(async () => (await videoState(aiko)).paused).toBe(false);
  await aiko.keyboard.press("ArrowRight");
  await expectInStep([hostPage, aiko, mateo]);

  // The host pauses, seeks, and plays for everyone.
  await revealControls(hostPage);
  await hostPage.getByRole("button", { name: "Pause" }).first().click();
  await expect.poll(async () => (await videoState(mateo)).paused).toBe(true);
  await expectInStep([hostPage, aiko, mateo]);

  await hostPage.keyboard.press("ArrowRight");
  await hostPage.keyboard.press("ArrowRight");
  await expectInStep([hostPage, aiko, mateo]);

  await hostPage.keyboard.press("Space");
  await expect.poll(async () => (await videoState(aiko)).paused).toBe(false);
  await expectInStep([hostPage, aiko, mateo]);

  // Ten seconds of watching together stay in step.
  const spreads = await spreadsOver([hostPage, aiko, mateo], 20);

  test.info().annotations.push({
    type: "spread",
    description: `max ${String(Math.round(Math.max(...spreads)))} ms over ${String(spreads.length)} readings`,
  });

  expect(Math.max(...spreads)).toBeLessThan(IN_STEP_MS);

  // A guest leaves; the host ends the session for the other.
  await revealControls(mateo);
  await mateo.getByRole("button", { name: "Leave session" }).click();
  await expect(hostPage.getByRole("region", { name: "Watching together" })).not.toContainText(
    "mateo",
  );

  await hostPage.getByRole("button", { name: "End session" }).click();
  await expect(aiko.getByRole("heading", { name: /ended the session/u })).toBeVisible();
});

test("the session counts down to the next episode and moves every member on together", async ({
  browser,
}) => {
  test.setTimeout(180_000);

  if (stack === null) throw new Error(NO_STACK);

  const guest = await createPerson(stack, "aiko-next");
  const guestClient = await signInClient(stack, guest);
  const hostPage = await signedInPage(browser, host.person);
  const aiko = await signedInPage(browser, guest);

  pages.push(hostPage, aiko);

  const show = titleId(SHOW);

  const episodes = await host.platform.movies.titles.episodes({
    titleId: show,
    seasonNumber: 1,
    paginationOpts: { numItems: 10, cursor: null },
  });

  const [first, second] = episodes.page;

  if (first === undefined || second === undefined) throw new Error("The show has two episodes");

  const delayedLookup = await delayFirstEpisodeLookup(hostPage);
  await hostPage.goto(moviesPath(`/watch/${show}?episodeId=${first.id}&start=0`));
  await expectPlayingPast(hostPage, 0.5);

  const link = await startSession(hostPage);

  expect(delayedLookup()).toBe(true);
  await aiko.goto(link);
  await expectPlayingPast(aiko, 1);
  await expectInStep([hostPage, aiko]);

  await hostPage.getByTestId("player").press("k");
  await expect.poll(async () => (await videoState(aiko)).paused).toBe(true);

  const saved = await guestClient.platform.movies.play.start({
    titleId: show,
    episodeId: first.id,
  });

  await guestClient.platform.movies.play.report({
    fileId: saved.file.id,
    positionMs: Milliseconds.make(12_000),
    event: "pause",
    playbackId: saved.playbackId,
    startedAt: saved.startedAt,
  });

  const resume = await guestClient.platform.movies.play.start({
    titleId: show,
    episodeId: first.id,
  });

  expect(resume.resumePositionMs).toBeGreaterThanOrEqual(10_000);

  const delayedReload = await delayFirstEpisodeLookup(aiko);

  await aiko.reload();
  await expect.poll(delayedReload).toBe(true);
  await expect
    .poll(async () => (await videoState(aiko)).readyState)
    .toBeGreaterThanOrEqual(HAVE_CURRENT_DATA);
  await expectInStep([hostPage, aiko]);
  await hostPage.getByTestId("player").press("k");

  await expect(aiko.getByRole("region", { name: "Next episode" })).toBeVisible({
    timeout: 30_000,
  });
  await expect(hostPage.getByRole("region", { name: "Next episode" })).toBeVisible();

  await Promise.all(
    [hostPage, aiko].map((page) =>
      expect(page).toHaveURL(new RegExp(`episodeId=${second.id}`, "u"), { timeout: 30_000 }),
    ),
  );

  await Promise.all([expectPlayingPast(hostPage, 1), expectPlayingPast(aiko, 1)]);
  await expectInStep([hostPage, aiko]);
});

test("the host's pause pauses the session while its player still samples the server's clock", async ({
  browser,
}) => {
  const hostPage = await signedInPage(browser, host.person);

  pages.push(hostPage);

  const release = await holdHeartbeats(hostPage);

  await hostPage.goto(moviesPath(`/watch/${titleId(MOVIE)}?start=0`));
  await expectPlayingPast(hostPage, 1);
  await startSession(hostPage);
  await expect(hostPage.getByRole("region", { name: "Watching together" })).toBeVisible();
  await expect.poll(hostClockStatus).toBe("playing");

  // The player follows the session once its clock samples are answered; a pause before that still
  // pauses the session.
  await hostPage.getByTestId("player").press("k");
  await expect.poll(hostClockStatus).toBe("paused");

  // Once the samples are answered, the player takes up the clock the pause left.
  release();
  await expect.poll(async () => (await videoState(hostPage)).paused).toBe(true);

  await revealControls(hostPage);
  await hostPage.getByRole("button", { name: "End session" }).click();
  await expect.poll(hostClockStatus).toBeNull();
});
