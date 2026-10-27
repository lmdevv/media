#!/usr/bin/env node
// A Chromium that stays open between commands, so a verification can drive the [music] web app
// one step at a time. `serve` starts the host for one side of a run; every other command sends one
// action to it and prints the result. verify-music.sh calls this; agents call it through
// `verify-music.sh browser`.
//
//   node browser.mjs serve --state <dir> --base <url>
//   node browser.mjs <command> --state <dir> [flags]
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ADMIN = { name: "Lucía", email: "admin@music.local", password: "password123" };

// Runs in every page before the app: records each media element that plays, including detached
// ones such as `new Audio()`, so `audio` reports real playback rather than what the UI shows.
const TRACK_MEDIA = `(() => {
  window.musicVerifyMedia = new Set();
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    window.musicVerifyMedia.add(this);
    return play.call(this);
  };
})();`;

const FLAGS = {
  state: { type: "string" },
  base: { type: "string" },
  page: { type: "string", default: "main" },
  device: { type: "string" },
  width: { type: "string" },
  height: { type: "string" },
  dark: { type: "boolean", default: false },
  "show-actions": { type: "boolean", default: false },
  role: { type: "string" },
  name: { type: "string" },
  exact: { type: "boolean", default: false },
  label: { type: "string" },
  text: { type: "string" },
  testid: { type: "string" },
  css: { type: "string" },
  in: { type: "string" },
  nth: { type: "string" },
  value: { type: "string" },
  key: { type: "string" },
  attr: { type: "string" },
  path: { type: "string" },
  full: { type: "boolean", default: false },
  hidden: { type: "boolean", default: false },
  url: { type: "string" },
  timeout: { type: "string" },
  past: { type: "string" },
  advance: { type: "string" },
  js: { type: "string" },
  email: { type: "string" },
  password: { type: "string" },
  music: { type: "string" },
};

const { values: flags, positionals } = parseArgs({
  allowPositionals: true,
  options: FLAGS,
  strict: true,
});
const [command, ...rest] = positionals;
if (!command || !flags.state) {
  console.error("usage: browser.mjs <command> --state <dir> [flags]");
  process.exit(2);
}

if (command === "serve") {
  await serve(flags.state, flags.base);
} else {
  await send(flags.state, command, rest, flags);
}

async function send(state, name, args, options) {
  let port;
  try {
    port = readFileSync(join(state, "browser.port"), "utf8").trim();
  } catch {
    console.error("no browser host for this side; run `verify-music.sh up` first");
    process.exit(1);
  }
  const body = { ...options, command: name, args, cwd: process.cwd() };
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    console.error(`the browser host on port ${port} does not answer: ${error.message}`);
    process.exit(1);
  }
  const result = await response.json();
  if (result.output !== undefined && result.output !== "") console.log(result.output);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
}

