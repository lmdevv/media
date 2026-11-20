#!/usr/bin/env node
// A Chromium that stays open between commands, so a verification can drive the Lar web apps
// one step at a time. `serve` starts the host for one side of a run; every other
// command sends one action to it and prints the result. Each page belongs to one app, picked with
// --app when the page is created. verify-media.sh calls this; agents call it through
// `verify-media.sh browser`.
//
//   node browser.mjs serve --state <dir> --base <movies url> --account <url> [--music <url>]
//   node browser.mjs <command> --state <dir> [--app movies|music|account] [flags]
//
// The movies client has no sign-in of its own: it uses the session the account client at
// --account keeps, so movies pages sign in, set up, invite, and join there. --music is the image's
// own music client (`<base>/music`), on that same session and port.
//
// Where the host allows it, the browser runs in a private network namespace (see `isolate`),
// because Chromium cancels its queued requests whenever any host interface gains or loses an
// address, which every Docker container start and stop does. MEDIA_VERIFY_BROWSER_NETWORK picks
// `auto` (the default: isolated when possible), `isolated` (or fail), or `host`.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const OWNER = { username: "lucia", password: "password123" };
const APPS = ["movies", "music", "account"];

// Every socket lives in the side's state folder and is named relative to it: a socket address
// holds at most 107 bytes, which a long TMPDIR and run name can pass.
const SOCKETS = { control: "browser.sock", web: "web.sock", proxy: "proxy.sock" };
const NETWORK_CHANGED = "net::ERR_NETWORK_CHANGED";
// How long a command may take on the host. With --timeout, each of its waits stops then and the
// host answers right after; without it, setup waits for whole first scans.
const REPLY_GRACE_MS = 1_000;
const COMMAND_MS = 300_000;
const SETUP_MS = 1_200_000;
// The status timeout(1) exits with, so verify-media.sh treats a silent host as a step out of time.
const TIMED_OUT = 124;
const PRIVATE_NETWORK = fileURLToPath(new URL("../../../../scripts/private-network.sh", import.meta.url));
// The scripted Chromecast the web clients' Playwright suites cast to, which `--cast-fake` puts in a
// new page in place of Google's Cast SDK. Node strips its types as it loads it.
const CAST_FAKE = new URL("../../../../apps/web/movies/e2e/playback/cast-fake.ts", import.meta.url);
const CAST_ACTIONS = ["devicesAppear", "holdConnection", "completeConnection", "finish", "fail", "disconnect", "refetch"];
const NETWORKS = ["auto", "isolated", "host"];
// A relay must carry each direction's end on its own: a client may finish its request and still
// wait for the response.
const HALF_OPEN = { allowHalfOpen: true };

// Runs in every page before the app: records each media element that plays, including detached
// ones, so `video` reports real playback rather than what the player's buttons show.
const TRACK_MEDIA = `(() => {
  window.mediaVerifyMedia = new Set();
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    window.mediaVerifyMedia.add(this);
    return play.call(this);
  };
})();`;

