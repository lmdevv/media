/**
 * Chromecast against the real media server. Google's Cast SDK is replaced by a
 * scripted fake (`cast-fake.ts`) installed in the browser, so the app's loader, its negotiation
 * for the device, the receiver credential the media server lends, and its commands run for real;
 * the test plays the receiver, which fetches what it is told to play.
 */
import { join } from "node:path";

import { isReceiverCredential } from "@media/contracts/cast";
import { MEDIA_ROUTES } from "@media/contracts/media-playback";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page, Request } from "@playwright/test";

import { createLibrary, removeLibrary, titlesByName } from "../stack/libraries";
import type { LibraryId, TitleId } from "../stack/libraries";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import {
  NO_STACK,
  createPerson,
  moviesPath,
  reachableStack,
  signIn,
  signInClient,
} from "../stack/people";
import type { Client } from "../stack/people";
import { advanceReceiver, castFake, installCastFake, receiver } from "./cast-fake";
import type { FakeReceiver } from "./cast-fake";
import {
  capture,
  clickScrubber,
  encodeClip,
  expectPlayingPast,
  expectPositionNear,
  makeWorkspace,
  movieNfo,
  offline,
  removePath,
  revealControls,
  videoState,
  writeText,
} from "./playback-stack";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

const SETUP_TIMEOUT_MS = 240_000;

const run = Date.now().toString(36);

/** The player's tracks button and its popover. */
const TRACKS = "Audio, subtitles, and quality";

/** Plays directly on a Chromecast; has English subtitles. */
const DIRECT = "Lantern Pier";

/** H.264 in Matroska: a Chromecast plays it as remuxed fMP4 HLS. */
const REMUX = "Salt Road";

/** HEVC, which the web sender's Chromecast profile leaves out: it casts as an H.264 transcode. */
const HEVC = "Night Ferry";

const SRT = `1
00:00:00,500 --> 00:02:00,000
The pier lights come on one by one.
`;

let workspace = "";

let media: MediaService | undefined;

let owner: Client;

let libraryId: LibraryId | undefined;

let context: BrowserContext;

let page: Page;

const titles = new Map<string, TitleId>();

const titleId = (name: string): TitleId => {
  const id = titles.get(name);

  if (id === undefined) throw new Error(`${name} was not scanned`);

  return id;
};

/** The volume levels the TV was sent, in order. */
const levels = (commands: FakeReceiver["commands"]) =>
  commands.filter(([command]) => command === "setVolumeLevel").map(([, value]) => value);

