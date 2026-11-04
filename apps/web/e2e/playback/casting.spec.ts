import { join } from "node:path";

import { RoomId } from "@media/contracts/ids";
import { MEDIA_ROUTES } from "@media/contracts/media-playback";
import type { TitleId } from "@media/contracts/ids";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page, Request } from "@playwright/test";
import { Schema } from "effect";

import { NO_STACK, ownedStack, signInOwner, useSession } from "../admin/session";
import type { Client } from "../admin/session";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import { advanceReceiver, castFake, installCastFake, receiver } from "./cast-fake";
import type { FakeReceiver } from "./cast-fake";
import {
  capture,
  encodeClip,
  expectPlayingPast,
  expectPositionNear,
  makeWorkspace,
  adultProfile,
  movieNfo,
  offline,
  removePath,
  revealControls,
  scanLibrary,
  titlesByName,
  videoState,
  writeText,
} from "./playback-stack";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

const SETUP_TIMEOUT_MS = 240_000;

const levels = (commands: FakeReceiver["commands"]) =>
  commands.filter(([command]) => command === "setVolumeLevel").map(([, value]) => value);

const run = Date.now().toString(36);

const TRACKS = "Audio, subtitles, and quality";

const DIRECT = "Lantern Pier";

const REMUX = "Salt Road";

const SRT = `1
00:00:00,500 --> 00:02:00,000
The pier lights come on one by one.
`;

let workspace = "";

let media: MediaService | undefined;

let owner: Client;

let context: BrowserContext;

let page: Page;

const titles = new Map<string, TitleId>();

const titleId = (name: string): TitleId => {
  const id = titles.get(name);

  if (id === undefined) throw new Error(`${name} was not scanned`);

  return id;
};

const MEDIA_SESSION_RECORDER = `
(() => {
  const handlers = {};
  window.__mediaSessionHandlers = handlers;
  const session = navigator.mediaSession;
  const set = session.setActionHandler.bind(session);
  session.setActionHandler = (action, handler) => {
    handlers[action] = handler;
    set(action, handler);
  };
})();
`;

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
    ...[DIRECT, REMUX].map((name) =>
      writeText(join(folder(name), "movie.nfo"), movieNfo(name, 2022)),
    ),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  owner = await signInOwner(stack);

  const libraryId = await scanLibrary(owner.sdk, {
    name: `Casting ${run}`,
    kind: "movies",
    root: films,
    access: "everyone",
  });

  (await titlesByName(owner.sdk, libraryId)).forEach((id, name) => titles.set(name, id));

  context = await browser.newContext();
  page = await context.newPage();
  await installCastFake(page);
  await page.addInitScript({ content: MEDIA_SESSION_RECORDER });
  await useSession(page, owner);
});

test.afterAll(async () => {
  if (stack === null) return;

  await context.close();
  await owner.sdk.dispose();
  await media?.stop();
  await removePath(workspace);
});

const castToTv = async (target: Page): Promise<void> => {
  await revealControls(target);
  await target.getByRole("button", { name: "Cast" }).click();
  await target
    .getByRole("dialog", { name: "Play on" })
    .getByRole("button", { name: /Chromecast/u })
    .click();
  await expect(target.getByTestId("casting-state")).toHaveText("Playing on Living Room TV");
  await expect.poll(async () => (await receiver(target)).playerState).toBe("PLAYING");
};

const reportedSeconds = async (name: string): Promise<number> => {
  const sessions = await owner.sdk.query("playback.active", {});

  const session = sessions
    .filter((each) => each.titleId === titleId(name))
    .toSorted((left, right) => right.startedAt - left.startedAt)[0];

  return (session?.positionMs ?? 0) / 1000;
};