const FLAGS = {
  state: { type: "string" },
  base: { type: "string" },
  account: { type: "string" },
  music: { type: "string" },
  "music-folder": { type: "string" },
  app: { type: "string" },
  page: { type: "string" },
  "tab-of": { type: "string" },
  "cast-fake": { type: "boolean", default: false },
  device: { type: "string" },
  width: { type: "string" },
  height: { type: "string" },
  dark: { type: "boolean", default: false },
  light: { type: "boolean", default: false },
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
  button: { type: "string" },
  attr: { type: "string" },
  path: { type: "string" },
  full: { type: "boolean", default: false },
  hidden: { type: "boolean", default: false },
  url: { type: "string" },
  timeout: { type: "string" },
  past: { type: "string" },
  advance: { type: "string" },
  js: { type: "string" },
  username: { type: "string" },
  password: { type: "string" },
  movies: { type: "string" },
  shows: { type: "string" },
  code: { type: "string" },
  "invite-role": { type: "string" },
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
if (flags.timeout !== undefined && !(Number(flags.timeout) >= 0)) {
  console.error(`--timeout must be milliseconds, not "${flags.timeout}"`);
  process.exit(2);
}
if (flags.app !== undefined && !APPS.includes(flags.app)) {
  console.error(`--app must be ${APPS.join(" or ")}, not "${flags.app}"`);
  process.exit(2);
}
flags.page ??= flags.app === "music" || flags.app === "account" ? flags.app : "main";

if (command === "serve") {
  await serve(flags);
} else if (command === "serve-inside") {
  await serveInside(flags);
} else {
  await send(flags.state, command, rest, flags);
}

async function send(state, name, args, options) {
  const body = JSON.stringify({ ...options, command: name, args, cwd: process.cwd() });
  if (!existsSync(join(state, SOCKETS.control))) {
    console.error("no browser host for this side; run `verify-media.sh up` first");
    process.exit(1);
  }
  process.chdir(state);
  const limit =
    options.timeout !== undefined ? Number(options.timeout) + REPLY_GRACE_MS : name === "setup" ? SETUP_MS : COMMAND_MS;
  let result;
  let timer;
  try {
    result = await new Promise((resolveResult, rejectResult) => {
      const request = httpRequest({ socketPath: SOCKETS.control, method: "POST", path: "/" }, (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("end", () => resolveResult(JSON.parse(text)));
        response.on("error", rejectResult);
      });
      timer = setTimeout(() => {
        const error = new Error(`it did not answer \`${name}\` within ${limit} ms`);
        error.timedOut = true;
        rejectResult(error);
        request.destroy();
      }, limit);
      request.on("error", rejectResult);
      request.end(body);
    });
  } catch (error) {
    console.error(`the browser host does not answer on ${join(state, SOCKETS.control)}: ${error.message}`);
    process.exit(error.timedOut === true ? TIMED_OUT : 1);
  } finally {
    clearTimeout(timer);
  }
  if (result.output !== undefined && result.output !== "") console.log(result.output);
  if (!result.ok) {
    console.error(result.error);
    process.exit(1);
  }
}

function pipe(a, b) {
  a.pipe(b).pipe(a);
  a.on("error", () => b.destroy());
  b.on("error", () => a.destroy());
}

function listen(server, ...address) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(...address, () => resolveListen(server));
  });
}

function chromiumPid() {
  if (process.platform !== "linux") return "";
  const cmdline = (pid) => {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      return "";
    }
  };
  const children = readFileSync(`/proc/self/task/${process.pid}/children`, "utf8").trim().split(" ");
  return children.find((pid) => cmdline(pid).includes("--remote-debugging-pipe")) ?? "";
}

function portOf(url, name) {
  const port = Number(new URL(url).port);
  if (!port) throw new Error(`serve needs --${name} with an explicit port, not ${url}`);
  return port;
}

// Why this host can't give the browser a private network namespace, or null when it can.
function namespaceUnavailable() {
  if (process.platform !== "linux") return `${process.platform} has no network namespaces`;
  const probe = spawnSync(PRIVATE_NETWORK, ["true"], { encoding: "utf8" });
  if (probe.error) return `scripts/private-network.sh did not run (${probe.error.message})`;
  if (probe.status === 0) return null;
  return `scripts/private-network.sh failed (${probe.stderr.trim() || `exit ${probe.status}`})`;
}

async function serve(options) {
  if (!options.base || !options.account) throw new Error("serve needs --base and --account");
  const requested = process.env.MEDIA_VERIFY_BROWSER_NETWORK || "auto";
  if (!NETWORKS.includes(requested)) {
    throw new Error(`MEDIA_VERIFY_BROWSER_NETWORK must be ${NETWORKS.join(", ")}, not "${requested}"`);
  }
  const unavailable = requested === "host" ? "MEDIA_VERIFY_BROWSER_NETWORK=host" : namespaceUnavailable();
  if (unavailable && requested === "isolated") {
    throw new Error(`MEDIA_VERIFY_BROWSER_NETWORK=isolated, but ${unavailable}`);
  }
  process.chdir(options.state);
  // A host that was killed leaves its sockets behind, and a socket path that exists can't be bound.
  for (const socket of Object.values(SOCKETS)) rmSync(socket, { force: true });
  if (!unavailable) return isolate(options);
  // verify-media.sh shows this line at `up` and in `doctor`.
  console.error(`browser: ${unavailable}, so the browser shares the host network, where Docker network changes can fail its requests`);
  return drive(options, "host", []);
}

