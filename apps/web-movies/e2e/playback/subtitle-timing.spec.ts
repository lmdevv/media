import { join } from "node:path";

import { devices, expect, test } from "@playwright/test";
import type { BrowserContext, Locator, Page } from "@playwright/test";

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
  signedInPage,
} from "../stack/people";
import type { Client } from "../stack/people";
import {
  HAVE_CURRENT_DATA,
  capture,
  encodeClip,
  expectPlayingPast,
  makeWorkspace,
  movieNfo,
  offline,
  removePath,
  revealControls,
  videoState,
  writeText,
} from "./playback-stack";
import { recordStreams } from "./negotiated-streams";
import type { NegotiatedStream } from "./negotiated-streams";

const stack = await reachableStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

const SETUP_TIMEOUT_MS = 240_000;

const run = Date.now().toString(36);

const FILM = "Tide Clock";

const PICTURES = "Paper Kite";

const ENGLISH = [
  { text: "Ten seconds.", start: 10, end: 12 },
  { text: "Thirty seconds.", start: 30, end: 32 },
] as const;

const srt = (
  cues: ReadonlyArray<{ readonly text: string; readonly start: number; readonly end: number }>,
) =>
  cues
    .map(
      (cue, index) =>
        `${String(index + 1)}\n00:00:${String(cue.start).padStart(2, "0")},000 --> 00:00:${String(cue.end).padStart(2, "0")},000\n${cue.text}\n`,
    )
    .join("\n");

const FRENCH = [{ text: "Dix secondes.", start: 10, end: 12 }] as const;

const VOBSUB = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "media",
  "src",
  "testing",
  "fixtures",
  "vobsub.mkv",
);

const TRACKS = "Audio, subtitles, and quality";

let workspace = "";

let media: MediaService | undefined;

let owner: Client;

let libraryId: LibraryId | undefined;

let hostContext: BrowserContext;

let page: Page;

let streams: ReadonlyArray<NegotiatedStream> = [];