async function serve(state, base) {
  if (!base) throw new Error("serve needs --base");
  const { chromium, devices } = await import("@playwright/test");
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({
    executablePath,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  /** @type {Map<string, {context: any, page: any, viewport: any, recording: any}>} */
  const pages = new Map();

  const pageFor = async (options) => {
    const existing = pages.get(options.page);
    if (existing) return existing;
    const device = options.device ? devices[options.device] : undefined;
    if (options.device && !device) throw new Error(`unknown Playwright device "${options.device}"`);
    const viewport =
      options.width && options.height
        ? { width: Number(options.width), height: Number(options.height) }
        : (device?.viewport ?? { width: 1440, height: 900 });
    const context = await browser.newContext({
      ...device,
      viewport,
      baseURL: base,
      colorScheme: options.dark ? "dark" : "light",
    });
    await context.addInitScript({ content: TRACK_MEDIA });
    const page = await context.newPage();
    // Screencast frames come at this size; the device's pixel ratio, up to 2, keeps text sharp.
    const scale = Math.min(device?.deviceScaleFactor ?? 1, 2);
    const frame = { width: viewport.width * scale, height: viewport.height * scale };
    const entry = { context, page, viewport: frame, recording: null };
    pages.set(options.page, entry);
    return entry;
  };

  const locate = (page, options) => {
    let scope = page;
    if (options.in) {
      const [role, ...name] = options.in.split("=");
      scope =
        name.length > 0
          ? page.getByRole(role, { name: name.join("="), exact: true })
          : page.getByRole(role);
    }
    const kinds = ["role", "label", "text", "testid", "css"].filter((kind) => options[kind]);
    if (kinds.length === 0 && options.in) return scope;
    if (kinds.length !== 1) {
      throw new Error("name the element with exactly one of --role, --label, --text, --testid, --css");
    }
    const exact = options.exact;
    let locator;
    if (options.role) {
      locator = scope.getByRole(options.role, options.name ? { name: options.name, exact } : {});
    } else if (options.label) locator = scope.getByLabel(options.label, { exact });
    else if (options.text) locator = scope.getByText(options.text, { exact });
    else if (options.testid) locator = scope.getByTestId(options.testid);
    else locator = scope.locator(options.css);
    return options.nth === undefined ? locator : locator.nth(Number(options.nth));
  };

  const hasLocator = (options) =>
    ["role", "label", "text", "testid", "css", "in"].some((kind) => options[kind]);

  const timeout = (options) => Number(options.timeout ?? 30_000);

  const output = (options, file) => {
    if (!file) throw new Error("this command needs --path");
    const path = resolve(options.cwd, file);
    mkdirSync(dirname(path), { recursive: true });
    return path;
  };

  const played = (page) =>
    page.evaluate(() => {
      const elements = [...(window.musicVerifyMedia ?? [])];
      const playing = elements.filter((element) => !element.paused);
      return {
        playing: playing.length > 0,
        seconds: Math.max(0, ...(playing.length > 0 ? playing : elements).map((e) => e.currentTime)),
        elements: elements.length,
      };
    });

  // Screencast frames go to the system ffmpeg as H.264 MP4, the format GitHub plays in every
  // browser. Frames arrive only when the page changes, so the host paces them itself: it writes
  // the latest frame at a constant FPS for the time that has passed, and a still page holds its
  // last frame until the stop. ffmpeg's wallclock timestamps can't do this: they drop a still
  // tail, its `fps` filter pads the last frame by the gap before it, and probing restamps small
  // frames, so clips ran too short or too long.
  const FPS = 30;
  const pump = (recording) => {
    if (!recording.last || recording.ffmpeg.stdin.destroyed) return;
    const due = Math.floor(((performance.now() - recording.started) / 1000) * FPS) + 1;
    for (; recording.written < due; recording.written += 1) recording.ffmpeg.stdin.write(recording.last);
  };

  const startRecording = async (entry, options) => {
    if (entry.recording) throw new Error("this page is already recording");
    const path = output(options, options.path);
    const ffmpeg = spawn("ffmpeg", [
      "-y", "-loglevel", "error", "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg",
      "-i", "-", "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-preset", "veryfast",
      "-crf", "26", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path,
    ], { stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    ffmpeg.stderr.on("data", (chunk) => (errors += chunk));
    // A missing ffmpeg or one that exits early must fail this recording, not crash the host and
    // lose every signed-in page. Its exit code reports a broken pipe, so stdin errors are dropped.
    ffmpeg.stdin.on("error", () => {});
    const done = new Promise((resolveDone, rejectDone) => {
      ffmpeg.on("error", (error) => rejectDone(new Error(`ffmpeg failed to start: ${error.message}`)));
      ffmpeg.on("close", (code) =>
        code === 0 ? resolveDone() : rejectDone(new Error(`ffmpeg exited ${code}: ${errors}`)),
      );
    });
    done.catch(() => {});
    const recording = { path, ffmpeg, done, actions: null, last: null, started: 0, written: 0, timer: null };
    try {
      if (options["show-actions"]) recording.actions = await entry.page.screencast.showActions();
      recording.timer = setInterval(() => pump(recording), 1000 / FPS);
      await entry.page.screencast.start({
        size: entry.viewport,
        quality: 90,
        onFrame: ({ data }) => {
          // The clip starts at the first frame; each later frame replaces the one being held.
          if (!recording.last) recording.started = performance.now();
          pump(recording);
          recording.last = data;
        },
      });
    } catch (error) {
      clearInterval(recording.timer);
      await recording.actions?.[Symbol.asyncDispose]?.();
      ffmpeg.kill();
      throw error;
    }
    entry.recording = recording;
    return `recording to ${path}`;
  };

  const stopRecording = async (entry) => {
    if (!entry.recording) throw new Error("this page is not recording");
    const recording = entry.recording;
    const { path, ffmpeg, done, actions } = recording;
    entry.recording = null;
    await entry.page.screencast.stop();
    await actions?.[Symbol.asyncDispose]?.();
    clearInterval(recording.timer);
    pump(recording);
    ffmpeg.stdin.end();
    await done;
    return path;
  };

  const navigation = (page) =>
    page
      .getByRole("navigation", { name: "Library" })
      .or(page.getByRole("navigation", { name: "Main" }));

  const commands = {
    async "record-start"(entry, options) {
      return startRecording(entry, options);
    },
    async "record-stop"(entry) {
      return stopRecording(entry);
    },
    async open({ page }, options) {
      await page.goto(options.args[0] ?? "/");
      return page.url();
    },
    async click({ page }, options) {
      await locate(page, options).click({ timeout: timeout(options) });
    },
    async hover({ page }, options) {
      await locate(page, options).hover({ timeout: timeout(options) });
    },
    async fill({ page }, options) {
      await locate(page, options).fill(options.value ?? "", { timeout: timeout(options) });
    },
    async type({ page }, options) {
      await page.keyboard.type(options.value ?? "");
    },
    async press({ page }, options) {
      if (!options.key) throw new Error("press needs --key");
      if (hasLocator(options)) await locate(page, options).press(options.key);
      else await page.keyboard.press(options.key);
    },
    async wait({ page }, options) {
      if (options.url) {
        await page.waitForURL(new RegExp(options.url), { timeout: timeout(options) });
        return page.url();
      }
      await locate(page, options).waitFor({
        state: options.hidden ? "hidden" : "visible",
        timeout: timeout(options),
      });
    },
    async text({ page }, options) {
      return (await locate(page, options).innerText({ timeout: timeout(options) })).trim();
    },
    async count({ page }, options) {
      return String(await locate(page, options).count());
    },
    async attr({ page }, options) {
      if (!options.attr) throw new Error("attr needs --attr");
      return (await locate(page, options).getAttribute(options.attr)) ?? "";
    },
    async snapshot({ page }, options) {
      const target = hasLocator(options) ? locate(page, options) : page.locator("body");
      const tree = await target.ariaSnapshot({ timeout: timeout(options) });
      if (options.path) writeFileSync(output(options, options.path), `${tree}\n`);
      return tree;
    },
    async screenshot({ page }, options) {
      const path = output(options, options.path);
      if (hasLocator(options)) await locate(page, options).screenshot({ path });
      else await page.screenshot({ path, fullPage: options.full });
      return path;
    },
    async audio({ page }) {
      return JSON.stringify(await played(page));
    },
    async "wait-audio"({ page }, options) {
      const start = (await played(page)).seconds;
      const target =
        options.past !== undefined ? Number(options.past) : start + Number(options.advance ?? 1);
      const deadline = Date.now() + timeout(options);
      for (;;) {
        const now = await played(page);
        if (now.playing && now.seconds > target) return JSON.stringify(now);
        if (Date.now() > deadline) {
          throw new Error(`audio did not play past ${target}s: ${JSON.stringify(now)}`);
        }
        await page.waitForTimeout(250);
      }
    },
    async url({ page }) {
      return page.url();
    },
    async eval({ page }, options) {
      if (!options.js) throw new Error("eval needs --js");
      return JSON.stringify(await page.evaluate(options.js));
    },
    async "sign-in"({ page }, options) {
      await page.goto("/sign-in");
      await page.getByLabel("Email").fill(options.email ?? ADMIN.email);
      await page.getByLabel("Password").fill(options.password ?? ADMIN.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await navigation(page).waitFor({ timeout: timeout(options) });
      return page.url();
    },
    async setup({ page }, options) {
      await page.goto("/");
      await page.waitForURL(/\/setup/, { timeout: timeout(options) });
      await page.getByLabel("Name").fill(ADMIN.name);
      await page.getByLabel("Email").fill(ADMIN.email);
      await page.getByLabel("Password").fill(ADMIN.password);
      await page.getByRole("button", { name: "Create admin account" }).click();
      await page.getByRole("heading", { name: "Where's your music?" }).waitFor();
      await page.getByLabel("Library folder").fill(options.music ?? "/music");
      await page.getByRole("button", { name: "Start scanning" }).click();
      await page
        .getByRole("heading", { name: "Your library is ready" })
        .waitFor({ timeout: 300_000 });
      await page.getByRole("button", { name: "Open my library" }).click();
      await page.getByRole("heading", { name: "Recently added" }).waitFor();
      return `signed in as ${ADMIN.email}`;
    },
    async "create-key"({ page }) {
      await page.goto("/settings/keys");
      await page.getByRole("button", { name: "New key" }).click();
      await page.getByLabel("Name").fill("verify-music");
      await page.getByRole("button", { name: "Create key" }).click();
      const key = (await page.getByTestId("new-api-key").textContent())?.trim() ?? "";
      if (!key.startsWith("mk_")) throw new Error(`the new key looks wrong: "${key}"`);
      await page.getByRole("button", { name: "Done" }).click();
      return key;
    },
  };

  const handle = async (options) => {
    if (options.command === "pages") {
      return [...pages.entries()]
        .map(([name, { page, recording }]) => `${name}\t${page.url()}${recording ? "\trecording" : ""}`)
        .join("\n");
    }
    if (options.command === "close-page") {
      const entry = pages.get(options.page);
      if (!entry) throw new Error(`no page named ${options.page}`);
      pages.delete(options.page);
      const saved = entry.recording ? await stopRecording(entry) : null;
      await entry.context.close();
      return saved ? `closed ${options.page}; saved ${saved}` : `closed ${options.page}`;
    }
    const run = commands[options.command];
    if (!run) throw new Error(`unknown command "${options.command}"`);
    return run(await pageFor(options), options);
  };

  const server = createServer((request, response) => {
    // A JSON content type makes a browser preflight a cross-origin request, which this host never
    // answers, so a web page open elsewhere can't drive the signed-in verification pages.
    if (request.method !== "POST" || request.headers["content-type"] !== "application/json") {
      response.writeHead(415).end();
      return;
    }
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", async () => {
      let result;
      try {
        result = { ok: true, output: (await handle(JSON.parse(body || "{}"))) ?? "" };
      } catch (error) {
        result = { ok: false, error: error.message.split("\n").slice(0, 12).join("\n") };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(result));
    });
  });
  server.listen(0, "127.0.0.1", () => {
    const portFile = join(state, "browser.port");
    writeFileSync(`${portFile}.tmp`, String(server.address().port));
    renameSync(`${portFile}.tmp`, portFile);
  });

  const stop = async () => {
    for (const entry of pages.values()) {
      if (entry.recording) await stopRecording(entry).catch(() => {});
      await entry.context.close().catch(() => {});
    }
    await browser.close();
    rmSync(join(state, "browser.port"), { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