// Pathname Unix sockets cross network namespaces, so the relays use them. The one port (every web
// client, Convex, and streams) keeps its port number inside, so every origin stays
// `http://localhost:<port>`. The proxy carries HTTPS to the internet for the Cast SDK, TMDB
// images, and trailers.
async function isolate({ base, account, music }) {
  const toHost = (port) =>
    createTcpServer(HALF_OPEN, (client) => pipe(client, connect({ ...HALF_OPEN, port, host: "127.0.0.1" })));
  const proxy = createServer((request, response) => {
    response.writeHead(501).end("this proxy carries HTTPS only\n");
  });
  proxy.on("connect", (request, client, head) => {
    const at = request.url.lastIndexOf(":");
    const upstream = connect(Number(request.url.slice(at + 1)), request.url.slice(0, at).replace(/^\[(.*)\]$/, "$1"));
    const refuse = () => client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    upstream.once("error", refuse);
    upstream.once("connect", () => {
      upstream.off("error", refuse);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      pipe(client, upstream);
    });
    client.on("error", () => upstream.destroy());
  });
  const relays = await Promise.all([
    listen(toHost(portOf(base, "base")), SOCKETS.web),
    listen(proxy, SOCKETS.proxy),
  ]);

  // The wrapper execs down to node, so the child is the browser host itself. Its stdin is a pipe
  // from this process, which closes if this process dies, and the host then stops too.
  const host = spawn(
    PRIVATE_NETWORK,
    [
      process.execPath, fileURLToPath(import.meta.url), "serve-inside", "--state", ".", "--base", base,
      "--account", account,
      ...(music ? ["--music", music] : []),
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const stop = () => host.kill("SIGTERM");
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  const finish = (code) => {
    for (const relay of relays) relay.close();
    for (const socket of [SOCKETS.web, SOCKETS.proxy]) rmSync(socket, { force: true });
    if (code !== 0 && !existsSync(SOCKETS.control)) {
      console.error("the browser host stopped before it was ready (see above)");
    }
    process.exit(code);
  };
  host.once("error", (error) => {
    console.error(`could not run scripts/private-network.sh: ${error.message}`);
    finish(1);
  });
  host.once("exit", (code, signal) => finish(code ?? (signal === "SIGTERM" ? 0 : 1)));
}

async function serveInside(options) {
  process.chdir(options.state);
  const toSocket = (socket) => createTcpServer(HALF_OPEN, (client) => pipe(client, connect({ ...HALF_OPEN, path: socket })));
  await listen(toSocket(SOCKETS.web), portOf(options.base, "base"), "127.0.0.1");
  const proxy = await listen(toSocket(SOCKETS.proxy), 0, "127.0.0.1");
  // Chromium never proxies loopback, so the apps' ports still reach the relays above.
  await drive(options, "isolated", [`--proxy-server=http://127.0.0.1:${proxy.address().port}`]);
  process.stdin.on("end", () => process.kill(process.pid, "SIGTERM"));
  process.stdin.resume();
}

async function drive({ base, account, music }, network, launchArgs) {
  const { chromium, devices } = await import("@playwright/test");
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  const browser = await chromium.launch({
    executablePath,
    args: ["--autoplay-policy=no-user-gesture-required", ...launchArgs],
  });
  /** @type {Map<string, {app: string, context: any, page: any, viewport: any, recording: any, streams: any, networkChanged: string[]}>} */
  const pages = new Map();
  // A base with a path, movies at /movies/, prefixes the app paths that commands open.
  const bases = { movies: base, music, account };
  const prefixes = new WeakMap();
  const openAppPath = (page, path) => page.goto(path.startsWith("/") ? (prefixes.get(page) ?? "") + path : path);
  const appPathOf = (page, url) => url.pathname.slice((prefixes.get(page) ?? "").length) || "/";

  const pageFor = async (options, app) => {
    const existing = pages.get(options.page);
    if (existing) return existing;
    if (!bases[app]) throw new Error(`this side has no ${app} app`);
    // `--tab-of P` opens another tab in page P's context: the same browser, cookies, storage, and
    // sign-in, at P's size, as a person opening a second tab does.
    const tabOf = options["tab-of"] ? pages.get(options["tab-of"]) : undefined;
    if (options["tab-of"] && !tabOf) throw new Error(`no page named ${options["tab-of"]} to open a tab of`);
    if (tabOf && tabOf.app !== app) throw new Error(`page ${options["tab-of"]} is a ${tabOf.app} page, not ${app}`);
    // The scripted Chromecast needs its own context, with a Chrome user agent the client casts from.
    if (tabOf && options["cast-fake"]) throw new Error("--cast-fake makes a page of its own; drop --tab-of");
    const device = tabOf ? tabOf.device : options.device ? devices[options.device] : undefined;
    if (!tabOf && options.device && !device) throw new Error(`unknown Playwright device "${options.device}"`);
    const viewport = tabOf
      ? tabOf.size
      : options.width && options.height
        ? { width: Number(options.width), height: Number(options.height) }
        : (device?.viewport ?? { width: 1440, height: 900 });
    const dark = app === "music" ? options.dark : !options.light;
    let context = tabOf?.context;
    if (!context) {
      context = await browser.newContext({
        // The client loads the Cast SDK only for a Chrome user agent, which headless Chromium's
        // own lacks.
        ...(options["cast-fake"] ? { userAgent: devices["Desktop Chrome"].userAgent } : {}),
        ...device,
        viewport,
        baseURL: bases[app],
        colorScheme: dark ? "dark" : "light",
      });
      await context.addInitScript({ content: TRACK_MEDIA });
    }
    const page = await context.newPage();
    if (options["cast-fake"]) await (await import(CAST_FAKE.href)).installCastFake(page);
    prefixes.set(page, new URL(bases[app]).pathname.replace(/\/$/, ""));
    // What the player fetched, so `video` can say whether it played the file or an HLS stream.
    // Counted per page address, so a title opened after another starts from zero.
    const streams = { direct: 0, hls: 0 };
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      streams.direct = 0;
      streams.hls = 0;
    });
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith("/media/hls/")) streams.hls += 1;
      else if (path.startsWith("/media/direct/") || path.startsWith("/media/file/")) streams.direct += 1;
    });
    const networkChanged = [];
    page.on("requestfailed", (request) => {
      if (request.failure()?.errorText === NETWORK_CHANGED) networkChanged.push(request.url());
    });
    // Screencast frames come at this size; the device's pixel ratio, up to 2, keeps text sharp.
    const scale = Math.min(device?.deviceScaleFactor ?? 1, 2);
    const frame = { width: viewport.width * scale, height: viewport.height * scale };
    const entry = { app, context, page, device, size: viewport, viewport: frame, recording: null, streams, networkChanged };
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

  // Real playback: the page's media elements, their clock, and what the player fetched. A video
  // that plays has `currentTime` growing; a play button that changed proves nothing.
  const media = async (entry) => {
    const now = await entry.page.evaluate(() => {
      const elements = [
        ...new Set([...(window.mediaVerifyMedia ?? []), ...document.querySelectorAll("video, audio")]),
      ];
      const playing = elements.filter((element) => !element.paused && !element.ended);
      const shown = playing.length > 0 ? playing : elements;
      const video = shown.find((element) => element instanceof HTMLVideoElement);
      return {
        playing: playing.length > 0,
        seconds: Math.max(0, ...shown.map((element) => element.currentTime)),
        elements: elements.length,
        // A blob: source is Media Source Extensions, which the HLS player feeds.
        source: video ? (video.currentSrc.startsWith("blob:") ? "mse" : video.currentSrc ? "file" : "none") : "none",
        size: video ? `${video.videoWidth}x${video.videoHeight}` : null,
      };
    });
    return { ...now, requests: { ...entry.streams } };
  };

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

  // Posters and backdrops load lazily and decode off the main thread, so a screenshot taken right
  // after a page renders shows their placeholders. Wait until every image the screenshot covers
  // has loaded, decoded, and painted: `<img>` elements and CSS background images, which the app
  // uses for backdrops and stills. For a full-page shot that's every image, so lazy ones below
  // the fold are told to load now; otherwise it's the ones in view, since lazy ones never start.
  const settleImages = async (page, options) => {
    // One function evaluated in the page: a string predicate, as `waitForFunction` polls it, needs
    // the eval that the app's Content-Security-Policy blocks.
    const settled = await page.evaluate(
      async ([full, ms]) => {
        // In view both ways: a row that scrolls sideways puts lazy cards past the right edge, and
        // they never start loading, even in a full-page shot, which grows only downwards.
        const across = (box) => box.right > 0 && box.left < innerWidth;
        const inView = (element) => {
          const box = element.getBoundingClientRect();
          return (
            box.width > 0 && box.height > 0 && across(box) && (full || (box.bottom > 0 && box.top < innerHeight))
          );
        };
        const covered = () =>
          [...document.images].filter((image) => {
            if (full) image.loading = "eager";
            return inView(image);
          });
        const backgrounds = () => {
          const urls = new Set();
          for (const element of document.querySelectorAll("[style*='background-image']")) {
            if (!inView(element)) continue;
            for (const match of getComputedStyle(element).backgroundImage.matchAll(/url\("?([^")]+)"?\)/g)) {
              urls.add(match[1]);
            }
          }
          return [...urls];
        };
        const deadline = Date.now() + ms;
        while (!covered().every((image) => image.complete)) {
          if (Date.now() > deadline) return { settled: false, broken: [] };
          await new Promise((done) => setTimeout(done, 100));
        }
        // A background image has no element to wait on, so load each into one; the cache hands
        // the element's paint the same decoded image.
        const loaded = backgrounds().map((url) => {
          const image = new Image();
          image.src = url;
          return image.decode().then(() => null, () => url);
        });
        const timer = new Promise((done) => setTimeout(() => done("timeout"), Math.max(0, deadline - Date.now())));
        const backgroundResults = await Promise.race([Promise.all(loaded), timer]);
        if (backgroundResults === "timeout") return { settled: false, broken: [] };
        // A broken image counts as `complete` too; it is the one with nothing to decode.
        const imageResults = await Promise.all(
          covered().map((image) =>
            image.decode().then(() => null, () => (image.naturalWidth === 0 && image.currentSrc ? image.currentSrc : null)),
          ),
        );
        await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
        return { settled: true, broken: [...backgroundResults, ...imageResults].filter((url) => url !== null) };
      },
      [Boolean(options.full), timeout(options)],
    );
    if (!settled.settled) throw new Error("the images in the screenshot did not finish loading");
    if (settled.broken.length > 0) {
      throw new Error(`images in the screenshot failed to load: ${settled.broken.join(", ")}`);
    }
  };

  // Signed-in movies pages show the app's main navigation.
  const signedIn = (page) => page.getByRole("navigation").first();

  const openAccount = (page, path) => page.goto(new URL(path, account).href);
  const accountHome = (page, options) =>
    page.waitForURL((url) => url.pathname === "/home", { timeout: timeout(options) });

  const accountFlows = {
    async signIn(page, options) {
      await openAccount(page, "/");
      await page.getByLabel("Username").fill(options.username ?? OWNER.username);
      await page.getByLabel("Password", { exact: true }).fill(options.password ?? OWNER.password);
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await accountHome(page, options);
      return `signed in as ${options.username ?? OWNER.username}`;
    },
    async setup(page, options) {
      await openAccount(page, "/");
      await page.getByRole("heading", { name: "Set up your server." }).waitFor({ timeout: timeout(options) });
      await page.getByLabel("Username").fill(OWNER.username);
      await page.getByLabel("Password", { exact: true }).fill(OWNER.password);
      await page.getByRole("button", { name: "Create owner account" }).click();
      await accountHome(page, options);
      const libraries = [["Movies", options.movies ?? "/media/library/Movies", "movies"]];
      if (options.shows) libraries.push(["Shows", options.shows, "movies"]);
      if (options["music-folder"]) libraries.push(["Music", options["music-folder"], "music"]);
      await openAccount(page, "/admin/libraries");
      const form = page.getByRole("region", { name: "Add a library" });
      for (const [name, folder, kind] of libraries) {
        await form.getByLabel("Name").fill(name);
        await form.getByLabel("Kind").selectOption(kind);
        await form.getByLabel("Folders, one per line").fill(folder);
        await form.getByRole("button", { name: "Add library" }).click();
        await page
          .getByRole("list", { name: "Libraries" })
          .getByRole("link", { name, exact: true })
          .waitFor({ timeout: timeout(options) });
      }
      return `set up as ${OWNER.username}`;
    },
    async invite(page, options) {
      await openAccount(page, "/admin");
      const section = page.getByRole("region", { name: "Invite someone" });
      await section.getByLabel("Role").selectOption(options["invite-role"] ?? "member");
      await section.getByRole("button", { name: "Create invite link" }).click();
      const field = section.getByLabel("Invite link");
      await field.waitFor({ timeout: timeout(options) });
      const link = (await field.innerText()).trim();
      const code = new URL(link).hash.slice(1);
      if (!code) throw new Error(`the invite link looks wrong: "${link}"`);
      return code;
    },
    async join(page, options) {
      if (!options.code || !options.username) throw new Error("join needs --code and --username");
      await openAccount(page, `/invite#${options.code}`);
      await page.getByRole("heading", { name: "You're invited." }).waitFor({ timeout: timeout(options) });
      await page.getByLabel("Username").fill(options.username);
      await page.getByLabel("Password", { exact: true }).fill(options.password ?? OWNER.password);
      await page.getByRole("button", { name: "Create account" }).click();
      await accountHome(page, options);
      return `joined as ${options.username}`;
    },
    async createAccount(page, options) {
      if (!options.username) throw new Error("create-account needs --username");
      await openAccount(page, "/admin");
      const section = page.getByRole("region", { name: "Create an account" });
      await section.getByLabel("Username").fill(options.username);
      await section.getByLabel("Password", { exact: true }).fill(options.password ?? OWNER.password);
      await section.getByLabel("Role").selectOption(options["invite-role"] ?? "member");
      await section.getByRole("button", { name: "Create account" }).click();
      await page
        .getByRole("list", { name: "People" })
        .getByText(options.username, { exact: true })
        .waitFor({ timeout: timeout(options) });
      return `created ${options.username}`;
    },
  };

  const accountCommands = {
    "sign-in": ({ page }, options) => accountFlows.signIn(page, options),
    setup: ({ page }, options) => accountFlows.setup(page, options),
    invite: ({ page }, options) => accountFlows.invite(page, options),
    join: ({ page }, options) => accountFlows.join(page, options),
    "create-account": ({ page }, options) => accountFlows.createAccount(page, options),
  };

  const moviesCommands = {
    ...accountCommands,
    async "sign-in"(entry, options) {
      await accountFlows.signIn(entry.page, options);
      await openAppPath(entry.page, "/");
      await signedIn(entry.page).first().waitFor({ timeout: timeout(options) });
      return entry.page.url();
    },
  };

  const commands = {
    // The scripted Chromecast of a page made with `--cast-fake`: `cast --value <action>` plays the
    // receiver's part (`devicesAppear`, `disconnect`, …), `--advance S` moves its position, and
    // `cast-state` prints what it loaded and fetched.
    async cast({ page }, options) {
      const fake = await import(CAST_FAKE.href);
      if (options.advance !== undefined) {
        const seconds = Number(options.advance);
        if (!Number.isFinite(seconds) || seconds < 0) throw new Error("cast --advance needs a number of seconds");
        return fake.advanceReceiver(page, seconds);
      }
      if (!CAST_ACTIONS.includes(options.value ?? "")) {
        throw new Error(`cast needs --advance S or --value with one of ${CAST_ACTIONS.join(", ")}`);
      }
      await fake.castFake(page, options.value);
    },
    async "cast-state"({ page }) {
      return JSON.stringify(await (await import(CAST_FAKE.href)).receiver(page));
    },
    async "record-start"(entry, options) {
      return startRecording(entry, options);
    },
    async "record-stop"(entry) {
      return stopRecording(entry);
    },
    async open({ page, networkChanged }, options) {
      // A new page load replaces whatever the cancelled requests left out.
      networkChanged.length = 0;
      await openAppPath(page, options.args[0] ?? "/");
      return page.url();
    },
    async click({ page }, options) {
      const button = options.button ?? "left";

      if (!["left", "right", "middle"].includes(button)) {
        throw new Error("click --button takes left, right, or middle");
      }

      await locate(page, options).click({ button, timeout: timeout(options) });
    },
    async hover({ page }, options) {
      await locate(page, options).hover({ timeout: timeout(options) });
    },
    async fill({ page }, options) {
      await locate(page, options).fill(options.value ?? "", { timeout: timeout(options) });
    },
    async select({ page }, options) {
      if (options.value === undefined) throw new Error("select needs --value, the option's label");
      return (await locate(page, options).selectOption({ label: options.value }, { timeout: timeout(options) })).join(",");
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
      // An element below the fold scrolls into view first, so its images count as in view. It
      // scrolls to the middle of the window: at an edge, a phone's fixed tab bar covers it.
      if (hasLocator(options)) {
        await locate(page, options).evaluate((element) => element.scrollIntoView({ block: "center" }));
      }
      await settleImages(page, options);
      if (hasLocator(options)) await locate(page, options).screenshot({ path });
      else await page.screenshot({ path, fullPage: options.full });
      return path;
    },
    async video(entry) {
      return JSON.stringify(await media(entry));
    },
    async "wait-video"(entry, options) {
      const start = (await media(entry)).seconds;
      const target =
        options.past !== undefined ? Number(options.past) : start + Number(options.advance ?? 1);
      const deadline = Date.now() + timeout(options);
      for (;;) {
        const now = await media(entry);
        if (now.playing && now.seconds > target) return JSON.stringify(now);
        if (Date.now() > deadline) {
          throw new Error(`video did not play past ${target}s: ${JSON.stringify(now)}`);
        }
        await entry.page.waitForTimeout(250);
      }
    },
    async url({ page }) {
      return page.url();
    },
    async eval({ page }, options) {
      if (!options.js) throw new Error("eval needs --js");
      return JSON.stringify(await page.evaluate(options.js));
    },
  };
  commands.audio = commands.video;
  commands["wait-audio"] = commands["wait-video"];

  const musicSignedIn = (page) =>
    page.getByRole("navigation", { name: "Library" }).or(page.getByRole("navigation", { name: "Main" }));

  // The image's own music client signs in at `/`, as movies does.
  const musicCommands = {
    ...accountCommands,
    async "sign-in"(entry, options) {
      await accountFlows.signIn(entry.page, options);
      await openAppPath(entry.page, "/");
      await musicSignedIn(entry.page).first().waitFor({ timeout: timeout(options) });
      return entry.page.url();
    },
  };
  const appCommands = {
    movies: moviesCommands,
    music: musicCommands,
    account: accountCommands,
  };

  const handle = async (options) => {
    if (options.command === "network") return `${network} ${chromiumPid()}`;
    if (options.command === "pages") {
      return [...pages.entries()]
        .map(([name, { app, page, recording }]) => `${name}\t${app}\t${page.url()}${recording ? "\trecording" : ""}`)
        .join("\n");
    }
    if (options.command === "close-page") {
      const entry = pages.get(options.page);
      if (!entry) throw new Error(`no page named ${options.page}`);
      pages.delete(options.page);
      const saved = entry.recording ? await stopRecording(entry) : null;
      // A tab closes alone while another page still uses its context.
      const shared = [...pages.values()].some((other) => other.context === entry.context);
      await (shared ? entry.page.close() : entry.context.close());
      return saved ? `closed ${options.page}; saved ${saved}` : `closed ${options.page}`;
    }
    const existing = pages.get(options.page);
    if (existing && options["tab-of"]) {
      throw new Error(`page ${options.page} is open already; name a new --page for a tab of ${options["tab-of"]}`);
    }
    if (existing && options.app && options.app !== existing.app) {
      throw new Error(`page ${options.page} is a ${existing.app} page; name another --page for ${options.app}`);
    }
    const app = existing?.app ?? options.app ?? pages.get(options["tab-of"])?.app ?? "movies";
    const run = appCommands[app][options.command] ?? commands[options.command];
    if (!run) throw new Error(`unknown ${app} command "${options.command}"`);
    const entry = await pageFor(options, app);
    const outcome = await run(entry, options).then(
      (output) => ({ output }),
      (error) => ({ error }),
    );
    const lost = entry.networkChanged.splice(0);
    if (lost.length > 0) {
      const urls = [...new Set(lost)];
      throw new Error(
        [
          `${lost.length} requests failed with ${NETWORK_CHANGED}: a host network address changed, ` +
            `as a Docker container starting or stopping does. Open the page again before trusting it.`,
          ...(outcome.error ? [outcome.error.message.split("\n")[0]] : []),
          ...urls.slice(0, 5),
          ...(urls.length > 5 ? [`and ${urls.length - 5} more`] : []),
        ].join("\n"),
      );
    }
    if (outcome.error) throw outcome.error;
    return outcome.output;
  };

  // Connecting to a Unix socket needs write permission on it, so under the usual umask only this
  // user drives the signed-in pages.
  const server = createServer((request, response) => {
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
  await listen(server, SOCKETS.control);

  const stop = async () => {
    for (const entry of pages.values()) {
      if (entry.recording) await stopRecording(entry).catch(() => {});
      await entry.context.close().catch(() => {});
    }
    await browser.close();
    rmSync(SOCKETS.control, { force: true });
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
