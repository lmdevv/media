import { join } from "node:path";

import type { EpisodeId, LibraryId, RoomId, TitleId } from "@media/contracts/ids";
import { RoomId as RoomIdSchema } from "@media/contracts/ids";
import { expect, test } from "@playwright/test";
import type { BrowserContext, Page } from "@playwright/test";
import { Schema } from "effect";

import { NO_STACK, openClient, ownedStack, signInOwner, useSession } from "../admin/session";
import type { Client } from "../admin/session";
import { drawStill } from "../stack/fixture-library";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import { OWNER, createInvite } from "../stack/owner";
import {
  adultProfile,
  capture,
  commandMenu,
  encodeClip,
  episodeNfo,
  expectPlayingPast,
  makeWorkspace,
  movieNfo,
  offline,
  removePath,
  revealControls,
  scanLibrary,
  showNfo,
  titlesByName,
  videoState,
  writeText,
} from "./playback-stack";

const stack = await ownedStack();

test.skip(stack === null, NO_STACK);

test.describe.configure({ mode: "serial" });

const SETUP_TIMEOUT_MS = 240_000;

const MOVE_ON_TIMEOUT_MS = 40_000;

const run = Date.now().toString(36);

const SHOW = "Tide Party";

const EPISODES = [
  { season: 1, episode: 1, name: "Ebb" },
  { season: 1, episode: 2, name: "Flood" },
  { season: 2, episode: 1, name: "Neap" },
  { season: 2, episode: 2, name: "Spring" },
] as const;

const DRIFT = "Drift Line";

const PRIVATE = "Quiet Hours";

const EPISODE_SECONDS = 40;

const GUEST = { name: "Sam", email: `sam-party-${run}@movies.test`, password: "sam-password-1" };

let workspace = "";

let media: MediaService | undefined;

let owner: Client;

let member: Client;

let contexts: ReadonlyArray<BrowserContext> = [];

let host: Page;

let sam: Page;

let second: Page;

let roomId: RoomId;

let showLibrary: LibraryId;

const titles = new Map<string, TitleId>();

const episodes = new Map<string, EpisodeId>();

