/**
 * The real PlayerProvider against the dev backend, with two browser contexts acting as two
 * devices of one user. Needs `scripts/dev-backend.sh <name> <port>` running.
 *
 * The session page records every audio element its engine creates, so the test can check which
 * device actually outputs audio.
 */
import { DeviceId } from "@music/commands/ids";
import { expect, test } from "@playwright/test";
import type { Browser, Page } from "@playwright/test";

import { mediaPort } from "../harness/config.ts";
import { harnessClient, seedSession } from "../harness/seed.ts";

/** True when any recorded element is playing with its clock moving. */
const outputsAudio = (page: Page): Promise<boolean> =>
  page.evaluate(async () => {
    const elements = [...(window.audioElements ?? [])];

    const playing = (): Array<number> =>
      elements.flatMap((element) => (element.paused ? [] : [element.currentTime]));

    const before = playing();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const after = playing();

    return before.length > 0 && after.some((time, index) => time > (before[index] ?? time));
  });

const field = (page: Page, name: string) => page.getByTestId(name);

const position = async (page: Page): Promise<number> =>
  Number(await field(page, "position").textContent());

const openDevice = async (browser: Browser, tracks: ReadonlyArray<string>): Promise<Page> => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/?tracks=${tracks.join(",")}`);
  await expect(field(page, "device-id")).not.toHaveText("none");
  await expect(field(page, "status")).not.toHaveText("loading");

  return page;
};

/** Presses "Play all" and waits until this page is the active device and outputs audio. */
const playAllHere = async (page: Page): Promise<void> => {
  await page.getByRole("button", { name: "Play all" }).click();
  await expect(field(page, "this-device")).toHaveText("true");
  await expect(field(page, "track")).toHaveText("Song One");
  await expect(field(page, "status")).toHaveText("playing");
  await expect.poll(() => outputsAudio(page)).toBe(true);
};

const setMedia = async (state: "up" | "down"): Promise<void> => {
  await fetch(`http://127.0.0.1:${mediaPort}/control/${state}`, { method: "POST" });
};

let tracks: ReadonlyArray<string> = [];

test.beforeAll(async () => {
  tracks = await seedSession();
});

test.afterEach(async () => {
  await setMedia("up");
});

test("hands playback from one device to another near the same position", async ({ browser }) => {
  const a = await openDevice(browser, tracks);
  const b = await openDevice(browser, tracks);

  await playAllHere(a);
  await expect(field(b, "this-device")).toHaveText("false");
  await expect(field(b, "status")).toHaveText("playing");

  await a.waitForTimeout(4000);
  const before = await position(a);
  const clickedAt = Date.now();
  await b.getByRole("button", { name: "Play here" }).click();

  await expect(field(b, "this-device")).toHaveText("true");
  await expect(field(b, "status")).toHaveText("playing");
  const handoffMs = Date.now() - clickedAt;
  const expected = before + (Date.now() - clickedAt);
  const after = await position(b);

  console.log(
    `handoff: A at ${before} ms, B started at ${after} ms (expected ~${expected}), ` +
      `tap to playing ${handoffMs} ms`,
  );

  expect(Math.abs(after - expected)).toBeLessThan(2000);
  await expect.poll(() => outputsAudio(b)).toBe(true);
  await expect.poll(() => outputsAudio(a)).toBe(false);
  await expect(field(a, "this-device")).toHaveText("false");
  expect(await b.evaluate(() => navigator.mediaSession.metadata?.title)).toBe("Song One");
  expect(await a.evaluate(() => navigator.mediaSession.playbackState)).toBe("none");

  // Remote control: pausing on A pauses the audio on B.
  await a.getByRole("button", { name: "Toggle" }).click();
  await expect(field(b, "status")).toHaveText("paused");
  await expect.poll(() => outputsAudio(b)).toBe(false);
  await expect(field(a, "status")).toHaveText("paused");

  await a.context().close();
  await b.context().close();
});

test("asks for a tap when the browser blocks audio after a handoff", async ({ browser }) => {
  const a = await openDevice(browser, tracks);
  const client = await harnessClient();

  // B must never get a user gesture before the handoff, and every Playwright read of a page
  // grants one. So B gets a known device ID and the test watches it through the server.
  const deviceB = `harness-b-${Date.now()}`;
  const context = await browser.newContext();

  await context.addInitScript((id) => {
    localStorage.setItem("music.deviceId", id);
  }, deviceB);

  const b = await context.newPage();
  await b.goto(`/?tracks=${tracks.join(",")}`);

  await expect
    .poll(async () => (await client.read("devices.list", {})).some((d) => d.id === deviceB))
    .toBe(true);

  await playAllHere(a);
  // The transfer comes from a third device (the server client, as the CLI would send it). In
  // headless Chromium a click in context A also grants user activation to context B, which no
  // real pair of devices would share.
  await client.run("playback.transfer", { deviceId: DeviceId.make(deviceB) });

  // B took over, the browser refused to start audio, and B reported itself paused.
  await expect
    .poll(async () => {
      const state = await client.read("playback.state", {});

      return `${state.activeDevice?.id ?? "none"} ${String(state.playing)}`;
    })
    .toBe(`${deviceB} false`);

  await expect(field(a, "status")).toHaveText("paused");
  await expect.poll(() => outputsAudio(a)).toBe(false);
  await expect(field(b, "autoplay-blocked")).toHaveText("true");
  await expect(field(b, "error")).toHaveText("Tap play to start here");
  expect(await outputsAudio(b)).toBe(false);

  await b.getByRole("button", { name: "Toggle" }).click();
  await expect(field(b, "status")).toHaveText("playing");
  await expect(field(b, "autoplay-blocked")).toHaveText("false");
  await expect.poll(() => outputsAudio(b)).toBe(true);
  await expect(field(a, "status")).toHaveText("playing");

  await a.context().close();
  await context.close();
});