const titles = new Map<string, TitleId>();

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await makeWorkspace("movies-web-subtitle-delay-");

  const films = join(workspace, "Films");
  const folder = (name: string): string => join(films, `${name} (2022)`);

  await Promise.all([
    encodeClip(join(folder(FILM), `${FILM} (2022).mp4`), {
      seconds: 60,
      video: "h264",
      size: "1280x720",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(folder(FILM), `${FILM} (2022).en.srt`), srt(ENGLISH)),
    writeText(join(folder(FILM), `${FILM} (2022).fr.srt`), srt(FRENCH)),
    encodeClip(join(folder(PICTURES), `${PICTURES} (2022).mkv`), {
      seconds: 20,
      video: "h264",
      size: "1280x720",
      audio: [{ codec: "aac", language: "eng" }],
      subtitles: { file: VOBSUB, language: "eng" },
    }),
    ...[FILM, PICTURES].map((name) =>
      writeText(join(folder(name), "movie.nfo"), movieNfo(name, 2022)),
    ),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  owner = await signInClient(stack, await createPerson(stack, "admin"));
  libraryId = await createLibrary(owner.platform, {
    name: `Subtitle delay films ${run}`,
    folders: [films],
  });

  for (const [name, id] of await titlesByName(owner.platform, libraryId)) titles.set(name, id);

  hostContext = await browser.newContext();
  page = await hostContext.newPage();
  streams = recordStreams(page);
  await signIn(page, owner.person);
});

test.afterAll(async () => {
  if (stack === null) return;

  await hostContext.close();
  await removeLibrary(owner.platform, libraryId);
  await owner.platform.dispose();
  await media?.stop();
  await removePath(workspace);
});

function titleId(name: string): TitleId {
  const id = titles.get(name);

  if (id === undefined) throw new Error(`${name} was not scanned`);

  return id;
}

const showing = (target: Page) =>
  target.getByTestId("player-video").evaluate((element) => {
    if (!(element instanceof HTMLVideoElement)) return null;

    const track = Array.from(element.textTracks).find((each) => each.mode === "showing");

    if (track === undefined) return null;

    return {
      label: track.label,
      starts: Array.from(track.cues ?? [], (cue) => Math.round(cue.startTime * 1000)),
      active: Array.from(track.activeCues ?? [], (cue) => (cue instanceof VTTCue ? cue.text : "")),
    };
  });

const englishStarts = (delayMs: number) => ENGLISH.map((cue) => cue.start * 1000 + delayMs);

const seekElement = async (target: Page, seconds: number): Promise<void> => {
  await target.getByTestId("player-video").evaluate(async (element, to) => {
    if (!(element instanceof HTMLVideoElement)) return;

    const seeked = new Promise((resolve) => {
      element.addEventListener("seeked", resolve, { once: true });
    });

    element.currentTime = to;
    await seeked;
  }, seconds);
};

const tracksPanel = async (target: Page): Promise<Locator> => {
  const panel = target.getByRole("dialog", { name: TRACKS });

  if (!(await panel.isVisible())) {
    await revealControls(target);
    await target.getByRole("button", { name: TRACKS }).click();
  }

  return panel;
};

const closeTracks = async (target: Page): Promise<void> => {
  await target.keyboard.press("Escape");
  await expect(target.getByRole("dialog", { name: TRACKS })).toBeHidden();
};

const delayControl = (panel: Locator): Locator =>
  panel.getByRole("group", { name: "Subtitle delay" });

const chooseSubtitle = async (target: Page, name: string): Promise<void> => {
  const panel = await tracksPanel(target);

  await panel.getByRole("radiogroup", { name: "Subtitles" }).getByRole("radio", { name }).click();
};

const enterDelay = async (target: Page, seconds: string): Promise<void> => {
  const field = delayControl(await tracksPanel(target)).getByRole("textbox", {
    name: "Subtitle delay in seconds",
  });

  await field.fill(seconds);
  await field.press("Enter");
};

const repeat = async (times: number, act: () => Promise<void>): Promise<void> => {
  if (times === 0) return;
  await act();
  await repeat(times - 1, act);
};

/**
 * Waits until a stream the player just switched to plays past `seconds`. While its start seek is
 * under way the element already reports the target and not paused, so a pause then lands inside
 * the seek (ADS-173) instead of on a playing stream.
 */
const expectSwitchedPlayingPast = async (target: Page, seconds: number): Promise<void> => {
  await expect
    .poll(
      async () =>
        target
          .getByTestId("player-video")
          .evaluate(
            (element, past) =>
              element instanceof HTMLVideoElement &&
              !element.paused &&
              !element.seeking &&
              element.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA &&
              element.currentTime > past,
            seconds,
          ),
      { timeout: 30_000 },
    )
    .toBe(true);
};

const openPaused = async (target: Page, name: string): Promise<void> => {
  await target.goto(moviesPath(`/watch/${titleId(name)}?start=0`));
  await expectPlayingPast(target, 0.5);
  await target.getByTestId("player").press("k");
  await expect.poll(async () => (await videoState(target)).paused).toBe(true);
};

test("Earlier, Later, a typed delay, and Reset move the cues both ways while paused", async () => {
  await openPaused(page, FILM);
  await chooseSubtitle(page, "English");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(0) });

  const panel = await tracksPanel(page);
  const control = delayControl(panel);
  const field = control.getByRole("textbox", { name: "Subtitle delay in seconds" });

  await expect(field).toHaveValue("0.0");
  await expect(control.getByRole("button", { name: "Reset" })).toBeDisabled();
  await expect(control.getByRole("button", { name: "Earlier" })).toHaveText("G");
  await expect(control.getByRole("button", { name: "Later" })).toHaveText("H");

  await seekElement(page, 9);
  await expect.poll(() => showing(page)).toMatchObject({ active: [] });

  await repeat(10, () => control.getByRole("button", { name: "Later" }).click());

  await expect(field).toHaveValue("+1.0");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(1000), active: [] });

  await enterDelay(page, "-1.5");
  await expect(field).toHaveValue("−1.5");
  await expect
    .poll(() => showing(page))
    .toMatchObject({ starts: englishStarts(-1500), active: ["Ten seconds."] });
  await capture(page, "subtitle-delay-earlier");

  await enterDelay(page, "soon");
  await expect(field).toHaveValue("−1.5");
  await enterDelay(page, "45");
  await expect(field).toHaveValue("+30.0");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(30_000) });

  await control.getByRole("button", { name: "Reset" }).click();
  await expect(field).toHaveValue("0.0");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(0), active: [] });

  await closeTracks(page);

  const player = page.getByTestId("player");

  await repeat(3, () => player.press("h"));
  await expect(page.getByRole("status").filter({ hasText: "Subtitle delay" })).toContainText(
    "+0.3 s",
  );
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(300) });
  await capture(page, "subtitle-delay-notice");

  await repeat(5, () => player.press("g"));
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(-200) });
  await expect(page.getByRole("status").filter({ hasText: "Subtitle delay" })).toContainText(
    "−0.2 s",
  );

  const menu = page.getByRole("dialog", { name: "Command menu" });
  const playback = menu.getByRole("group", { name: "Playback" });

  await page.keyboard.press("ControlOrMeta+k");
  await expect(playback.getByRole("option", { name: /^Subtitles earlier/u })).toContainText("G");
  await expect(playback.getByRole("option", { name: /^Reset subtitle delay/u })).toBeVisible();
  await playback.getByRole("option", { name: /^Subtitles later/u }).click();
  await expect(menu).toBeHidden();
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(-100) });
  await page.keyboard.press("ControlOrMeta+k");
  await playback.getByRole("option", { name: /^Reset subtitle delay/u }).click();
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(0) });

  await repeat(2, () => player.press("g"));
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(-200) });
});

