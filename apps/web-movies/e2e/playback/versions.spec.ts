import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { devices, expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";

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
import { expectAboveTrigger } from "../menu-geometry";
import { recordStreams, refuseNextNegotiation } from "./negotiated-streams";
import type { NegotiatedStream } from "./negotiated-streams";
import {
  capture,
  encodeClip,
  episodeNfo,
  expectPlayingPast,
  expectPositionNear,
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

const run = Date.now().toString(36);

const MOVIE = "Tidewater";

const SHOW = "Ebb Tide";

const TRACKS = "Audio, subtitles, and quality";

const SRT = `1
00:00:00,500 --> 00:00:10,000
The tide turns.
`;

const SUBTITLE_LANGUAGES = [
  "en",
  "fr",
  "de",
  "es",
  "it",
  "pt",
  "nl",
  "sv",
  "no",
  "da",
  "fi",
  "pl",
  "cs",
  "hu",
  "el",
  "tr",
  "ru",
  "uk",
  "ar",
  "he",
  "fa",
  "hin",
  "ja",
  "ko",
  "zh",
  "th",
  "vi",
  "id",
  "ro",
  "bg",
  "hr",
  "sr",
] as const;

let workspace = "";

let media: MediaService | undefined;

let owner: Client;

let context: BrowserContext;

let page: Page;

let streams: ReadonlyArray<NegotiatedStream> = [];

let movieId: TitleId;

let showId: TitleId;

type MediaFileId = Awaited<
  ReturnType<Client["platform"]["movies"]["titles"]["versions"]>
>[number]["id"];

const files = new Map<string, MediaFileId>();

const libraries: Array<LibraryId> = [];

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await mkdtemp(join(tmpdir(), "movies-web-versions-"));

  const films = join(workspace, "Films");
  const film = join(films, `${MOVIE} (2021)`);
  const shows = join(workspace, "Shows");
  const season = join(shows, `${SHOW} (2020)`, "Season 01");

  await Promise.all([
    encodeClip(join(film, `${MOVIE} (2021) {edition-Standard}.mp4`), {
      seconds: 60,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    encodeClip(join(film, `${MOVIE} (2021) {edition-Remastered}.mkv`), {
      seconds: 60,
      video: "h264",
      size: "1280x720",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(film, "movie.nfo"), movieNfo(MOVIE, 2021)),
    writeText(join(shows, `${SHOW} (2020)`, "tvshow.nfo"), showNfo(SHOW, 2020)),
    encodeClip(join(season, `${SHOW} - S01E01.mp4`), {
      seconds: 20,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    encodeClip(join(season, `${SHOW} - S01E01 - 720p.mkv`), {
      seconds: 20,
      video: "h264",
      size: "1280x720",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(season, `${SHOW} - S01E01.nfo`), episodeNfo(1, 1, "Neap")),
    ...SUBTITLE_LANGUAGES.map(async (language) =>
      writeText(join(season, `${SHOW} - S01E01.${language}.srt`), SRT),
    ),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  owner = await signInClient(stack, await createPerson(stack, "admin"));

  const { platform } = owner;

  const [filmsId, showsId] = await Promise.all([
    createLibrary(platform, { name: `Versions films ${run}`, folders: [films] }),
    createLibrary(platform, { name: `Versions shows ${run}`, folders: [shows] }),
  ]);

  libraries.push(filmsId, showsId);

  const movie = (await titlesByName(platform, filmsId)).get(MOVIE);
  const show = (await titlesByName(platform, showsId)).get(SHOW);

  if (movie === undefined || show === undefined) throw new Error("The clips were not scanned");
  movieId = movie;
  showId = show;

  const versions = await platform.movies.titles.versions({ titleId: movieId });

  for (const version of versions) files.set(version.versionName ?? "", version.id);

  context = await browser.newContext();
  page = await context.newPage();
  streams = recordStreams(page);
  await signIn(page, owner.person);
});

test.afterAll(async () => {
  if (stack === null) return;

  await context.close();
  await Promise.all(libraries.map((libraryId) => removeLibrary(owner.platform, libraryId)));
  await owner.platform.dispose();
  await media?.stop();
  await rm(workspace, { recursive: true, force: true });
});

/** The version of the film this person started last, as the core remembers it. */
const sessionFile = async (): Promise<MediaFileId | undefined> =>
  (await owner.platform.movies.titles.versions({ titleId: movieId })).find(
    (version) => version.lastPlayed,
  )?.id;

const fileOf = (edition: string): MediaFileId => {
  const id = files.get(edition);

  if (id === undefined) throw new Error(`The film has no ${edition} edition`);

  return id;
};

const firstEpisode = async (): Promise<string> => {
  const {
    page: [episode],
  } = await owner.platform.movies.titles.episodes({
    titleId: showId,
    seasonNumber: 1,
    paginationOpts: { numItems: 10, cursor: null },
  });

  if (episode === undefined) throw new Error("The show has no episodes");

  return episode.id;
};

const versionGroup = (target: Page) =>
  target.getByRole("dialog", { name: TRACKS }).getByRole("radiogroup", { name: "Version" });

test("a title with two versions offers them beside Play, which plays the chosen one", async () => {
  await page.goto(moviesPath(`/title/${movieId}`));

  const select = page.getByRole("button", { name: "Version" });

  await expect(select).toContainText("Standard");
  await select.click();
  await expect(page.getByRole("menuitemradio")).toHaveCount(2);
  await capture(page, "05-04-version-select");
  await page.getByRole("menuitemradio", { name: /^Remastered/u }).click();
  await expect(select).toContainText("Remastered");

  const before = streams.length;

  await page.getByRole("link", { name: "Play", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`version=${fileOf("Remastered")}`, "u"));
  await expectPlayingPast(page, 0.5);
  await expect
    .poll(() => streams.slice(before).at(-1))
    .toMatchObject({ mode: "remux", height: 720 });
  await expect.poll(sessionFile).toBe(fileOf("Remastered"));
});

test("the player switches versions in place, keeping the position and the pause", async () => {
  await expectPlayingPast(page, 3);
  await page.getByTestId("player").press("k");
  await expect.poll(async () => (await videoState(page)).paused).toBe(true);

  const position = (await videoState(page)).currentTime;
  const before = streams.length;

  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await capture(page, "07-02c-versions");
  await versionGroup(page)
    .getByRole("radio", { name: /^Standard/u })
    .click();

  await expect
    .poll(() => streams.slice(before).at(-1))
    .toMatchObject({ mode: "direct", height: 360 });
  await expect.poll(sessionFile).toBe(fileOf("Standard"));
  await expectPositionNear(page, position, 0.5);
  expect((await videoState(page)).paused).toBe(true);
  // The switch saves where the old version stopped, not the detached element's 0.
  await expect
    .poll(async () => (await owner.platform.movies.titles.get({ titleId: movieId })).progress)
    .toMatchObject({ positionMs: expect.closeTo(position * 1000, -3) });

  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await expect(versionGroup(page).getByRole("radio", { name: /^Standard/u })).toBeChecked();
  await page.keyboard.press("Escape");

  await page.getByTestId("player").press("k");
  await expectPlayingPast(page, position + 0.5);

  const playingAt = (await videoState(page)).currentTime;

  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await versionGroup(page)
    .getByRole("radio", { name: /^Remastered/u })
    .click();
  await expect.poll(sessionFile).toBe(fileOf("Remastered"));
  await expectPlayingPast(page, playingAt);
});

test("a version the service cannot stream gives way to the one that played", async () => {
  await expectPlayingPast(page, 1);

  const position = (await videoState(page)).currentTime;
  const url = page.url();

  await refuseNextNegotiation(page);
  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await versionGroup(page)
    .getByRole("radio", { name: /^Standard/u })
    .click();

  await expect(page.getByText("This version couldn't play")).toBeVisible();
  await expect.poll(sessionFile).toBe(fileOf("Remastered"));
  await expectPlayingPast(page, position);
  expect(page.url()).toBe(url);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("the person's last version comes back on the title page and in a plain play", async () => {
  await page.goto(moviesPath(`/title/${movieId}`));
  await expect(page.getByRole("button", { name: "Version" })).toContainText("Remastered");

  const before = streams.length;

  await page.goto(moviesPath(`/watch/${movieId}?start=0`));
  await expectPlayingPast(page, 0.5);
  await expect.poll(() => streams.slice(before).at(-1)?.height).toBe(720);
  await expect.poll(sessionFile).toBe(fileOf("Remastered"));
});

test("an episode with two files offers both, on the show's page and in the player", async () => {
  await page.goto(moviesPath(`/title/${showId}`));

  const select = page.getByRole("button", { name: "Version" });

  await expect(select).toContainText("SD H.264");
  await select.click();
  await expect(page.getByRole("menuitemradio", { name: /^720p/u })).toBeVisible();
  await page.keyboard.press("Escape");

  await page.goto(moviesPath(`/watch/${showId}?episodeId=${await firstEpisode()}&start=0`));
  await expectPlayingPast(page, 0.5);
  await revealControls(page);
  await page.getByRole("button", { name: TRACKS }).click();
  await expect(versionGroup(page).getByRole("radio")).toHaveCount(2);
});

test("four columns and thirty-two subtitles stay inside a short full screen and a phone", async ({
  browser,
}) => {
  const episode = await firstEpisode();

  const size = page.viewportSize();

  try {
    await page.setViewportSize({ width: 1280, height: 400 });
    await page.goto(moviesPath(`/watch/${showId}?episodeId=${episode}&start=0`));
    await expectPlayingPast(page, 0.5);
    await page.getByTestId("player").press("k");
    await page.getByTestId("player").press("f");
    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
    await revealControls(page);

    const trigger = page.getByRole("button", { name: TRACKS });

    await trigger.click();

    const menu = page.getByRole("dialog", { name: TRACKS });

    await expect(
      menu.getByRole("radiogroup", { name: "Subtitles" }).getByRole("radio"),
    ).toHaveCount(33);
    expect(
      await menu.evaluate((popup) => document.fullscreenElement?.contains(popup) ?? false),
    ).toBe(true);
    await expectAboveTrigger(page, menu, trigger);

    await Promise.all(
      ["Version", "Audio", "Subtitles", "Quality"].map(async (heading) =>
        expect(menu.getByText(heading, { exact: true })).toBeInViewport({ ratio: 1 }),
      ),
    );

    const subtitles = menu.getByRole("radiogroup", { name: "Subtitles" }).getByRole("radio");

    await subtitles.first().focus();
    await page.keyboard.press("ArrowUp");
    await expect(subtitles.last()).toBeFocused();
    await expect(subtitles.last()).toBeChecked();
    await expect(subtitles.last()).toBeInViewport({ ratio: 1 });
    await expect(menu.getByText("Subtitles", { exact: true })).toBeInViewport({ ratio: 1 });
    await capture(page, "07-02d-many-subtitles");

    await page.keyboard.press("c");
    await expect(subtitles.first()).toBeChecked();
    await expect(subtitles.first()).toBeInViewport({ ratio: 1 });

    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.getByTestId("player")).toBeVisible();
    expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  } finally {
    await page.evaluate(async () => {
      if (document.fullscreenElement !== null) await document.exitFullscreen();
    });

    if (size !== null) await page.setViewportSize(size);
  }

  const handset = await signedInPage(browser, owner.person, { ...devices["iPhone 13 landscape"] });
  const phone = handset.context();

  try {
    await handset.goto(moviesPath(`/watch/${showId}?episodeId=${episode}&start=0`));
    await expectPlayingPast(handset, 0.5);
    await handset.getByTestId("player-video").tap();

    const pill = handset
      .getByRole("button")
      .filter({ has: handset.locator("svg.lucide-captions") });

    await pill.tap();

    const phoneMenu = handset.getByRole("dialog", { name: TRACKS });

    await expect(phoneMenu).toBeVisible();
    await expectAboveTrigger(handset, phoneMenu, pill);
    await handset.setViewportSize(devices["iPhone 13"].viewport);
    await expect
      .poll(async () => (await phoneMenu.boundingBox())?.y ?? -1)
      .toBeGreaterThanOrEqual(0);
    await expectAboveTrigger(handset, phoneMenu, pill);
  } finally {
    await phone.close();
  }
});