test("preloads the next song, advances without reloading, and reports it", async ({ browser }) => {
  const a = await openDevice(browser, tracks);
  const client = await harnessClient();
  const streamRequests: Array<{ readonly track: string; readonly at: number }> = [];

  a.on("request", (request) => {
    const match = /\/media\/stream\/([^?]+)/u.exec(request.url());

    if (match?.[1] !== undefined) streamRequests.push({ track: match[1], at: Date.now() });
  });

  await playAllHere(a);
  await a.evaluate(() => window.player?.seek(84_000));
  await expect.poll(() => position(a)).toBeGreaterThan(83_000);
  await expect(field(a, "track")).toHaveText("Song Two", { timeout: 15_000 });
  const changedAt = Date.now();

  await expect.poll(async () => (await client.read("playback.state", {})).index).toBe(1);

  await expect(field(a, "status")).toHaveText("playing");
  await expect.poll(() => outputsAudio(a)).toBe(true);

  const second = streamRequests.find((request) => request.track === tracks[1]);

  // The second song was fetched ahead of time, not after the first one ended.
  expect(second).toBeDefined();
  expect(changedAt - (second?.at ?? changedAt)).toBeGreaterThan(2000);
  // The gapless engine plays through one element; HTML audio alternates between two.
  const engine = await field(a, "engine").textContent();

  expect(await a.evaluate(() => window.audioElements?.size)).toBe(engine === "mse" ? 1 : 2);

  await a.context().close();
});

test("repeat one restarts the song at its end", async ({ browser }) => {
  const a = await openDevice(browser, tracks);

  await playAllHere(a);
  await a.evaluate(() => window.player?.setRepeat("one"));
  await a.evaluate(() => window.player?.seek(87_000));
  await expect.poll(() => position(a)).toBeGreaterThan(86_000);
  await expect.poll(() => position(a), { timeout: 10_000 }).toBeLessThan(5000);
  await expect(field(a, "track")).toHaveText("Song One");
  await expect(field(a, "status")).toHaveText("playing");
  await a.evaluate(() => window.player?.setRepeat("off"));

  await a.context().close();
});

test("marks the media service offline and recovers when it returns", async ({ browser }) => {
  const a = await openDevice(browser, tracks);

  await playAllHere(a);

  await setMedia("down");
  await a.getByRole("button", { name: "Next" }).click();
  await expect(field(a, "media-online")).toHaveText("false");
  await expect.poll(() => outputsAudio(a)).toBe(false);

  await setMedia("up");
  await expect(field(a, "media-online")).toHaveText("true", { timeout: 15_000 });
  await expect(field(a, "track")).toHaveText("Song Two");
  await expect(field(a, "status")).toHaveText("playing");
  await expect.poll(() => outputsAudio(a)).toBe(true);

  await a.context().close();
});

test("plays through the gapless MSE engine and switches to HTML audio for data saver", async ({
  browser,
}) => {
  const a = await openDevice(browser, tracks);

  await playAllHere(a);
  await expect(field(a, "engine")).toHaveText("mse");
  await expect.poll(() => outputsAudio(a)).toBe(true);

  // Quality changes apply from the next song, which then plays through HTML audio.
  await a.evaluate(() => {
    window.player?.setQuality("data-saver");
  });
  await expect(field(a, "engine")).toHaveText("mse");
  await a.evaluate(() => window.player?.next());
  await expect(field(a, "track")).toHaveText("Song Two");
  await expect(field(a, "engine")).toHaveText("html");
  await expect(field(a, "status")).toHaveText("playing");
  await expect.poll(() => outputsAudio(a)).toBe(true);

  await a.evaluate(() => {
    window.player?.setQuality("lossless");
  });
  await a.context().close();
});

test("falls back to HTML audio when the gapless stream fails", async ({ browser, request }) => {
  await request.post(`http://127.0.0.1:${mediaPort}/control/fail-fmp4`);

  try {
    const a = await openDevice(browser, tracks);

    await playAllHere(a);
    await expect(field(a, "engine")).toHaveText("html", { timeout: 15_000 });
    await expect(field(a, "status")).toHaveText("playing");
    await expect(field(a, "error")).toHaveText("none");
    await expect.poll(() => outputsAudio(a)).toBe(true);
    await a.context().close();
  } finally {
    await request.post(`http://127.0.0.1:${mediaPort}/control/pass-fmp4`);
  }
});