test("the delay holds through seeks, playing, and a quality change to an hls.js transcode", async () => {
  const player = page.getByTestId("player");

  await player.press("ArrowRight");
  await player.press("ArrowLeft");
  await seekElement(page, 9.9);
  await expect
    .poll(() => showing(page))
    .toMatchObject({ starts: englishStarts(-200), active: ["Ten seconds."] });

  await player.press("k");
  await expectPlayingPast(page, 10.5);
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(-200) });

  const before = streams.length;
  const panel = await tracksPanel(page);

  await panel
    .getByRole("radiogroup", { name: "Quality" })
    .getByRole("radio", { name: "480p" })
    .click();
  await expect
    .poll(() => streams.slice(before).at(-1))
    .toMatchObject({ mode: "transcode-software", height: 480 });
  await expectSwitchedPlayingPast(page, 11);
  await page.getByTestId("player").press("k");

  await expect
    .poll(async () => {
      const state = await videoState(page);

      return state.paused && state.readyState >= HAVE_CURRENT_DATA && state.currentTime > 10;
    })
    .toBe(true);

  const field = delayControl(await tracksPanel(page)).getByRole("textbox", {
    name: "Subtitle delay in seconds",
  });

  await expect(field).toHaveValue("−0.2");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(-200) });

  const at = (await videoState(page)).currentTime;
  const around = Math.round((at - 11) * 100) / 100;

  await enterDelay(page, String(around));
  await expect.poll(() => showing(page)).toMatchObject({ active: ["Ten seconds."] });
  await enterDelay(page, String(around + 3));
  await expect.poll(() => showing(page)).toMatchObject({ active: [] });

  const back = streams.length;

  await (
    await tracksPanel(page)
  )
    .getByRole("radiogroup", { name: "Quality" })
    .getByRole("radio", { name: "Auto" })
    .click();
  await expect.poll(() => streams.slice(back).at(-1)?.mode).toBe("direct");
});

test("another track starts at zero, Off keeps the delay, and the control says why it is off", async () => {
  await openPaused(page, FILM);
  await chooseSubtitle(page, "English");
  await enterDelay(page, "0.5");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(500) });

  const control = delayControl(await tracksPanel(page));
  const field = control.getByRole("textbox", { name: "Subtitle delay in seconds" });

  await chooseSubtitle(page, "French");
  await expect(field).toHaveValue("0.0");
  await expect
    .poll(() => showing(page))
    .toMatchObject({ label: "French", starts: [FRENCH[0].start * 1000] });

  await chooseSubtitle(page, "English");
  await expect(field).toHaveValue("0.0");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(0) });

  await enterDelay(page, "-0.7");
  await chooseSubtitle(page, "Off");
  await expect(control).toContainText("Subtitles are off");
  await expect(field).toBeDisabled();
  await expect(control.getByRole("button", { name: "Later" })).toBeDisabled();
  await capture(page, "subtitle-delay-off");
  await closeTracks(page);
  await page.getByTestId("player").press("h");
  await expect(page.getByRole("status").filter({ hasText: "Subtitle delay" })).toContainText(
    "Subtitles are off",
  );

  await chooseSubtitle(page, "English");
  await expect(field).toHaveValue("−0.7");
  await expect.poll(() => showing(page)).toMatchObject({ starts: englishStarts(-700) });

  await page.reload();
  await expectPlayingPast(page, 0.5);
  await chooseSubtitle(page, "English");
  await expect(field).toHaveValue("0.0");
});

test("a picture subtitle is drawn into the video, so its delay is off with the reason", async () => {
  await openPaused(page, PICTURES);
  await chooseSubtitle(page, "English (VobSub)");

  const control = delayControl(await tracksPanel(page));

  await expect(control).toContainText("Burned into the video");
  await expect(control.getByRole("button", { name: "Earlier" })).toBeDisabled();
  await expect(control.getByRole("textbox")).toBeDisabled();
  await capture(page, "subtitle-delay-burned-in");
});

test("on a phone the delay sits under the subtitles too, without keycaps", async ({ browser }) => {
  if (stack === null) return;

  const handset = await signedInPage(browser, owner.person, { ...devices["iPhone 13 landscape"] });
  const phone = handset.context();

  await handset.goto(moviesPath(`/watch/${titleId(FILM)}?start=0`));
  await expectPlayingPast(handset, 0.5);
  await handset.getByTestId("player-video").tap();
  await handset.getByRole("button", { name: "Off", exact: true }).tap();

  const panel = handset.getByRole("dialog", { name: TRACKS });

  await panel
    .getByRole("radiogroup", { name: "Subtitles" })
    .getByRole("radio", { name: "English" })
    .tap();

  const control = delayControl(panel);
  const later = control.getByRole("button", { name: "Later" });

  await later.tap();
  await expect(control.getByRole("textbox")).toHaveValue("+0.1");
  await expect(later).toHaveText("");
  await expect.poll(() => showing(handset)).toMatchObject({ starts: englishStarts(100) });
  await capture(handset, "subtitle-delay-phone");
  await phone.close();
});