test("a Chromecast on the network gets a cast button, and casting loads the session's stream there", async () => {
  await page.goto(`/watch/${titleId(DIRECT)}?start=0`);
  await expectPlayingPast(page, 2);
  await revealControls(page);
  await expect(page.getByRole("button", { name: "Cast" })).toBeHidden();

  await page.getByTestId("player").press("c");
  await castFake(page, "devicesAppear");
  await revealControls(page);
  await page.getByRole("button", { name: "Cast" }).click();

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
    new RegExp(`^${stack?.mediaUrl ?? ""}/media/direct/\\w+\\?token=v1\\.`, "u"),
  );
  expect(load?.tracks).toEqual([
    expect.objectContaining({ trackId: 1, contentType: "text/vtt", name: "English" }),
  ]);
  expect(load?.tracks[0]?.url).toMatch(/\/media\/subtitles\/\w+\/x[\da-f]{12}\.vtt\?token=v1\./u);
  expect(load?.currentTime).toBeGreaterThan(1.5);
  await expect
    .poll(async () => (await receiver(page)).fetches.map(({ status }) => status))
    .toEqual([206]);
  expect(local.paused).toBe(true);
  await expect(page.getByRole("dialog", { name: "Play on" })).toBeHidden();
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
  await expect.poll(() => reportedSeconds(DIRECT), { timeout: 10_000 }).toBeCloseTo(40, 0);

  await page.getByTestId("player").press("ArrowDown");
  await page.getByTestId("player").press("m");
  await page.getByTestId("player").press("c");

  const seen = await receiver(page);

  expect(seen.commands.map(([command]) => command)).toEqual(
    expect.arrayContaining(["playOrPause", "seek", "setVolumeLevel", "muteOrUnmute"]),
  );
  expect(seen.trackChanges.at(-1)).toEqual([]);

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
  await page.goto(`/watch/${titleId(REMUX)}?start=0`);
  await expectPlayingPast(page, 1);
  await castFake(page, "devicesAppear");

  const negotiations: Array<string> = [];

  page.on("request", (request) => {
    if (request.url().endsWith(MEDIA_ROUTES.negotiate)) negotiations.push(request.url());
  });
  await castToTv(page);

  const afterCast = negotiations.length;

  await advanceReceiver(page, 5);
  await expect.poll(async () => (await receiver(page)).fetches.length).toBeGreaterThanOrEqual(2);
  expect((await videoState(page)).readyState).toBe(0);
  await castFake(page, "refetch");
  expect((await receiver(page)).fetches.map(({ status }) => status)).toEqual([200, 200, 200, 200]);
  expect(negotiations).toHaveLength(afterCast);

  const first = (await receiver(page)).loads.at(-1);

  expect(first).toMatchObject({
    contentType: "application/x-mpegurl",
    hlsSegmentFormat: "fmp4",
    title: REMUX,
  });
  expect(first?.contentId).toMatch(/\/media\/hls\/[\w-]+\/\d+\/index\.m3u8\?token=v1\./u);

  const before = (await receiver(page)).loads.length;

  await revealControls(page);

  const box = await page.locator('[data-slot="scrubber"]').boundingBox();

  if (box === null) throw new Error("The scrubber is not on screen");

  const seekRequest = page.waitForRequest(
    (request) => request.method() === "POST" && request.url().endsWith(MEDIA_ROUTES.seek),
  );

  await page.mouse.click(box.x + box.width * 0.9, box.y + box.height / 2);
  await seekRequest;

  await expect
    .poll(async () => {
      const seen = await receiver(page);
      const reloaded = seen.loads.length > before ? seen.loads.at(-1) : undefined;

      return reloaded === undefined
        ? seen.commands.some(([command, at]) => command === "seek" && Number(at) > 100)
        : reloaded.currentTime > 100 && reloaded.contentId !== first?.contentId;
    })
    .toBe(true);

  await page.evaluate(
    (path) => {
      window.history.pushState({}, "", path);
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    `/watch/${titleId(DIRECT)}?start=0`,
  );
  await expect(page.getByTestId("casting-state")).toHaveText("Playing on Living Room TV");
  await expect.poll(async () => (await receiver(page)).loads.at(-1)?.title).toBe(DIRECT);
});

test("leaving the player while casting saves where the TV was", async () => {
  await page.goto(`/watch/${titleId(DIRECT)}?start=0`);
  await expectPlayingPast(page, 1);
  await castFake(page, "devicesAppear");
  await castToTv(page);
  await advanceReceiver(page, 70);
  await page.getByTestId("player").press("k");
  await expect.poll(async () => (await receiver(page)).isPaused).toBe(true);
  await expect.poll(() => reportedSeconds(DIRECT)).toBeCloseTo(70, 0);
  await advanceReceiver(page, 75);
  await revealControls(page);
  await page.getByRole("button", { name: "Back to details" }).click();
  await expect(page).toHaveURL(new RegExp(`/title/${titleId(DIRECT)}$`, "u"));
  await expect.poll(async () => (await receiver(page)).commands.at(-1)?.[0]).toBe("stop");

  const profile = await adultProfile(owner.sdk);

  const saved = async (): Promise<number> => {
    const detail = await owner.sdk.query("titles.get", {
      profileId: profile.id,
      titleId: titleId(DIRECT),
    });

    return (detail.progress?.positionMs ?? 0) / 1000;
  };

  await expect.poll(saved).toBeCloseTo(75, 0);
});