let driftEpisodes: ReadonlyArray<EpisodeId> = [];

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await makeWorkspace("movies-web-party-");

  const shows = join(workspace, "Shows");
  const restricted = join(workspace, "Private");
  const show = join(shows, `${SHOW} (2022)`);
  const drift = join(shows, `${DRIFT} (2023)`);
  const privateFolder = join(restricted, `${PRIVATE} (2019)`);
  const clip = { seconds: EPISODE_SECONDS, video: "h264", audio: [] } as const;

  await Promise.all([
    writeText(join(show, "tvshow.nfo"), showNfo(SHOW, 2022)),
    ...EPISODES.flatMap(({ season, episode, name }) => {
      const stem = join(
        show,
        `Season 0${String(season)}`,
        `${SHOW} - S0${String(season)}E0${String(episode)}`,
      );

      return [
        encodeClip(`${stem}.mp4`, { ...clip, audio: [{ codec: "aac", language: "eng" }] }),
        writeText(
          `${stem}.nfo`,
          episodeNfo(season, episode, name, {
            plot: `${name}: the harbor turns with the tide.`,
            runtimeMinutes: 42,
          }),
        ),
        drawStill(browser, name, `${stem}-thumb.jpg`),
      ];
    }),
    writeText(join(drift, "tvshow.nfo"), showNfo(DRIFT, 2023)),
    ...[1, 2].flatMap((episode) => {
      const stem = join(drift, "Season 01", `${DRIFT} - S01E0${String(episode)}`);

      return [
        encodeClip(`${stem}.mp4`, { ...clip, audio: [{ codec: "aac", language: "eng" }] }),
        writeText(`${stem}.nfo`, episodeNfo(1, episode, `Drift ${String(episode)}`)),
      ];
    }),
    encodeClip(join(privateFolder, `${PRIVATE} (2019).mp4`), {
      ...clip,
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(privateFolder, "movie.nfo"), movieNfo(PRIVATE, 2019)),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  owner = await signInOwner(stack);

  const [showsId, privateId] = await Promise.all([
    scanLibrary(owner.sdk, {
      name: `Party shows ${run}`,
      kind: "shows",
      root: shows,
      access: "everyone",
    }),
    scanLibrary(owner.sdk, {
      name: `Party private ${run}`,
      kind: "movies",
      root: restricted,
      access: "restricted",
    }),
  ]);

  showLibrary = showsId;

  const scanned = await Promise.all([showsId, privateId].map((id) => titlesByName(owner.sdk, id)));

  for (const byName of scanned) byName.forEach((id, name) => titles.set(name, id));

  const profile = await adultProfile(owner.sdk);

  const seasons = await Promise.all(
    [1, 2].map((seasonNumber) =>
      owner.sdk.query("titles.episodes", {
        profileId: profile.id,
        titleId: titleId(SHOW),
        seasonNumber,
      }),
    ),
  );

  for (const each of seasons.flat()) episodes.set(each.name, each.id);

  driftEpisodes = (
    await owner.sdk.query("titles.episodes", {
      profileId: profile.id,
      titleId: titleId(DRIFT),
      seasonNumber: 1,
    })
  ).map((each) => each.id);

  await removePath(join(drift, "Season 01", `${DRIFT} - S01E02.mp4`));

  const rescan = await owner.sdk.mutate("libraries.scan", { libraryId: showLibrary });

  await expect
    .poll(async () => (await owner.sdk.query("jobs.get", { jobId: rescan.jobId })).status, {
      timeout: 60_000,
    })
    .toBe("succeeded");

  const { invite } = await createInvite(stack, OWNER);

  member = openClient(stack);
  await member.sdk.auth.signInWithPassword({
    flow: "signUp",
    email: GUEST.email,
    password: GUEST.password,
    name: GUEST.name,
    inviteCode: invite.code,
  });

  contexts = await Promise.all([browser.newContext(), browser.newContext(), browser.newContext()]);

  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  const [hostPage, samPage, secondPage] = pages;

  if (hostPage === undefined || samPage === undefined || secondPage === undefined) {
    throw new Error("The browsers did not open");
  }

  host = hostPage;
  sam = samPage;
  second = secondPage;
  await Promise.all([useSession(host, owner), useSession(sam, member), useSession(second, owner)]);
});

test.afterAll(async () => {
  if (stack === null) return;

  await Promise.all(contexts.map((context) => context.close()));
  await owner.sdk.dispose();
  await member.sdk.dispose();
  await media?.stop();
  await removePath(workspace);
});

function titleId(name: string): TitleId {
  const id = titles.get(name);

  if (id === undefined) throw new Error(`${name} was not scanned`);

  return id;
}

function episodeId(name: string): EpisodeId {
  const id = episodes.get(name);

  if (id === undefined) throw new Error(`${SHOW} has no episode ${name}`);

  return id;
}

const guests = (): ReadonlyArray<Page> => [sam, second];

const everyone = (): ReadonlyArray<Page> => [host, sam, second];

const card = (page: Page) => page.getByRole("region", { name: "Next episode" });

const secondsOn = async (page: Page): Promise<number> =>
  Number(await card(page).locator('[data-slot="countdown-seconds"]').textContent());

const roomNow = () => owner.sdk.query("rooms.get", { roomId });

const expectEveryoneOn = async (name: string): Promise<void> => {
  const into = new RegExp(`episodeId=${episodeId(name)}`, "u");

  await Promise.all(
    everyone().map(async (page) => {
      await expect(page).toHaveURL(into, { timeout: MOVE_ON_TIMEOUT_MS });
      await expect(page).toHaveURL(new RegExp(`room=${roomId}`, "u"));
      await expectPlayingPast(page, 0.5);
    }),
  );
};

const SKIP_SECONDS = 10;

const CREDITS_AT = EPISODE_SECONDS * 0.9;

const hostToCredits = async (): Promise<void> => {
  await expectPlayingPast(host, 0.5);

  const player = host.getByTestId("player");

  const skip = async (): Promise<void> => {
    const at = (await videoState(host)).currentTime;

    await player.press("l");
    await expect.poll(async () => (await videoState(host)).currentTime).toBeGreaterThan(at + 5);

    if (at + 2 * SKIP_SECONDS < CREDITS_AT) await skip();
  };

  if ((await videoState(host)).currentTime + SKIP_SECONDS < CREDITS_AT) await skip();
  await player.press("l");
  await expect.poll(async () => (await videoState(host)).currentTime).toBeGreaterThan(CREDITS_AT);
};

test("the host starts a room on the first episode and two guests join it", async () => {
  await host.goto(`/watch/${titleId(SHOW)}?episodeId=${episodeId("Ebb")}&start=0`);
  await expectPlayingPast(host, 3);
  await revealControls(host);
  await host.getByRole("button", { name: "Watch together" }).click();
  await host
    .getByRole("dialog", { name: "Watch together" })
    .getByRole("button", { name: "Start room" })
    .click();
  await expect(host).toHaveURL(/[?&]room=/u);

  await host.waitForTimeout(1_000);
  expect((await videoState(host)).currentTime).toBeGreaterThan(3);
  roomId = Schema.decodeSync(RoomIdSchema)(new URL(host.url()).searchParams.get("room") ?? "");

  await Promise.all(guests().map((page) => page.goto(`/r/${roomId}`)));
  await Promise.all(guests().map((page) => expectPlayingPast(page, 0.5)));
  await expect(host.getByText("Live · 3 watching")).toBeVisible({ timeout: 15_000 });

  await revealControls(host);
  await expect(host.getByRole("button", { name: "Next episode" })).toBeVisible();
  await expect(host.getByRole("button", { name: "Episodes", exact: true })).toBeVisible();

  await Promise.all(
    guests().map(async (page) => {
      await revealControls(page);
      await expect(page.getByRole("button", { name: "Next episode" })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Episodes", exact: true })).toHaveCount(0);
    }),
  );
});

test("the host's credits start one countdown everyone sees, and the room moves on together", async () => {
  await hostToCredits();

  await Promise.all(everyone().map((page) => expect(card(page)).toBeVisible()));
  await expect(card(host).getByRole("button", { name: "Play next" })).toBeFocused();
  await expect(card(host).getByRole("button", { name: "Watch credits" })).toBeVisible();

  await Promise.all(
    guests().map(async (page) => {
      await expect(card(page).getByRole("button", { name: "Play next" })).toHaveCount(0);
      await expect(card(page).getByRole("timer")).toHaveAccessibleName(/^Starts in \d+ seconds?$/u);
      await expect(card(page).getByRole("heading", { name: "Flood" })).toBeVisible();
    }),
  );

  const shown = await Promise.all(everyone().map(secondsOn));

  expect(Math.max(...shown) - Math.min(...shown)).toBeLessThanOrEqual(1);

  const room = await roomNow();

  expect(room.next).toMatchObject({ status: "pending", episode: { id: episodeId("Flood") } });
  await capture(host, "08-20-party-host-card");
  await capture(sam, "08-21-party-guest-card");

  await card(sam).getByRole("button", { name: "Close" }).click();
  await expect(card(sam)).toBeHidden();
  await capture(sam, "08-22-party-guest-closed");
  await expect(card(second)).toBeVisible();
  expect((await roomNow()).next).toMatchObject({ status: "pending" });

  await second.reload();
  await expect(card(second)).toBeVisible({ timeout: 15_000 });
  expect(Math.abs((await secondsOn(second)) - (await secondsOn(host)))).toBeLessThanOrEqual(1);

  await expectEveryoneOn("Flood");

  const moved = await roomNow();

  expect(moved.id).toBe(roomId);
  expect(moved.episode?.id).toBe(episodeId("Flood"));
  expect(moved.next).toBeNull();
  expect(moved.members).toHaveLength(3);
});

test("the host's Play next racing another moves the room on once, into the next season", async () => {
  await hostToCredits();
  await expect(card(host)).toBeVisible();

  const before = await roomNow();

  const fromFlood = { roomId, deviceId: before.hostDeviceId, fromEpisodeId: episodeId("Flood") };

  await card(host).getByRole("button", { name: "Play next" }).click({ timeout: 5_000 });
  await Promise.all([
    owner.sdk.mutate("rooms.playNext", fromFlood),
    owner.sdk.mutate("rooms.playNext", fromFlood),
  ]);
  await expectEveryoneOn("Neap");
  expect((await owner.sdk.mutate("rooms.playNext", fromFlood)).episode?.id).toBe(episodeId("Neap"));
  expect((await roomNow()).episode?.id).toBe(episodeId("Neap"));
});

test("Watch credits cancels the countdown for everyone, and the room stays on the episode", async () => {
  await hostToCredits();
  await Promise.all(everyone().map((page) => expect(card(page)).toBeVisible()));
  await card(host).getByRole("button", { name: "Watch credits" }).click();
  await Promise.all(everyone().map((page) => expect(card(page)).toBeHidden()));
  expect((await roomNow()).next).toStrictEqual({ status: "cancelled" });

  await host.waitForTimeout(12_000);
  expect((await roomNow()).episode?.id).toBe(episodeId("Neap"));

  await Promise.all(
    everyone().map(async (page) => {
      await expect(page).toHaveURL(new RegExp(`episodeId=${episodeId("Neap")}`, "u"));
      await expect(card(page)).toBeHidden();
    }),
  );
});

test("⌘K's Next episode is the host's alone, and moves the whole room on", async () => {
  const ofSam = commandMenu(sam);

  await sam.keyboard.press("ControlOrMeta+k");
  await expect(ofSam.playback.getByRole("option", { name: /^Subtitles/u })).toBeVisible();
  await expect(ofSam.playback.getByRole("option", { name: /^Next episode/u })).toHaveCount(0);
  await expect(ofSam.playback.getByRole("option", { name: /^Episodes/u })).toHaveCount(0);
  await sam.keyboard.press("Escape");
  await expect(ofSam.menu).toBeHidden();

  const ofHost = commandMenu(host);

  await host.keyboard.press("ControlOrMeta+k");
  await ofHost.playback.getByRole("option", { name: /^Next episode/u }).click();
  await expectEveryoneOn("Spring");
});

test("the last episode shows no card, and the host's Episodes picker moves the room back", async () => {
  await hostToCredits();
  await host.waitForTimeout(4_000);

  await Promise.all(everyone().map((page) => expect(card(page)).toHaveCount(0)));
  expect((await roomNow()).next).toBeNull();

  await revealControls(host);
  await host.getByRole("button", { name: "Episodes", exact: true }).click();

  const picker = host.getByRole("dialog", { name: "Episodes" });

  await picker.getByRole("button", { name: "Season 1", exact: true }).click();
  await picker.locator('[data-slot="episode-row"]').filter({ hasText: "Ebb" }).click();
  await expectEveryoneOn("Ebb");
  expect((await roomNow()).next).toBeNull();
});

test("a next episode whose file is missing tells the host, and only the host", async () => {
  const before = await roomNow();
  const [first] = driftEpisodes;

  if (first === undefined) throw new Error(`${DRIFT} has no episodes`);

  await owner.sdk.mutate("rooms.setMedia", {
    roomId,
    deviceId: before.hostDeviceId,
    revision: before.clock.revision,
    titleId: titleId(DRIFT),
    episodeId: first,
  });

  await Promise.all(
    everyone().map(async (page) => {
      await expect(page).toHaveURL(new RegExp(`/watch/${titleId(DRIFT)}\\?`, "u"), {
        timeout: MOVE_ON_TIMEOUT_MS,
      });
      await expectPlayingPast(page, 0.5);
    }),
  );
  await hostToCredits();

  const missing = card(host);

  await expect(missing.locator('[data-slot="next-episode-reason"]')).toHaveText("File missing");
  await expect(missing.getByRole("button", { name: "Play next" })).toHaveCount(0);
  await capture(host, "08-24-party-file-missing");
  await host.waitForTimeout(2_000);

  await Promise.all(guests().map((page) => expect(card(page)).toHaveCount(0)));
  expect((await roomNow()).next).toBeNull();
  await missing.getByRole("button", { name: "Close" }).click();
  await expect(missing).toBeHidden();
});

test("a guest whose profile cannot see what the room moved to keeps their place until it comes back", async () => {
  const before = await roomNow();

  await owner.sdk.mutate("rooms.setMedia", {
    roomId,
    deviceId: before.hostDeviceId,
    revision: before.clock.revision,
    titleId: titleId(PRIVATE),
  });

  await expect(sam.getByRole("heading", { name: "Not available on this profile" })).toBeVisible({
    timeout: MOVE_ON_TIMEOUT_MS,
  });
  await expect(sam.getByText(PRIVATE)).toHaveCount(0);
  await capture(sam, "08-23-party-not-available");

  await expect(second).toHaveURL(new RegExp(`/watch/${titleId(PRIVATE)}\\?room=${roomId}`, "u"), {
    timeout: MOVE_ON_TIMEOUT_MS,
  });
  await expectPlayingPast(second, 0.5);
  await expect
    .poll(
      async () =>
        (await roomNow()).members.find((each) => each.profileName === GUEST.name)?.presence,
      { timeout: 30_000 },
    )
    .toBe("away");

  const moved = await roomNow();

  await owner.sdk.mutate("rooms.setMedia", {
    roomId,
    deviceId: moved.hostDeviceId,
    revision: moved.clock.revision,
    titleId: titleId(SHOW),
    episodeId: episodeId("Flood"),
  });
  await expectEveryoneOn("Flood");
});