/** The ticket parameter of each URL the receiver was given or fetched. */
const credentialsIn = (urls: ReadonlyArray<string>): ReadonlyArray<string> =>
  urls.map((url) => new URL(url).searchParams.get("ticket") ?? "");

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await makeWorkspace("movies-web-casting-");

  const films = join(workspace, "Films");
  const folder = (name: string): string => join(films, `${name} (2022)`);

  await Promise.all([
    encodeClip(join(folder(DIRECT), `${DIRECT} (2022).mp4`), {
      seconds: 120,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(folder(DIRECT), `${DIRECT} (2022).en.srt`), SRT),
    encodeClip(join(folder(REMUX), `${REMUX} (2022).mkv`), {
      seconds: 120,
      video: "h264",
      audio: [
        { codec: "aac", language: "eng" },
        { codec: "aac", language: "fra" },
      ],
    }),
    encodeClip(join(folder(HEVC), `${HEVC} (2022).mkv`), {
      seconds: 30,
      video: "hevc",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    ...[DIRECT, REMUX, HEVC].map((name) =>
      writeText(join(folder(name), "movie.nfo"), movieNfo(name, 2022)),
    ),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  owner = await signInClient(stack, await createPerson(stack, "admin"));
  libraryId = await createLibrary(owner.platform, { name: `Casting ${run}`, folders: [films] });

  (await titlesByName(owner.platform, libraryId)).forEach((id, name) => titles.set(name, id));

  context = await browser.newContext();
  page = await context.newPage();
  await installCastFake(page);
  await signIn(page, owner.person);
});

test.afterAll(async () => {
  if (stack === null) return;

  await context.close();
  await removeLibrary(owner.platform, libraryId);
  await owner.platform.dispose();
  await media?.stop();
  await removePath(workspace);
});

/** Opens the cast menu and connects to the fake Chromecast. */
const castToTv = async (target: Page): Promise<void> => {
  await revealControls(target);
  await target.getByRole("button", { name: "Cast" }).click();
  await target
    .getByRole("dialog", { name: "Play on" })
    .getByRole("button", { name: /Chromecast/u })
    .click();
  await expect(target.getByTestId("casting-state")).toHaveText("Playing on Living Room TV");
  // The receiver reports its state a moment after a load, as a real one does.
  await expect.poll(async () => (await receiver(target)).playerState).toBe("PLAYING");
};

/** Where the owner's progress through `name` stands, as the core saved it. */
const savedSeconds = async (name: string): Promise<number> => {
  const detail = await owner.platform.movies.titles.get({ titleId: titleId(name) });

  return (detail.progress?.positionMs ?? 0) / 1000;
};

test("a Chromecast on the network gets a cast button, and casting loads the start's stream there with a receiver credential", async () => {
  await page.goto(moviesPath(`/watch/${titleId(DIRECT)}?start=0`));
  await expectPlayingPast(page, 2);
  await revealControls(page);
  await expect(page.getByRole("button", { name: "Cast" })).toBeHidden();

  await page.getByTestId("player").press("c");
  await castFake(page, "devicesAppear");
  await revealControls(page);
  await page.getByRole("button", { name: "Cast" }).click();

  // The stack's media server answers on 127.0.0.1, which no Chromecast can reach.
  const menu = page.getByRole("dialog", { name: "Play on" });

  await expect(menu.getByRole("note")).toContainText("can't reach");
  await expect(menu).toHaveCSS("opacity", "1");
  await capture(page, "cast-menu");
  await menu.getByRole("button", { name: /Chromecast/u }).click();
  await expect(page.getByTestId("casting-state")).toHaveText("Playing on Living Room TV");

  const [load] = (await receiver(page)).loads;
  const local = await videoState(page);

  expect(load).toMatchObject({
    contentType: "video/mp4",
    streamType: "BUFFERED",
    hlsSegmentFormat: null,
    title: DIRECT,
    seriesTitle: null,
    autoplay: true,
    activeTrackIds: [1],
  });
  expect(load?.contentId).toMatch(
    new RegExp(`^${stack?.mediaUrl ?? ""}/media/direct/\\w+\\?ticket=r1\\.`, "u"),
  );
  expect(load?.tracks).toEqual([
    expect.objectContaining({ trackId: 1, contentType: "text/vtt", name: "English" }),
  ]);

  // The receiver holds a credential for this start, never the start's ticket.
  const given = credentialsIn([load?.contentId ?? "", ...(load?.tracks ?? []).map((t) => t.url)]);

  expect(given.every(isReceiverCredential)).toBe(true);
  expect(load?.currentTime).toBeGreaterThan(1.5);
  await expect
    .poll(async () => (await receiver(page)).fetches.map(({ status }) => status))
    .toEqual([206]);
  expect(local.paused).toBe(true);
  await expect(page.getByRole("dialog", { name: "Play on" })).toBeHidden();
  // The TV shows the subtitles; the paused page shows none.
  expect(
    await page
      .getByTestId("player-video")
      .evaluate((element) =>
        element instanceof HTMLVideoElement
          ? Array.from(element.textTracks).filter((track) => track.mode === "showing").length
          : -1,
      ),
  ).toBe(0);
  await capture(page, "casting");

  // The TV loads its own copy of the subtitles, which this page cannot retime.
  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();

  const panel = page.getByRole("dialog", { name: TRACKS });
  const delay = panel.getByRole("group", { name: "Subtitle delay" });

  await expect(delay).toContainText("Not while casting");
  await expect(delay.getByRole("button", { name: "Later" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
});

test("the controls drive the receiver, and progress follows it", async () => {
  await advanceReceiver(page, 30);
  await page.getByTestId("player").press("k");
  await expect.poll(async () => (await receiver(page)).isPaused).toBe(true);

  await page.getByTestId("player").press("l");
  await expect.poll(async () => (await receiver(page)).commands).toContainEqual(["seek", 40]);
  await expect.poll(() => savedSeconds(DIRECT), { timeout: 15_000 }).toBeCloseTo(40, 0);

  await page.getByTestId("player").press("ArrowDown");
  await page.getByTestId("player").press("m");
  await page.getByTestId("player").press("c");

  const seen = await receiver(page);

  expect(seen.commands.map(([command]) => command)).toEqual(
    expect.arrayContaining(["playOrPause", "seek", "setVolumeLevel", "muteOrUnmute"]),
  );
  expect(seen.trackChanges.at(-1)).toEqual([]);

  // The volume slider: the TV hears where a drag settles, once, and unmutes there.
  const sent = levels(seen.commands).length;

  await revealControls(page);
  await page.getByRole("button", { name: "Unmute", exact: true }).hover();

  const box = await page.locator('[data-slot="volume-slider"]').boundingBox();

  if (box === null) throw new Error("The volume slider is not on screen");

  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.9, { steps: 4 });
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.5, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => levels((await receiver(page)).commands).length).toBe(sent + 1);

  const after = await receiver(page);

  expect(Number(levels(after.commands).at(-1))).toBeCloseTo(0.5, 1);
  expect(after.commands.findLast(([command]) => command === "muteOrUnmute")).toEqual([
    "muteOrUnmute",
    false,
  ]);
});

test("ending the cast continues on the page where the TV was", async () => {
  await page.getByTestId("player").press("k");
  await advanceReceiver(page, 52);
  await castFake(page, "disconnect");
  await expect(page.getByTestId("casting-state")).toBeHidden();
  await expectPositionNear(page, 52, 1.5);
  await expectPlayingPast(page, 52);
});

test("while Chrome connects to a device, the menu waits for it rather than offering a cancel that does nothing", async () => {
  await castFake(page, "holdConnection");
  await revealControls(page);
  await page.getByRole("button", { name: "Cast" }).click();
  await page
    .getByRole("dialog", { name: "Play on" })
    .getByRole("button", { name: /Chromecast/u })
    .click();
  await expect(page.getByRole("dialog", { name: "Play on" })).toBeHidden();
  await revealControls(page);
  await page.getByRole("button", { name: "Cast", exact: true }).click();

  const row = page
    .getByRole("dialog", { name: "Play on" })
    .getByRole("button", { name: /Chromecast/u });

  await expect(row).toBeDisabled();
  await expect(row).toContainText("Connecting…");
  await page.keyboard.press("Escape");

  await castFake(page, "completeConnection");
  await expect(page.getByTestId("casting-state")).toHaveText("Playing on Living Room TV");
  await castFake(page, "disconnect");
  await expect(page.getByTestId("casting-state")).toBeHidden();
});

test("an MKV casts as fMP4 HLS, and a seek past what it produced moves the stream first", async () => {
  await page.goto(moviesPath(`/watch/${titleId(REMUX)}?start=0`));
  await expectPlayingPast(page, 1);
  await castFake(page, "devicesAppear");

  // The media server keeps one stream per start: once the TV has it, the page must not negotiate
  // again (its player would otherwise replace the TV's stream).
  const negotiations: Array<string> = [];

  page.on("request", (request) => {
    if (request.url().endsWith(MEDIA_ROUTES.negotiate)) negotiations.push(request.url());
  });
  await castToTv(page);

  const afterCast = negotiations.length;

  await advanceReceiver(page, 5);
  await expect.poll(async () => (await receiver(page)).fetches.length).toBeGreaterThanOrEqual(2);
  // The page let go of its stream: its element holds nothing to play.
  expect((await videoState(page)).readyState).toBe(0);
  await castFake(page, "refetch");
  expect((await receiver(page)).fetches.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
  expect(negotiations).toHaveLength(afterCast);
  // Every playlist and segment the receiver fetched carried its credential, never the ticket.
  expect(
    credentialsIn((await receiver(page)).fetches.map(({ url }) => url)).every(isReceiverCredential),
  ).toBe(true);

  const first = (await receiver(page)).loads.at(-1);

  expect(first).toMatchObject({
    contentType: "application/x-mpegurl",
    hlsSegmentFormat: "fmp4",
    title: REMUX,
  });
  expect(first?.contentId).toMatch(/\/media\/hls\/[\w-]+\/\d+\/index\.m3u8\?ticket=r1\./u);

  const before = (await receiver(page)).loads.length;

  // The receiver cannot move the stream itself, so the page asks the media server first.
  const seekRequest = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith(MEDIA_ROUTES.seek),
  );

  await revealControls(page);
  await clickScrubber(page, 0.9);
  await seekRequest;

  // Then either the stream started a new generation there and the receiver reloads it, or that
  // part was already produced and the receiver seeks in place.
  await expect
    .poll(async () => {
      const seen = await receiver(page);
      const reloaded = seen.loads.length > before ? seen.loads.at(-1) : undefined;

      return reloaded === undefined
        ? seen.commands.some(([command, at]) => command === "seek" && Number(at) > 100)
        : reloaded.currentTime > 100 &&
            reloaded.contentId !== first?.contentId &&
            isReceiverCredential(new URL(reloaded.contentId).searchParams.get("ticket") ?? "");
    })
    .toBe(true);

  // Leaving the player stops the TV but keeps the device, so the next title casts by itself. The
  // app navigates in place, as it does to the next episode; a reload would start the fake over.
  await page.evaluate(
    (path) => {
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    moviesPath(`/watch/${titleId(DIRECT)}?start=0`),
  );
  await expect(page.getByTestId("casting-state")).toHaveText("Playing on Living Room TV");
  await expect.poll(async () => (await receiver(page)).loads.at(-1)?.title).toBe(DIRECT);
});

test("a codec the receiver cannot play casts as a transcode it plays", async () => {
  await page.goto(moviesPath(`/watch/${titleId(HEVC)}?start=0`));
  await expectPlayingPast(page, 1);
  await castFake(page, "devicesAppear");

  const negotiated = page.waitForResponse(
    (response) => response.url().endsWith(MEDIA_ROUTES.negotiate) && response.ok(),
  );

  await castToTv(page);

  const body: unknown = await (await negotiated).json();

  expect(body).toMatchObject({ video: { codec: "h264" } });
  expect(JSON.stringify(body)).toMatch(/"mode":"transcode-/u);
  expect((await receiver(page)).loads.at(-1)).toMatchObject({
    contentType: "application/x-mpegurl",
    hlsSegmentFormat: "fmp4",
  });
  await expect
    .poll(async () => (await receiver(page)).fetches.map(({ status }) => status).slice(-2))
    .toEqual([200, 200]);
  await castFake(page, "disconnect");
});

test("leaving the player while casting saves where the TV was", async () => {
  // A page load starts the fake over, disconnected.
  await page.goto(moviesPath(`/watch/${titleId(DIRECT)}?start=0`));
  await expectPlayingPast(page, 1);
  await castFake(page, "devicesAppear");
  await castToTv(page);
  await advanceReceiver(page, 70);
  // A pause reports the TV's position at once, like the reports every ten seconds do.
  await page.getByTestId("player").press("k");
  await expect.poll(async () => (await receiver(page)).isPaused).toBe(true);
  await expect.poll(() => savedSeconds(DIRECT)).toBeCloseTo(70, 0);
  await advanceReceiver(page, 75);
  // Back in the app, as a viewer leaves: the player closes and reports where the start stopped.
  await revealControls(page);
  await page.getByRole("button", { name: "Back to details" }).click();
  await expect(page).toHaveURL(new RegExp(`/title/${titleId(DIRECT)}$`, "u"));
  await expect.poll(async () => (await receiver(page)).commands.at(-1)?.[0]).toBe("stop");
  await expect.poll(() => savedSeconds(DIRECT)).toBeCloseTo(75, 0);
});

test("a TV whose media fails hands playback back to the page", async () => {
  await page.goto(moviesPath(`/watch/${titleId(DIRECT)}?start=0`));
  await expectPlayingPast(page, 1);
  await castFake(page, "devicesAppear");
  await castToTv(page);
  await advanceReceiver(page, 20);

  // The receiver goes idle with an error (a download failed); the cast session stays connected.
  await castFake(page, "fail");
  await expect(page.getByText("The TV stopped playing this. Continuing here.")).toBeVisible();
  await expect(page.getByTestId("casting-state")).toBeHidden();
  await expectPositionNear(page, 20, 1.5);
  await expectPlayingPast(page, 20);
});

test("audio changes in quick succession leave the TV on the stream the media server keeps", async () => {
  await page.goto(moviesPath(`/watch/${titleId(REMUX)}?start=0`));
  await expectPlayingPast(page, 1);
  await castFake(page, "devicesAppear");
  await castToTv(page);

  // The first change's negotiation reaches the media server after the second's: run side by
  // side, the server would keep the first's stream and drop the one the TV plays.
  let held = false;

  await page.route(`**${MEDIA_ROUTES.negotiate}`, async (route) => {
    if (!held) {
      held = true;
      await page.waitForTimeout(1_500);
    }

    await route.continue();
  });

  const before = (await receiver(page)).loads.length;

  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();

  const panel = page.getByRole("dialog", { name: TRACKS });

  await panel.getByRole("radio", { name: "French" }).click();
  await panel.getByRole("radio", { name: "English" }).click();
  await page.keyboard.press("Escape");

  // Both changes reach the TV in order, and the stream it ends on is still served.
  await expect
    .poll(async () => (await receiver(page)).loads.length, { timeout: 15_000 })
    .toBe(before + 2);
  await page.unroute(`**${MEDIA_ROUTES.negotiate}`);
  await castFake(page, "refetch");
  expect((await receiver(page)).fetches.slice(-2).map(({ status }) => status)).toEqual([200, 200]);
  await castFake(page, "disconnect");
});

test("a quality chosen while casting reaches the TV's stream", async () => {
  await page.goto(moviesPath(`/watch/${titleId(REMUX)}?start=0`));
  await expectPlayingPast(page, 1);
  await castFake(page, "devicesAppear");
  await castToTv(page);

  const asked: Array<string> = [];

  const onRequest = (request: Request) => {
    if (request.url().endsWith(MEDIA_ROUTES.negotiate)) asked.push(request.postData() ?? "");
  };

  page.on("request", onRequest);

  const before = (await receiver(page)).loads.length;

  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await page.getByRole("dialog", { name: TRACKS }).getByRole("radio", { name: "480p" }).click();
  await page.keyboard.press("Escape");

  // The TV gets a stream negotiated with the cap, not just the page's menu.
  await expect
    .poll(async () => (await receiver(page)).loads.length, { timeout: 15_000 })
    .toBe(before + 1);
  expect(asked.at(-1)).toContain('"maxHeight":480');
  page.off("request", onRequest);
  await castFake(page, "disconnect");
});

/** The clock of the owner's movies group session. */
const sessionClock = async () => {
  const current = await owner.platform.core.together.get({ domain: "movies" });

  if (current?.state !== "joined") throw new Error("The host is in no session");

  return current.clock;
};

test("a group session follows the device its host casts to", async () => {
  await page.goto(moviesPath(`/watch/${titleId(DIRECT)}?start=0`));
  await expectPlayingPast(page, 2);
  await revealControls(page);
  await page.getByRole("button", { name: "Watch together" }).click();
  await page.getByRole("button", { name: "Start session" }).click();
  await expect(page.getByRole("region", { name: "Watching together" })).toBeVisible();

  await castFake(page, "devicesAppear");
  await castToTv(page);
  // The host's controls move the session's clock, and the TV follows the clock (D35).
  await page.getByTestId("player").press("k");
  await expect.poll(async () => (await sessionClock()).status).toBe("paused");
  await expect.poll(async () => (await receiver(page)).isPaused).toBe(true);

  const pausedAt = (await sessionClock()).positionAtAnchorMs;

  await page.getByTestId("player").press("l");
  await expect
    .poll(async () => (await sessionClock()).positionAtAnchorMs, { timeout: 10_000 })
    .toBeGreaterThan(pausedAt + 8_000);

  const seekedTo = (await sessionClock()).positionAtAnchorMs / 1000;

  await expect
    .poll(async () => Math.abs((await receiver(page)).currentTime - seekedTo), { timeout: 10_000 })
    .toBeLessThan(1.5);
  await castFake(page, "disconnect");
  await revealControls(page);
  await page.getByRole("button", { name: "End session" }).click();
});

test("signing out mid-cast ends the receiver's stream", async () => {
  await page.goto(moviesPath(`/watch/${titleId(REMUX)}?start=0`));
  await expectPlayingPast(page, 1);
  await castFake(page, "devicesAppear");
  await castToTv(page);
  await castFake(page, "refetch");
  expect((await receiver(page)).fetches.slice(-2).map(({ status }) => status)).toEqual([200, 200]);

  const fetched = (await receiver(page)).fetches.at(-1)?.url ?? "";

  // The browser's own sign-in ends, as signing it out from another of the owner's devices does.
  const sessions = await owner.platform.core.auth.sessions.list({
    paginationOpts: { numItems: 50, cursor: null },
  });

  await Promise.all(
    sessions.page
      .filter((each) => !each.current)
      .map((each) => owner.platform.core.auth.sessions.end({ sessionId: each.sessionId })),
  );

  await expect
    .poll(
      async () => {
        const answer = await fetch(fetched);

        await answer.body?.cancel();

        return answer.status;
      },
      { timeout: 30_000 },
    )
    .not.toBe(200);
});