test("a TV whose media fails hands playback back to the page", async () => {
  await page.goto(`/watch/${titleId(DIRECT)}?start=0`);
  await expectPlayingPast(page, 1);
  await castFake(page, "devicesAppear");
  await castToTv(page);
  await advanceReceiver(page, 20);

  await castFake(page, "fail");
  await expect(page.getByText("The TV stopped playing this. Continuing here.")).toBeVisible();
  await expect(page.getByTestId("casting-state")).toBeHidden();
  await expectPositionNear(page, 20, 1.5);
  await expectPlayingPast(page, 20);
});

test("audio changes in quick succession leave the TV on the stream the media service keeps", async () => {
  await page.goto(`/watch/${titleId(REMUX)}?start=0`);
  await expectPlayingPast(page, 1);
  await castFake(page, "devicesAppear");
  await castToTv(page);

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

  await expect
    .poll(async () => (await receiver(page)).loads.length, { timeout: 15_000 })
    .toBe(before + 2);
  await page.unroute(`**${MEDIA_ROUTES.negotiate}`);
  await castFake(page, "refetch");
  expect((await receiver(page)).fetches.slice(-2).map(({ status }) => status)).toEqual([200, 200]);
  await castFake(page, "disconnect");
});

test("a quality chosen while casting reaches the TV's stream", async () => {
  await page.goto(`/watch/${titleId(REMUX)}?start=0`);
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

  await expect
    .poll(async () => (await receiver(page)).loads.length, { timeout: 15_000 })
    .toBe(before + 1);
  expect(asked.at(-1)).toContain('"maxHeight":480');
  page.off("request", onRequest);

  await page.getByRole("button", { name: TRACKS }).click();
  await page.getByRole("dialog", { name: TRACKS }).getByRole("radio", { name: "Auto" }).click();
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => (await receiver(page)).loads.length, { timeout: 15_000 })
    .toBe(before + 2);
  await castFake(page, "disconnect");
});

test("a watch room follows the device its host casts to", async () => {
  await castFake(page, "disconnect");
  await page.goto(`/watch/${titleId(DIRECT)}?start=0`);
  await expectPlayingPast(page, 2);
  await revealControls(page);
  await page.getByRole("button", { name: "Watch together" }).click();
  await page
    .getByRole("dialog", { name: "Watch together" })
    .getByRole("button", { name: "Start room" })
    .click();
  await expect(page).toHaveURL(/[?&]room=/u);

  const roomId = Schema.decodeSync(RoomId)(new URL(page.url()).searchParams.get("room") ?? "");
  const clock = async () => (await owner.sdk.query("rooms.get", { roomId })).clock;

  await castFake(page, "devicesAppear");
  await castToTv(page);
  await page.getByTestId("player").press("k");
  await expect.poll(async () => (await clock()).status).toBe("paused");

  await advanceReceiver(page, 60);
  await page.getByTestId("player").press("l");
  await expect
    .poll(async () => (await clock()).positionAtAnchorMs, { timeout: 10_000 })
    .toBeGreaterThan(65_000);
  await castFake(page, "disconnect");
});

test("the system's media controls show what plays and drive the player", async () => {
  await page.goto(`/watch/${titleId(DIRECT)}?start=0`);
  await expectPlayingPast(page, 2);
  await expect.poll(() => page.evaluate(() => navigator.mediaSession.metadata?.title)).toBe(DIRECT);
  expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe("playing");

  await page.evaluate("window.__mediaSessionHandlers.pause()");
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);
  await page.evaluate("window.__mediaSessionHandlers.seekto({ action: 'seekto', seekTime: 90 })");
  await expectPositionNear(page, 90, 1);
  await page.evaluate("window.__mediaSessionHandlers.play()");
  await expectPlayingPast(page, 90.5);
  await page.evaluate("window.__mediaSessionHandlers.seekbackward({ action: 'seekbackward' })");
  await expect.poll(async () => (await videoState(page)).currentTime).toBeLessThan(85);
});
