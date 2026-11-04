import { join } from "node:path";

import {
  HEARTBEAT_INTERVAL_MS,
  HOST_PRESENCE_TIMEOUT_MS,
  PLAYER_SILENCE_MS,
} from "@media/contracts/clock";
import { DeviceId, RoomId } from "@media/contracts/ids";
import type { TitleId } from "@media/contracts/ids";
import { Milliseconds } from "@media/contracts/units";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { Schema } from "effect";

import { NO_STACK, openClient, ownedStack, signInOwner, useSession } from "../admin/session";
import type { Client } from "../admin/session";
import { buildMediaService, startMediaService } from "../stack/media-service";
import type { MediaService } from "../stack/media-service";
import { OWNER, createInvite } from "../stack/owner";
import {
  adultProfile,
  capture,
  clickScrubber,
  commandMenu,
  driftMs,
  encodeClip,
  expectPlayingPast,
  holdSegments,
  leaveDialog,
  leaveWithEscape,
  makeWorkspace,
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

const run = Date.now().toString(36);

const SHARED = "Harbor Lights";

const PRIVATE = "Quiet Hours";

const NEXT = "Night Ferry";

const FILM_SECONDS = 360;

const SETTLED_MS = 150;

const REPORT_AFTER_MS = 2 * HEARTBEAT_INTERVAL_MS;

const GUEST = { name: "Sam", email: `sam-rooms-${run}@movies.test`, password: "sam-password-1" };

let workspace = "";

let media: MediaService | undefined;

let owner: Client;

let member: Client;

let hostContext: BrowserContext;

let guestContext: BrowserContext;

let host: Page;

let guest: Page;

let roomId: RoomId;

const titles = new Map<string, TitleId>();

const drifts: Array<{
  readonly when: string;
  readonly ms: number;
  readonly guestReportedMs: number | null;
}> = [];

test.beforeAll(async ({ browser }) => {
  if (stack === null) return;

  test.setTimeout(SETUP_TIMEOUT_MS);
  workspace = await makeWorkspace("movies-web-rooms-");

  const shared = join(workspace, "Shared");
  const restricted = join(workspace, "Private");
  const sharedFolder = join(shared, `${SHARED} (2020)`);
  const nextFolder = join(shared, `${NEXT} (2021)`);
  const privateFolder = join(restricted, `${PRIVATE} (2019)`);

  await Promise.all([
    encodeClip(join(sharedFolder, `${SHARED} (2020).ts`), {
      seconds: FILM_SECONDS,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(sharedFolder, "movie.nfo"), movieNfo(SHARED, 2020)),
    encodeClip(join(nextFolder, `${NEXT} (2021).mp4`), {
      seconds: 240,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(nextFolder, "movie.nfo"), movieNfo(NEXT, 2021)),
    encodeClip(join(privateFolder, `${PRIVATE} (2019).mp4`), {
      seconds: 20,
      video: "h264",
      audio: [{ codec: "aac", language: "eng" }],
    }),
    writeText(join(privateFolder, "movie.nfo"), movieNfo(PRIVATE, 2019)),
  ]);

  buildMediaService();
  media = await startMediaService(offline(stack), [workspace]);
  owner = await signInOwner(stack);

  const libraries = await Promise.all([
    scanLibrary(owner.sdk, {
      name: `Shared films ${run}`,
      kind: "movies",
      root: shared,
      access: "everyone",
    }),
    scanLibrary(owner.sdk, {
      name: `Private films ${run}`,
      kind: "movies",
      root: restricted,
      access: "restricted",
    }),
  ]);

  const scanned = await Promise.all(libraries.map((id) => titlesByName(owner.sdk, id)));

  for (const byName of scanned) byName.forEach((id, name) => titles.set(name, id));

  const { invite } = await createInvite(stack, OWNER);

  member = openClient(stack);
  await member.sdk.auth.signInWithPassword({
    flow: "signUp",
    email: GUEST.email,
    password: GUEST.password,
    name: GUEST.name,
    inviteCode: invite.code,
  });

  hostContext = await browser.newContext();
  guestContext = await browser.newContext();
  host = await hostContext.newPage();
  guest = await guestContext.newPage();
  await useSession(host, owner);
  await useSession(guest, member);
});

test.afterAll(async () => {
  if (stack === null) return;

  test.info().annotations.push({
    type: "drift",
    description: drifts
      .map(
        ({ when, ms, guestReportedMs }) =>
          `${when} ${String(ms)} ms (guest ${String(guestReportedMs)})`,
      )
      .join(", "),
  });

  console.log(`Room drift after settling: ${JSON.stringify(drifts)}`);
  await hostContext.close();
  await guestContext.close();
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

const expectSettled = async (when: string): Promise<void> => {
  await expect
    .poll(async () => Math.abs(await driftMs(host, guest)), { timeout: 30_000 })
    .toBeLessThanOrEqual(SETTLED_MS);
  await host.waitForTimeout(REPORT_AFTER_MS);

  const settled = await driftMs(host, guest);

  const room = await owner.sdk.query("rooms.get", { roomId });

  const guestReportedMs =
    room.members.find((each) => each.profileName === GUEST.name)?.driftMs ?? null;

  drifts.push({ when, ms: settled, guestReportedMs });
  expect(Math.abs(settled)).toBeLessThanOrEqual(SETTLED_MS);
};

const startRoom = async (page: Page): Promise<RoomId> => {
  await revealControls(page);
  await page.getByRole("button", { name: "Watch together" }).click();

  const dialog = page.getByRole("dialog", { name: "Watch together" });

  await expect(dialog.getByLabel("Room link")).toContainText("/r/");
  await capture(page, "08-01-start-a-room");
  await dialog.getByRole("button", { name: "Start room" }).click();
  await expect(page).toHaveURL(/[?&]room=/u);

  const id = new URL(page.url()).searchParams.get("room");

  if (id === null) throw new Error("The player did not join the room it started");

  return Schema.decodeSync(RoomId)(id);
};

const roomPill = (page: Page) => page.getByRole("link", { name: /^Room · \d+: return to /u });

const browseAway = async (page: Page): Promise<void> => {
  await revealControls(page);
  await page.getByRole("button", { name: "Back to details" }).click();
  await expect(page).toHaveURL(/\/title\//u);
};

const memberNamed = async (profileName: string) => {
  const room = await owner.sdk.query("rooms.get", { roomId });
  const found = room.members.find((each) => each.profileName === profileName);

  if (found === undefined) throw new Error(`${profileName} is not in the room`);

  return found;
};

const guestDeviceId = async () => {
  const room = await owner.sdk.query("rooms.get", { roomId });
  const self = room.members.find((each) => each.profileName === GUEST.name);

  if (self === undefined) throw new Error(`${GUEST.name} is not in the room`);

  return { deviceId: self.deviceId, revision: room.clock.revision };
};

test("the host starts a room and a late guest lands on the live position", async () => {
  await host.goto(`/watch/${titleId(SHARED)}?start=0`);
  await expectPlayingPast(host, 3);
  roomId = await startRoom(host);
  await expect(host.getByText("Live · 1 watching")).toBeVisible();

  await expectPlayingPast(host, 8);
  await guest.goto(`/r/${roomId}`);
  await expect(guest).toHaveURL(new RegExp(`/watch/${titleId(SHARED)}\\?room=${roomId}`, "u"));
  await expectPlayingPast(guest, 8);
  await expectSettled("late join");

  await expect(host.getByText("Live · 2 watching")).toBeVisible();
  await expect(
    host.getByRole("region", { name: "Watching together" }).getByText(GUEST.name),
  ).toBeVisible();
  await revealControls(host);
  await capture(host, "08-02-host-view");
});

test("the host's pause and seek reach the guest", async () => {
  await host.getByTestId("player").press("k");
  await expect.poll(async () => (await videoState(guest)).paused).toBe(true);
  await expect(guest.getByText("Room paused · 2 watching")).toBeVisible();

  const paused = await videoState(host);

  await expect
    .poll(async () => Math.abs((await videoState(guest)).currentTime - paused.currentTime))
    .toBeLessThanOrEqual(SETTLED_MS / 1000);

  await host.getByTestId("player").press("l");
  await expect
    .poll(async () => (await videoState(guest)).currentTime, { timeout: 15_000 })
    .toBeGreaterThan(paused.currentTime + 8);
  expect((await videoState(guest)).paused).toBe(true);

  await host.getByTestId("player").press(" ");
  await expect.poll(async () => (await videoState(guest)).paused).toBe(false);
  await expectSettled("after host seek and play");
});

test("a guest's controls are locked, and the server refuses a guest's command", async () => {
  await revealControls(guest);
  await expect(guest.getByText(`Only ${OWNER.name} can pause or seek`)).toBeVisible();
  await capture(guest, "08-04-guest-view");

  const before = await videoState(guest);

  await guest.getByTestId("player").press(" ");
  await guest.getByTestId("player").press("l");
  await guest.waitForTimeout(1_000);

  const after = await videoState(guest);

  expect(after.paused).toBe(false);
  expect(after.currentTime - before.currentTime).toBeLessThan(3);
  expect((await videoState(host)).paused).toBe(false);

  const { deviceId, revision } = await guestDeviceId();

  await expect(
    member.sdk.mutate("rooms.pause", {
      roomId,
      deviceId,
      revision,
      positionMs: Milliseconds.make(0),
    }),
  ).rejects.toHaveProperty("_tag", "Forbidden");
});

test("⌘K and Escape in a room: each side gets its own commands, and asking never pauses the room", async () => {
  const onRoom = new RegExp(`[?&]room=${roomId}`, "u");

  const ofGuest = commandMenu(guest);

  await guest.keyboard.press("ControlOrMeta+k");

  await Promise.all(
    [/^Subtitles/u, /^Audio/u, /^Quality/u, /^Stream info/u, /^Full screen/u].map((name) =>
      expect(ofGuest.playback.getByRole("option", { name })).toBeVisible(),
    ),
  );

  await expect(ofGuest.playback.getByRole("option", { name: /^(Pause|Play)\b/u })).toHaveCount(0);
  await expect(ofGuest.playback.getByRole("option", { name: /^Back 10 seconds/u })).toHaveCount(0);

  const guestRoom = ofGuest.menu.getByRole("group", { name: "Room" });

  await expect(guestRoom.getByRole("option", { name: /^Copy room link/u })).toBeVisible();
  await expect(guestRoom.getByRole("option", { name: /^Leave room/u })).toBeVisible();
  await expect(guestRoom.getByRole("option", { name: /^End room/u })).toHaveCount(0);
  await capture(guest, "08-08-guest-command-menu");
  await guest.keyboard.press("Escape");
  await expect(ofGuest.menu).toBeHidden();

  const ofHost = commandMenu(host);

  await host.keyboard.press("ControlOrMeta+k");

  await Promise.all(
    [/^Pause/u, /^Back 10 seconds/u, /^Subtitles/u, /^Audio/u, /^Quality/u].map((name) =>
      expect(ofHost.playback.getByRole("option", { name })).toBeVisible(),
    ),
  );

  const hostRoom = ofHost.menu.getByRole("group", { name: "Room" });

  await expect(hostRoom.getByRole("option", { name: /^Copy room link/u })).toBeVisible();
  await expect(hostRoom.getByRole("option", { name: /^End room/u })).toBeVisible();
  await expect(hostRoom.getByRole("option", { name: /^Leave room/u })).toHaveCount(0);
  await host.keyboard.press("Escape");
  await expect(ofHost.menu).toBeHidden();

  const askThenStay = async (page: Page, other: Page): Promise<void> => {
    await page.getByTestId("player").press("Escape");
    await expect(leaveDialog(page)).toBeVisible();
    await page.waitForTimeout(1_000);
    expect((await videoState(page)).paused).toBe(false);
    expect((await videoState(other)).paused).toBe(false);
    expect((await owner.sdk.query("rooms.get", { roomId })).clock.status).toBe("playing");
    await leaveDialog(page).getByRole("button", { name: "Stay" }).click();
    await expect(leaveDialog(page)).toBeHidden();
    await expect(page).toHaveURL(onRoom);
  };

  await askThenStay(guest, host);
  await askThenStay(host, guest);

  await leaveWithEscape(guest);
  await expect(guest).toHaveURL(new RegExp(`/title/${titleId(SHARED)}$`, "u"));
  await host.waitForTimeout(1_000);
  expect((await videoState(host)).paused).toBe(false);
  await expect(host).toHaveURL(onRoom);
  expect((await owner.sdk.query("rooms.get", { roomId })).clock.status).toBe("playing");
  await guest.goto(`/r/${roomId}`);
  await expect(guest).toHaveURL(onRoom);
  await expectSettled("after the guest came back");
});

test("the host's stall holds the guest until the host plays again", async () => {
  const release = await holdSegments(host);

  await clickScrubber(host, 0.8);
  await expect(guest.getByText(`Waiting for ${OWNER.name}'s connection`)).toBeVisible({
    timeout: 15_000,
  });
  await expect
    .poll(
      async () => {
        const state = await videoState(guest);

        return state.paused && state.currentTime > FILM_SECONDS * 0.7;
      },
      { timeout: 15_000 },
    )
    .toBe(true);
  await capture(guest, "08-05-host-buffering");

  await release();
  await expect(guest.getByText(`Waiting for ${OWNER.name}'s connection`)).toBeHidden({
    timeout: 20_000,
  });
  await expectPlayingPast(host, FILM_SECONDS * 0.8);
  await expectPlayingPast(guest, FILM_SECONDS * 0.8);
  await expectSettled("after host stall");
});

test("a guest who stalls catches up without moving the host", async () => {
  await clickScrubber(host, 0.1);
  await expectSettled("after host seek back");

  const release = await holdSegments(guest);
  const hostBefore = await videoState(host);

  await guest.reload();
  await expect(guest.getByText(`Syncing to ${OWNER.name}`)).toBeVisible({ timeout: 15_000 });
  await capture(guest, "08-03-guest-joining");
  await guest.waitForTimeout(4_000);

  const hostDuring = await videoState(host);

  expect(hostDuring.paused).toBe(false);
  expect(hostDuring.currentTime - hostBefore.currentTime).toBeGreaterThan(3);
  await expect(host.getByText("Live · 2 watching")).toBeVisible();

  await release();
  await expectPlayingPast(guest, hostDuring.currentTime);
  await expectSettled("after guest stall");
});

test("a guest who browses away keeps their place, and the navbar pill takes them back", async () => {
  await browseAway(guest);
  await expect(roomPill(guest)).toHaveText("Room · 2");
  await expect(roomPill(guest)).toHaveAccessibleName(`Room · 2: return to ${SHARED}`);

  await expect
    .poll(async () => (await memberNamed(GUEST.name)).presence, {
      timeout: PLAYER_SILENCE_MS + 3 * HEARTBEAT_INTERVAL_MS,
    })
    .toBe("away");
  expect((await memberNamed(GUEST.name)).driftMs).toBeNull();
  await expect(
    host.getByRole("region", { name: "Watching together" }).getByText("away", { exact: true }),
  ).toBeVisible();
  await revealControls(host);
  await capture(host, "08-11-member-away");

  const heard = (await memberNamed(GUEST.name)).lastSeenAt;

  await expect
    .poll(async () => (await memberNamed(GUEST.name)).lastSeenAt, {
      timeout: 4 * HEARTBEAT_INTERVAL_MS,
    })
    .toBeGreaterThan(heard);

  await guest.getByRole("link", { name: "[movies] home" }).click();
  await expect(roomPill(guest)).toBeVisible();
  await capture(guest, "08-09-room-pill");

  await guest.setViewportSize({ width: 390, height: 844 });
  await expect(roomPill(guest)).toHaveText("2");
  await capture(guest, "08-10-room-pill-phone");
  await guest.goBack();
  await expect(guest).toHaveURL(/\/title\//u);
  await expect(roomPill(guest)).toHaveText("2");
  await capture(guest, "08-10b-room-pill-phone-title");
  await guest.goto("/collections");
  await expect(roomPill(guest)).toHaveText("2");
  await guest.setViewportSize({ width: 1440, height: 900 });

  await guest.reload();
  await roomPill(guest).click();
  await expect(guest).toHaveURL(new RegExp(`/watch/${titleId(SHARED)}\\?room=${roomId}`, "u"));
  await expectSettled("after a guest came back");
  await expect(host.getByText("Live · 2 watching")).toBeVisible();
  expect((await memberNamed(GUEST.name)).presence).toBe("watching");
});

test("the host browses away, the guest keeps watching, and the host comes back to the live position", async () => {
  test.setTimeout(90_000);
  await browseAway(host);
  await expect(roomPill(host)).toBeVisible();

  const before = await videoState(guest);

  await guest.waitForTimeout(HOST_PRESENCE_TIMEOUT_MS + 5_000);

  const during = await videoState(guest);
  const room = await owner.sdk.query("rooms.get", { roomId });

  expect(during.paused).toBe(false);
  expect(during.currentTime - before.currentTime).toBeGreaterThan(HOST_PRESENCE_TIMEOUT_MS / 1000);
  expect(room.hostAway).toBe(false);
  expect(room.clock.status).toBe("playing");
  expect((await memberNamed(OWNER.name)).presence).toBe("away");
  await expect(guest.getByRole("heading", { name: `${OWNER.name} left the room` })).toBeHidden();

  await roomPill(host).focus();
  await host.keyboard.press("Enter");
  await expect(host).toHaveURL(new RegExp(`/watch/${titleId(SHARED)}\\?room=${roomId}`, "u"));
  await expectPlayingPast(host, during.currentTime);
  await expectSettled("after the host came back");
  expect((await videoState(guest)).currentTime).toBeGreaterThan(during.currentTime);
});

test("a room that moved to another film while everyone browsed returns to the new one", async () => {
  await browseAway(host);
  await browseAway(guest);
  await expect(roomPill(guest)).toHaveAccessibleName(`Room · 2: return to ${SHARED}`);

  const room = await owner.sdk.query("rooms.get", { roomId });

  await owner.sdk.mutate("rooms.setMedia", {
    roomId,
    deviceId: room.hostDeviceId,
    revision: room.clock.revision,
    titleId: titleId(NEXT),
  });
  await expect(roomPill(guest)).toHaveAccessibleName(`Room · 2: return to ${NEXT}`);
  await expect(roomPill(host)).toHaveAccessibleName(`Room · 2: return to ${NEXT}`);

  const into = new RegExp(`/watch/${titleId(NEXT)}\\?room=${roomId}`, "u");

  await roomPill(guest).click();
  await expect(guest).toHaveURL(into);
  await roomPill(host).click();
  await expect(host).toHaveURL(into);
  await expectPlayingPast(host, 2);
  await expectPlayingPast(guest, 2);
  await expectSettled("after the room moved to another film");
});

test("the pill shows only on the device and profile in the room", async ({
  browser,
}: {
  readonly browser: Browser;
}) => {
  const elsewhere = await browser.newContext();
  const other = await elsewhere.newPage();

  await useSession(other, owner);
  await other.goto("/");
  await expect(other.getByRole("button", { name: /switch profile$/u })).toBeVisible();
  await other.waitForTimeout(2_000);
  await expect(roomPill(other)).toHaveCount(0);
  await elsewhere.close();

  const spare = await owner.sdk.mutate("profiles.create", {
    name: `Spare ${run}`,
    avatar: "green",
    kids: false,
  });

  await browseAway(host);
  await expect(roomPill(host)).toBeVisible();
  await host.goto("/profiles");
  await host.getByRole("button", { name: spare.name }).click();
  await expect(host).toHaveURL(/\/$/u);
  await host.waitForTimeout(2_000);
  await expect(roomPill(host)).toHaveCount(0);

  await host.goto("/profiles");
  await host.getByRole("button", { name: (await adultProfile(owner.sdk)).name }).click();
  await roomPill(host).click();
  await expect(host).toHaveURL(new RegExp(`\\?room=${roomId}`, "u"));
  await expectSettled("after switching profiles");
  await owner.sdk.mutate("profiles.remove", { profileId: spare.id });
});

test("a guest who plays another film alone keeps their place in the room, away", async () => {
  test.setTimeout(90_000);
  await guest.goto(`/watch/${titleId(SHARED)}?start=0`);
  await expectPlayingPast(guest, 1);
  await expect
    .poll(async () => (await memberNamed(GUEST.name)).presence, {
      timeout: PLAYER_SILENCE_MS + 3 * HEARTBEAT_INTERVAL_MS,
    })
    .toBe("away");

  await guest.goto(`/r/${roomId}`);
  await expect(guest).toHaveURL(new RegExp(`\\?room=${roomId}`, "u"));
  await expectSettled("after playing another film alone");
});

test("the host going away pauses the room for the guest, who can keep watching alone", async () => {
  test.setTimeout(90_000);
  await host.close();

  await expect(guest.getByRole("heading", { name: `${OWNER.name} left the room` })).toBeVisible({
    timeout: 45_000,
  });
  await expect(guest.getByText(/^Paused for everyone at \d+:\d\d\.$/u)).toBeVisible();
  await capture(guest, "08-06-host-left");
  await expect.poll(async () => (await videoState(guest)).paused).toBe(true);

  const stopped = (await videoState(guest)).currentTime;

  await guest.getByRole("button", { name: "Keep watching on my own" }).click();
  await expect(guest).not.toHaveURL(/[?&]room=/u);
  await expectPlayingPast(guest, stopped + 1);
});

test("an ended room and another household's room deny their links", async ({
  browser,
}: {
  readonly browser: Browser;
}) => {
  host = await hostContext.newPage();
  await host.goto(`/watch/${titleId(SHARED)}?start=0`);
  await expectPlayingPast(host, 1);

  const second = await startRoom(host);

  await guest.goto(`/r/${second}`);
  await expectPlayingPast(guest, 1);
  await host.getByRole("button", { name: "End room" }).click();
  await expect(host).not.toHaveURL(/[?&]room=/u);

  const ended = (await videoState(host)).currentTime;

  await expectPlayingPast(host, ended + 1);
  await expect(guest.getByRole("heading", { name: `${OWNER.name} left the room` })).toBeVisible({
    timeout: 15_000,
  });

  await guest.goto(`/r/${second}`);
  await expect(guest.getByRole("heading", { name: "This room has ended" })).toBeVisible();
  await expect(guest.getByText(`${OWNER.name} closed this room.`)).toBeVisible();
  await capture(guest, "08-07a-join-denied-ended");

  const profile = await adultProfile(owner.sdk);

  const hidden = await owner.sdk.mutate("rooms.create", {
    profileId: profile.id,
    deviceId: Schema.decodeSync(DeviceId)(`e2e-${run}`),
    titleId: titleId(PRIVATE),
    positionMs: Milliseconds.make(0),
  });

  const stranger = await browser.newContext();
  const visitor = await stranger.newPage();

  await useSession(visitor, member);
  await visitor.goto(`/r/${hidden.id}`);
  await expect(
    visitor.getByRole("heading", { name: "This room is for another household" }),
  ).toBeVisible();
  await capture(visitor, "08-07b-join-denied-household");
  await stranger.close();
});

test("ending the room takes the pill away from a guest who browsed off", async () => {
  const last = await startRoom(host);

  await guest.goto(`/r/${last}`);
  await expectPlayingPast(guest, 1);
  await browseAway(guest);
  await expect(roomPill(guest)).toBeVisible();

  await host.getByRole("button", { name: "End room" }).click();
  await expect(roomPill(guest)).toHaveCount(0);

  await guest.keyboard.press("ControlOrMeta+k");
  await expect(guest.getByRole("combobox")).toBeVisible();
  await expect(guest.getByRole("option", { name: /Return to room/u })).toHaveCount(0);
  await guest.keyboard.press("Escape");
});
