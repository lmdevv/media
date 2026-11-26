import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { cliEnv, FOREIGN_SETTINGS, grantArgs, GRANTS, KID_LIMITS, openJobs, scanState } from "./core-seed.mjs";
import { ALBUMS, LIKES, LISTENERS, MUSIC_GRANTS, PLAYLISTS } from "./music-core-seed.mjs";

const here = (file) => fileURLToPath(new URL(file, import.meta.url));
const browserJs = here("browser.mjs");
const evidenceJs = here("evidence.mjs");
const helper = here("verify-media.sh");
const isolatable = spawnSync(here("../../../../scripts/private-network.sh"), ["true"]).status === 0;
const scratch = mkdtempSync(join(tmpdir(), "verify-media-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const chromium = () => {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  if (!existsSync("/etc/NIXOS")) return undefined;
  const found = spawnSync("sh", ["-c", "command -v chromium"], { encoding: "utf8" });
  return found.status === 0 ? found.stdout.trim() : undefined;
};

const toneWav = () => {
  const rate = 8000;
  const samples = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i += 1) samples.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
};

const serveApp = () =>
  new Promise((resolve) => {
    const server = createServer((request, response) => {
      if (request.url === "/tone.wav") {
        response.writeHead(200, { "content-type": "audio/wav" }).end(toneWav());
        return;
      }
      const app = request.url.startsWith("/movies/") ? "movies" : request.url.startsWith("/music/") ? "music" : "account";
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><title>${app}</title><main><h1>${app}</h1>
        <button onclick="new Audio('/tone.wav').play()">Play</button></main>`);
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });

const portOf = (server) => server.address().port;

for (const network of ["isolated", "host"]) {
  const skip = network === "isolated" && !isolatable && "this host can't make a private network namespace";
  describe(`browser host on the ${network} network`, { skip }, () => {
    const state = join(scratch, `browser-${network}`);
    const servers = {};
    let host;

    // Not spawnSync: the app servers answer from this process, so it must keep running meanwhile.
    const browser = (...args) =>
      new Promise((resolve) => {
        execFile("node", [browserJs, "--state", state, ...args], { encoding: "utf8" }, (error, stdout, stderr) =>
          resolve({ status: error ? error.code : 0, stdout, stderr }),
        );
      });

    before(async () => {
      mkdirSync(state, { recursive: true });
      servers.media = await serveApp();
      host = spawn(
        "node",
        [
          browserJs, "serve", "--state", state,
          "--base", `http://localhost:${portOf(servers.media)}/movies/`,
          "--account", `http://localhost:${portOf(servers.media)}`,
          "--music", `http://localhost:${portOf(servers.media)}/music`,
        ],
        { env: { ...process.env, CHROMIUM_PATH: chromium() ?? "", MEDIA_VERIFY_BROWSER_NETWORK: network }, stdio: "inherit" },
      );
      for (let tries = 0; !existsSync(join(state, "browser.sock")); tries += 1) {
        assert.ok(tries < 300, "the browser host started");
        assert.equal(host.exitCode, null, "the browser host is still running");
        await sleep(100);
      }
    });

    after(async () => {
      if (host && host.exitCode === null) {
        const stopped = new Promise((resolve) => host.once("exit", resolve));
        host.kill("SIGTERM");
        await stopped;
      }
      for (const server of Object.values(servers)) server.close();
    });

    test("reports the network it was asked for", async () => {
      const result = await browser("network");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`^${network} \\d+`));
    });

    test("opens a movies page under /movies, an account page at /, and a music page under /music", async () => {
      const movies = await browser("open", "/title/1");
      assert.equal(movies.status, 0, movies.stderr);
      assert.equal(movies.stdout.trim(), `http://localhost:${portOf(servers.media)}/movies/title/1`);
      const heading = await browser("text", "--role", "heading");
      assert.equal(heading.stdout.trim(), "movies");
      const account = await browser("--app", "account", "--page", "account", "open", "/");
      assert.equal(account.status, 0, account.stderr);
      assert.equal(account.stdout.trim(), `http://localhost:${portOf(servers.media)}/`);
      const music = await browser("--app", "music", "open", "/");
      assert.equal(music.status, 0, music.stderr);
      assert.equal(music.stdout.trim(), `http://localhost:${portOf(servers.media)}/music/`);
      const pages = await browser("pages");
      assert.match(pages.stdout, /^main\tmovies\t/m);
      assert.match(pages.stdout, /^music\tmusic\t/m);
    });

    test("keeps a page in the app it was created for", async () => {
      const result = await browser("--app", "movies", "--page", "music", "open", "/");
      assert.equal(result.status, 1);
      assert.match(result.stderr, /page music is a music page/);
    });

    test("opens another tab of a page in that page's app", async () => {
      const tab = await browser("--page", "music-tab", "--tab-of", "music", "open", "/");
      assert.equal(tab.status, 0, tab.stderr);
      assert.equal(tab.stdout.trim(), `http://localhost:${portOf(servers.media)}/music/`);
      const pages = await browser("pages");
      assert.match(pages.stdout, /^music-tab\tmusic\t/m);
      const again = await browser("--tab-of", "music", "open", "/");
      assert.equal(again.status, 1, "a tab needs a page name of its own");
      assert.match(again.stderr, /page main is open already; name a new --page for a tab of music/);
      const closed = await browser("--page", "music-tab", "close-page");
      assert.equal(closed.status, 0, closed.stderr);
    });

    test("gives a movies page the account client's commands", async () => {
      const join = await browser("--page", "kid", "join", "--code=abc");
      assert.equal(join.status, 1);
      assert.match(join.stderr, /join needs --code and --username/);
      const unknown = await browser("--page", "account-only", "--app", "account", "nope");
      assert.equal(unknown.status, 1);
      assert.match(unknown.stderr, /unknown account command "nope"/);
    });

    test("plays real audio on a music page", async () => {
      const click = await browser("--app", "music", "click", "--role", "button", "--name", "Play");
      assert.equal(click.status, 0, click.stderr);
      const played = await browser("--app", "music", "wait-audio", "--past", "0.3", "--timeout", "10000");
      assert.equal(played.status, 0, played.stderr);
      assert.equal(JSON.parse(played.stdout).playing, true);
    });

    test("refuses an app it doesn't know", async () => {
      const result = await browser("--app", "jazz", "open", "/");
      assert.equal(result.status, 2);
      assert.match(result.stderr, /--app must be movies or music/);
    });
  });
}

describe("evidence", () => {
  const root = join(scratch, "evidence-root");
  const run = "evidence-test";
  const evidence = join(root, "captures", "verify", run);
  const evidenceCommand = (...args) =>
    spawnSync("node", [evidenceJs, ...args, "--root", root, "--run", run, "--evidence", evidence], {
      cwd: root,
      encoding: "utf8",
    });

  before(() => {
    mkdirSync(join(evidence, "before"), { recursive: true });
    mkdirSync(join(evidence, "after", "music"), { recursive: true });
    const frame = (file) =>
      execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240", "-frames:v", "1", file]);
    frame(join(evidence, "before", "home.png"));
    frame(join(evidence, "after", "home.png"));
    execFileSync("ffmpeg", [
      "-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=320x240:duration=1", "-c:v", "mpeg4",
      join(evidence, "after", "music", "play.mp4"),
    ]);
  });

  test("publishes one block with both apps' captures", () => {
    assert.equal(evidenceCommand("clear").status, 0);
    const movies = evidenceCommand("add", "--label", "Movies home", "--before", "captures/verify/evidence-test/before/home.png",
      "--after", "captures/verify/evidence-test/after/home.png");
    assert.equal(movies.status, 0, movies.stderr);
    const music = evidenceCommand("add", "--label", "Music plays a song", "--after", "captures/verify/evidence-test/after/music/play.mp4");
    assert.equal(music.status, 0, music.stderr);

    const published = evidenceCommand("publish", "--dry-run");
    assert.equal(published.status, 0, published.stderr);
    assert.equal(published.stdout.split("<!-- verify-media:start -->").length, 2, "one start marker");
    assert.equal(published.stdout.split("<!-- verify-media:end -->").length, 2, "one end marker");
    assert.match(published.stdout, /\| Movies home \| !\[Before: Movies home\]\(\.\/captures\/verify\/evidence-test\/before\/home\.png\)/);
    assert.match(published.stdout, /\*\*Music plays a song\*\*[\s\S]*!\[After: Music plays a song\]\(\.\/captures\/verify\/evidence-test\/pr\/01-after\.mp4\)/);
    assert.match(published.stdout, /would attach 3 files to PR <none>/);
    // ffmpeg describes its input on stderr and exits 1 when given no output.
    const probe = spawnSync("ffmpeg", ["-hide_banner", "-i", join(evidence, "pr", "01-after.mp4")], { encoding: "utf8" });
    assert.match(probe.stderr, /Video: h264/);
  });

  test("needs a PR to publish for real", () => {
    const result = evidenceCommand("publish");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /publish needs --pr/);
  });
});

describe("verify-media.sh", () => {
  const env = { ...process.env, TMPDIR: join(scratch, "helper-tmp"), MEDIA_VERIFY_RUN: `test-${process.pid}` };
  const helperCommand = (...args) => spawnSync(helper, args, { encoding: "utf8", env });

  before(() => mkdirSync(env.TMPDIR, { recursive: true }));

  test("prints its usage without a command", () => {
    const result = helperCommand();
    assert.equal(result.status, 2);
    assert.match(result.stderr, /verify-media\.sh up \[--side after\|before\]/);
  });

  test("reports no sides for a run that never started", () => {
    const result = helperCommand("status");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^evidence: /);
    assert.doesNotMatch(result.stdout, /^(after|before):/m);
  });

  test("refuses to drive a side that isn't up", () => {
    const cli = helperCommand("cli", "--", "music", "albums", "list");
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /no after side in run test-\d+; run `up --side after`/);
    const side = helperCommand("doctor", "--side", "sideways");
    assert.equal(side.status, 1);
    assert.match(side.stderr, /--side must be after or before, not sideways/);
  });

  test("asks for a grid before checking its cells on the Mac", () => {
    const result = helperCommand("apple-check");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no hardware-matrix cells for the after side under .*; run hardware-matrix first/);
  });

  test("reports a file it could not have AVFoundation check as not checked, and fails", () => {
    const file = join(scratch, "cell-start.mp4");
    writeFileSync(file, "not checked here");
    const result = spawnSync(helper, ["apple-check", file], {
      encoding: "utf8",
      env: { ...env, MAC_HOST: "unreachable.invalid" },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "cell-start.mp4 not checked\n");
    assert.match(result.stderr, /AVFoundation could not run on unreachable\.invalid/);
  });

  test("takes down a run that never started", () => {
    const result = helperCommand("down");
    assert.equal(result.status, 0, result.stderr);
  });

  test("refuses a health deadline that is not whole seconds only where up reads it", () => {
    const badDeadline = { ...env, MEDIA_VERIFY_HEALTH_SECONDS: "5m" };
    const up = spawnSync(helper, ["up"], { encoding: "utf8", env: badDeadline });
    assert.equal(up.status, 1);
    assert.match(up.stderr, /MEDIA_VERIFY_HEALTH_SECONDS must be a whole number of seconds/);
    const down = spawnSync(helper, ["down"], { encoding: "utf8", env: badDeadline });
    assert.equal(down.status, 0, down.stderr);
  });
});

// A server that accepts connections and never answers, as a container behind a missing route
// does. It logs when it listens, each connection it accepts with its request's first line, and how
// long it held each one, so a test can tell a held request from a refused one.
const silentServer = String.raw`
import { appendFileSync } from "node:fs";
import { createServer } from "node:net";
const [log, address] = process.argv.slice(2);
const held = [];
createServer((socket) => {
  const opened = Date.now();
  held.push(socket);
  appendFileSync(log, "accepted\n");
  socket.once("data", (chunk) => appendFileSync(log, "request " + chunk.toString().split("\r\n")[0] + "\n"));
  socket.on("close", () => appendFileSync(log, "held " + (Date.now() - opened) + "\n"));
}).listen(...(/^\d+$/.test(address) ? [Number(address), "127.0.0.1"] : [address]), () => appendFileSync(log, "ready\n"));
`;

const silentLog = (file) => {
  const lines = existsSync(file) ? execFileSync("cat", [file], { encoding: "utf8" }).split("\n") : [];
  return {
    ready: lines.includes("ready"),
    requests: lines.filter((line) => line.startsWith("request ")).map((line) => line.slice("request ".length)),
    held: lines.filter((line) => line.startsWith("held ")).map((line) => Number(line.slice("held ".length))),
  };
};

const waitFor = async (check, what) => {
  for (let tries = 0; !check(); tries += 1) {
    assert.ok(tries < 200, what);
    await sleep(50);
  }
};

// A stand-in for Docker whose stack never answers: `compose up` starts the silent server on the
// side's port.
const fakeDocker = `#!/usr/bin/env bash
set -euo pipefail
log="$FAKE_DOCKER_DIR/calls"
echo "$*" >> "$log"
case "$1 \${2:-}" in
  "image inspect") echo sha256:fake ;;
  "inspect -f")
    case "$3" in
      *State.Status*) echo running ;;
      *Networks*) echo "172.31.255.2 " ;;
    esac ;;
  compose*)
    for arg in "$@"; do
      if [[ "$arg" == up ]]; then
        env_file="$(sed -n 's/.*--env-file \\([^ ]*\\).*/\\1/p' <<<"$*")"
        port="$(sed -n 's/^MEDIA_PORT=//p' "$env_file")"
        nohup node "$FAKE_DOCKER_DIR/silent-server.mjs" "$FAKE_DOCKER_DIR/silent.log" "$port" >/dev/null 2>&1 &
        echo "$!" > "$FAKE_DOCKER_DIR/silent.pid"
        # Up returns once the stack listens, as Compose's own containers start before it returns, so
        # the first health check finds the server however slowly Node starts.
        for _ in $(seq 1 200); do
          grep -qx ready "$FAKE_DOCKER_DIR/silent.log" 2>/dev/null && break
          sleep 0.05
        done
        grep -qx ready "$FAKE_DOCKER_DIR/silent.log" 2>/dev/null || { echo "the silent server did not listen in 10s" >&2; exit 1; }
      elif [[ "$arg" == down ]]; then
        kill "$(cat "$FAKE_DOCKER_DIR/silent.pid")" 2>/dev/null || true
      elif [[ "$arg" == logs ]]; then
        # A daemon that stalls, when the test asks for one, answers nothing until it is killed.
        [[ "\${FAKE_DOCKER_STALL:-}" == logs ]] && exec sleep 3600
        echo "media-1  | starting"
      fi
    done ;;
esac
`;

// Runs `up` against the fake Docker in its own folder and returns what it printed, how long it took,
// and what the silent server saw.
const upAgainstSilentStack = (name, extra = {}) => {
  const dir = join(scratch, name);
  const library = join(scratch, "silent-library");
  const run = `${name}-${process.pid}`;
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    TMPDIR: join(scratch, `${name}-tmp`),
    MEDIA_VERIFY_RUN: run,
    MEDIA_VERIFY_HEALTH_SECONDS: "3",
    FAKE_DOCKER_DIR: dir,
    ...extra,
  };

  before(() => {
    mkdirSync(join(library, "Movies"), { recursive: true });
    mkdirSync(env.TMPDIR, { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "docker"), fakeDocker, { mode: 0o755 });
    writeFileSync(join(dir, "silent-server.mjs"), silentServer);
  });

  after(() => {
    const pid = join(dir, "silent.pid");
    if (existsSync(pid)) spawnSync("sh", ["-c", `kill "$(cat '${pid}')" 2>/dev/null || true`]);
    rmSync(here(`../../../../captures/verify/${run}`), { recursive: true, force: true });
  });

  return async () => {
    const began = Date.now();
    const result = await new Promise((resolve) => {
      execFile(
        helper,
        ["up", "--image", "media:silent", "--library", library, "--no-music", "--no-setup"],
        { encoding: "utf8", env, timeout: 90_000 },
        (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }),
      );
    });
    return {
      ...result,
      seconds: (Date.now() - began) / 1000,
      silent: silentLog(join(dir, "silent.log")),
      calls: existsSync(join(dir, "calls")) ? execFileSync("cat", [join(dir, "calls")], { encoding: "utf8" }) : "",
      stateLeft: existsSync(join(env.TMPDIR, "media-verify", run, "after")),
    };
  };
};

describe("verify-media.sh up against a stack that never answers", () => {
  const up = upAgainstSilentStack("silent");

  test("gives up at its deadline, names the silent URL and the route to check, and removes the side", async () => {
    const result = await up();

    // The stack was there and silent: a refused connection would meet every check below.
    assert.ok(result.silent.ready, "the silent server listened");
    assert.ok(result.silent.requests.includes("GET /api/health HTTP/1.1"), `requests: ${result.silent.requests}`);
    assert.ok(result.silent.held.some((ms) => ms >= 9_000), `a health check held its connection: ${result.silent.held}`);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.seconds < 45, `up returned after ${result.seconds}s`);
    assert.match(result.stderr, /http:\/\/localhost:\d+\/api\/health never answered/);
    assert.match(result.stderr, /`ip route get 172\.31\.255\.2`/);
    assert.match(result.stderr, /media-1 {2}\| starting/);
    assert.match(result.stderr, /did not become healthy in 3s/);
    assert.match(result.calls, /compose .* down --volumes/);
    assert.equal(result.stateLeft, false, "the side's state is gone");
  });
});

describe("verify-media.sh up when Docker stalls on the logs", () => {
  const up = upAgainstSilentStack("stalled", { FAKE_DOCKER_STALL: "logs" });

  test("stops waiting for the logs, still removes the side, and fails with its own reason", async () => {
    const result = await up();

    assert.ok(result.silent.ready, "the silent server listened");
    assert.match(result.calls, /compose .* logs/);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(result.seconds < 60, `up returned after ${result.seconds}s`);
    assert.match(result.stderr, /could not read the containers' logs/);
    assert.match(result.stderr, /did not become healthy in 3s/);
    assert.match(result.calls, /compose .* down --volumes/);
    assert.equal(result.stateLeft, false, "the side's state is gone");
  });
});

describe("a browser host that never answers", () => {
  const state = join(scratch, "silent-browser");
  const log = join(state, "silent.log");
  let server;

  before(async () => {
    mkdirSync(state, { recursive: true });
    writeFileSync(join(scratch, "silent-server.mjs"), silentServer);
    server = spawn("node", [join(scratch, "silent-server.mjs"), log, join(state, "browser.sock")], { stdio: "inherit" });
    await waitFor(() => silentLog(log).ready, "the silent browser host listened");
  });

  after(() => server?.kill());

  test("gives up on a command a second after its --timeout and exits as timeout(1) does", async () => {
    const began = Date.now();
    const result = await new Promise((resolve) => {
      execFile("node", [browserJs, "url", "--state", state, "--timeout", "100"], { encoding: "utf8", timeout: 20_000 },
        (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stderr }));
    });
    const elapsed = Date.now() - began;
    const silent = silentLog(log);

    assert.ok(silent.requests.includes("POST / HTTP/1.1"), `requests: ${silent.requests}`);
    assert.equal(result.status, 124, result.stderr);
    assert.ok(elapsed >= 1_000 && elapsed < 10_000, `the command returned after ${elapsed} ms`);
    assert.match(result.stderr, /did not answer `url` within 1100 ms/);
    await waitFor(() => silentLog(log).held.length > 0, "the client closed its request");
    assert.ok(silentLog(log).held[0] >= 1_000, `the request was held: ${silentLog(log).held}`);
  });
});

describe("a step of up that runs out of time", () => {
  const env = { ...process.env, TMPDIR: join(scratch, "within-tmp"), MEDIA_VERIFY_RUN: `within-${process.pid}` };
  const hanging = join(scratch, "hanging-cli.mjs");
  const stubborn = join(scratch, "stubborn-cli.mjs");
  const stubbornPid = join(scratch, "stubborn-cli.pid");

  before(() => {
    mkdirSync(env.TMPDIR, { recursive: true });
    writeFileSync(hanging, "setInterval(() => {}, 1_000);\n");
    writeFileSync(
      stubborn,
      `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(stubbornPid)}, String(process.pid));
process.on("SIGTERM", () => console.error("ignoring SIGTERM"));
setInterval(() => {}, 1_000);
`,
    );
  });

  // The script's own functions, with the side's removal recorded instead of run.
  const step = (cli) =>
    spawnSync(
      "bash",
      [
        "-c",
        `source "$1"; take_side --side after; mkdir -p "$state"; side_down() { echo "removed the $1 side" >&2; }
         cli_js="$2"; within 1 "asking the owner's CLI who it is" cli_raw whoami`,
        "within-test",
        helper,
        cli,
      ],
      { encoding: "utf8", env, timeout: 20_000 },
    );

  test("fails up the way a silent stack does: names the step, removes the side, and exits 1", () => {
    const began = Date.now();
    const result = step(hanging);

    assert.equal(result.status, 1, result.stderr);
    assert.ok(Date.now() - began < 10_000, "the step stopped at its deadline");
    assert.match(result.stderr, /removed the after side/);
    assert.match(result.stderr, /asking the owner's CLI who it is did not finish in 1s/);
  });

  test("kills a step that ignores the stop, then fails up the same way", async () => {
    const began = Date.now();
    const result = step(stubborn);
    const pid = Number(execFileSync("cat", [stubbornPid], { encoding: "utf8" }));
    const alive = () => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    // Its parent reaps it a moment after the kill.
    for (let tries = 0; alive() && tries < 40; tries += 1) await sleep(50);

    assert.match(result.stderr, /ignoring SIGTERM/);
    assert.equal(result.status, 1, result.stderr);
    assert.ok(Date.now() - began < 15_000, "the step was killed after its grace");
    assert.match(result.stderr, /removed the after side/);
    assert.match(result.stderr, /asking the owner's CLI who it is did not finish in 1s/);
    assert.equal(alive(), false, `the stubborn CLI ${pid} is gone`);
  });
});

describe("a side", () => {
  const env = { ...process.env, TMPDIR: join(scratch, "side-tmp"), MEDIA_VERIFY_RUN: `side-${process.pid}` };
  const withSide = (body, runEnv = env) =>
    spawnSync(
      "bash",
      ["-c", `source "$1"; take_side --side after; mkdir -p "$state"; write_state port 4100; ${body}`, "side-test", helper],
      { encoding: "utf8", env: runEnv },
    );

  // Stand-ins for the commands that reach the Mac. Each records its call and fails, so an iOS test
  // that gets past its guard fails here instead of syncing and building on a real host.
  const remote = join(scratch, "remote-bin");
  const remoteCalls = join(remote, "calls");
  const remoteEnv = { ...env, PATH: `${remote}:${process.env.PATH}` };
  const withSideOffline = (body) => {
    rmSync(remoteCalls, { force: true });
    const result = withSide(body, remoteEnv);
    assert.equal(existsSync(remoteCalls) ? execFileSync("cat", [remoteCalls], { encoding: "utf8" }) : "", "", "nothing reached the Mac");
    return result;
  };

  before(() => {
    mkdirSync(env.TMPDIR, { recursive: true });
    mkdirSync(remote, { recursive: true });
    for (const command of ["ssh", "rsync", "scp"]) {
      writeFileSync(
        join(remote, command),
        `#!/usr/bin/env bash\necho "${command} $*" >> ${JSON.stringify(remoteCalls)}\necho "${command} must not run in a test" >&2\nexit 99\n`,
        { mode: 0o755 },
      );
    }
  });

  test("points the CLI at the core's Convex and movies at /movies on the one port", () => {
    assert.equal(withSide('echo "$(movies_url) $(convex_url) $owner"').stdout, "http://localhost:4100/movies http://localhost:4100/convex lucia\n");
  });

  test("serves music at /music on the image when it holds the music client, and nowhere else", () => {
    const urls = 'echo "$(music_url)"; music_core && echo core';
    assert.equal(withSide(`write_state music_core 1; ${urls}`).stdout, "http://localhost:4100/music\ncore\n");
    assert.equal(withSide("write_state music_core 0; music_core || echo none").stdout, "none\n");
  });

  test("reads the music client from the image, and stops when Docker can't look", () => {
    const bin = join(scratch, "music-docker");
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, "docker"), '#!/usr/bin/env bash\necho "$*" >> "$FAKE_DOCKER_CALLS"\nexit "$FAKE_DOCKER_CODE"\n', { mode: 0o755 });
    const calls = join(bin, "calls");
    const probe = (code) =>
      spawnSync("bash", ["-c", `source "$1"; music_in media:x`, "side-test", helper], {
        encoding: "utf8",
        env: { ...env, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_CODE: String(code), FAKE_DOCKER_CALLS: calls },
      });
    assert.equal(probe(0).stdout, "1\n");
    assert.equal(probe(1).stdout, "0\n");
    const broken = probe(125);
    assert.equal(broken.status, 1);
    assert.match(broken.stderr, /could not look inside media:x for its music client \(docker run exited 125\)/);
    assert.match(execFileSync("cat", [calls], { encoding: "utf8" }), /^run --rm --network none --entrypoint test media:x -d \/app\/music$/m);
  });

  test("fails up when Docker can't look for the music client, instead of running movies alone", () => {
    const bin = join(scratch, "up-music-docker");
    const calls = join(bin, "calls");
    const library = join(scratch, "up-music-library");
    mkdirSync(join(library, "Movies"), { recursive: true });
    mkdirSync(join(library, "Music"), { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "docker"),
      `#!/usr/bin/env bash
echo "$*" >> "$FAKE_DOCKER_CALLS"
case "$*" in
  "run "*/app/music) exit 125 ;;
esac
`,
      { mode: 0o755 },
    );
    const run = `up-music-${process.pid}`;
    const result = spawnSync(helper, ["up", "--image", "media:x", "--library", library, "--no-setup"], {
      encoding: "utf8",
      env: { ...env, PATH: `${bin}:${process.env.PATH}`, MEDIA_VERIFY_RUN: run, FAKE_DOCKER_CALLS: calls },
      timeout: 60_000,
    });
    rmSync(here(`../../../../captures/verify/${run}`), { recursive: true, force: true });
    const docker = execFileSync("cat", [calls], { encoding: "utf8" });

    assert.notEqual(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /ready/);
    assert.match(result.stderr, /could not look inside media:x for its music client \(docker run exited 125\)/);
    assert.doesNotMatch(result.stderr, /runs movies alone/);
    assert.match(docker, /^run --rm --network none --entrypoint test media:x -d \/app\/music$/m);
    assert.doesNotMatch(docker, /^compose /m, "no stack started");
  });

  test("sends a music CLI call to the media CLI's music group", () => {
    const result = withSide("write_state music_core 1; cmd_cli --side after --app music -- albums list");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /cli runs the media CLI for both products: run `cli -- music …` for music/);
    const movies = withSide("cmd_cli --side after --app movies -- movies titles list");
    assert.equal(movies.status, 1);
    assert.match(movies.stderr, /no CLI session on the after side/);
  });

  test("signs a CLI config of its own in, and names the sign-in when a person has none", () => {
    const login = withSide(
      'cli_raw() { echo "as=$as $*"; }; cmd_cli --side after --as probe -- auth login --server http://core; [[ -d "$state/cli/probe" ]] && echo config',
    );
    assert.equal(login.status, 0, login.stderr);
    assert.match(login.stdout, /^as=probe auth login --server http:\/\/core$/m);
    assert.match(login.stdout, /^config$/m);
    const refused = withSide(
      'cli_raw() { return 3; }; cmd_cli --side after --as refused -- auth login --server http://core || echo "status $?"; [[ -d "$state/cli/refused" ]] || echo "no config"',
    );
    assert.match(refused.stdout, /^status 3$/m);
    assert.match(refused.stdout, /^no config$/m);
    const stranger = withSide("cmd_cli --side after --as stranger -- movies titles list");
    assert.equal(stranger.status, 1);
    assert.match(
      stranger.stderr,
      /no CLI session for stranger .* `cli --as stranger -- auth login --server http:\/\/localhost:4100\/convex` prints a code to approve at \/device/,
    );
  });

  test("strips the same settings from a person's CLI in the helper and in the seeds", () => {
    const line = execFileSync("grep", ["-A1", "^  env -u MEDIA_", helper], { encoding: "utf8" });
    assert.deepEqual([...line.matchAll(/-u (MEDIA_\w+)/g)].map((match) => match[1]).sort(), [...FOREIGN_SETTINGS].sort());
  });

  test("keeps a restart from killing a process that is not this side's browser host", () => {
    const result = withSide(
      'write_state browser.pid "$$"; is_browser_host "$$" && echo host; start_browser() { echo "start $1"; }; cmd_browser --side after restart',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /^host$/m);
    assert.match(result.stdout, /^start die$/m, "a failed restart fails without removing the side");
    assert.match(result.stdout, /^browser host restarted$/m);
  });

  test("points a browser command at restart when the host is gone", () => {
    const result = withSide("cmd_browser --side after url");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /no browser host on the after side; run `browser restart --side after`/);
  });

  test("looks a matrix title up with the movies search command", () => {
    const result = withSide(
      `mkdir -p "$state/cli/lucia"; cli_raw() { echo "$*" >&2; echo '[{"id":"title-0","name":"Sintel: The Making"},{"id":"title-1","name":"Sintel"}]'; }; title_id Sintel`,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "title-1");
    assert.match(result.stderr, /^movies titles search --query Sintel$/m);
  });

  test("opens a path with the scheme of the app the simulator runs, and keeps the matrix to movies", () => {
    const opened = withSideOffline(
      'write_state ios_app music; udid() { echo SIM; }; on_mac() { echo "$1"; }; ios_agent_once() { return 1; }; ios_open /jam/abc',
    );
    assert.equal(opened.status, 0, opened.stderr);
    assert.match(opened.stdout, /^xcrun simctl openurl SIM music:\/\/\/jam\/abc$/m);
    const matrix = withSideOffline('write_state ios_app music; ios_matrix --out "$state/matrix"');
    assert.equal(matrix.status, 1);
    assert.match(matrix.stderr, /ios matrix lists the movies app's screens, and the after side runs the music app/);
  });

  test("makes the lyrics folder only on a side with music, and cuts the server off only with a simulator", () => {
    // A run of its own: these leave a simulator's id behind, which the other tests must not see.
    const own = { ...remoteEnv, MEDIA_VERIFY_RUN: `guards-${process.pid}` };
    const lyrics = withSide("cmd_lyrics_probe --side after", own);
    assert.equal(lyrics.status, 1);
    assert.match(lyrics.stderr, /the after side has no music/);
    const offline = withSide("cmd_ios --side after offline on", own);
    assert.equal(offline.status, 1);
    assert.match(offline.stderr, /no simulator on the after side/);
    const usage = withSide("write_state ios_udid SIM; cmd_ios --side after offline sideways", own);
    assert.equal(usage.status, 1);
    assert.match(usage.stderr, /ios offline on\|off/);
  });

  test("cuts the server's forward alone, keeps Metro's, and starts again whichever stopped", () => {
    const calls = join(scratch, "forward-calls");
    rmSync(calls, { force: true });
    // Stands in for ssh: a process `ps` shows as `ssh -N`, which is how the helper knows its own.
    const result = withSide(
      `nohup() { echo "$*" >> ${JSON.stringify(calls)}; exec -a "ssh -N stand-in" node -e "setTimeout(() => {}, 30000)"; }
       write_state metro_port 4200
       forwards_up; forward_runs forward_pid && forward_runs server_forward_pid && echo both
       metro="$(read_state forward_pid)"
       write_state ios_udid SIM; cmd_ios --side after offline on
       forward_runs server_forward_pid || echo cut
       [[ "$(read_state forward_pid)" == "$metro" ]] && forward_runs forward_pid && echo metro-kept
       kill "$metro"; cmd_ios --side after offline off
       forward_runs forward_pid && forward_runs server_forward_pid && echo both-again
       forward_stop forward_pid; forward_stop server_forward_pid`,
      { ...remoteEnv, MEDIA_VERIFY_RUN: `forwards-${process.pid}`, MEDIA_VERIFY_FORWARD_SETTLE: "0.2" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      "both",
      "the app's server is out of reach",
      "cut",
      "metro-kept",
      "the app reaches its server again",
      "both-again",
    ]);
    const ports = execFileSync("cat", [calls], { encoding: "utf8" }).trim().split("\n").map((call) => /-R (\d+):/.exec(call)?.[1]);
    assert.deepEqual(ports, ["4200", "4100", "4200", "4100"]);
  });

  test("refuses the music iOS app on an image without the music client before it touches the Mac", () => {
    const result = withSideOffline(
      "write_state people lucia; write_state music_core 0; args=(up --app music); mac=nowhere.invalid cmd_ios_up",
    );
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /the music iOS app signs in to the core's music, which the after side's image does not serve/);
  });

  test("refuses an iOS app it does not know", () => {
    const result = withSideOffline("args=(up --app tv); mac=nowhere.invalid cmd_ios_up");
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /ios up --app must be movies or music, not tv/);
  });
});

describe("the core seed", () => {
  const record = (message, jobId) =>
    `media-1  | ${JSON.stringify({ message, level: "INFO", annotations: { jobId, kind: "movies.trickplay" } })}`;

  test("counts a job open from its claim until it ends, in any order of lines", () => {
    const log = [
      record("CoreJobs.claimed", "a"),
      "2026-11-10T18:12:13Z INFO convex: not a job",
      record("CoreJobs.job_ended", "b"),
      record("CoreJobs.claimed", "b"),
      record("CoreJobs.claimed", "c"),
      '{"message":"CoreJobs.claimed", broken',
    ].join("\n");
    assert.deepEqual(openJobs(log), ["a", "c"]);
    assert.deepEqual(openJobs(`${log}\n${record("CoreJobs.job_ended", "a")}\n${record("CoreJobs.job_ended", "c")}`), []);
  });

  test("waits for every library's scan and every job, and stops at a failed scan", () => {
    const library = (name, status, error = null) => ({ name, scan: status === null ? null : { status, error } });
    const done = [library("Movies", "succeeded"), library("Shows", "succeeded")];
    assert.equal(scanState(done, [], 2), "done");
    assert.equal(scanState(done.slice(0, 1), [], 2), "busy 1 of 2 libraries");
    assert.equal(scanState([done[0], library("Shows", "running")], [], 2), "busy scanning Shows");
    assert.equal(scanState([done[0], library("Shows", null)], [], 2), "busy scanning Shows");
    assert.equal(scanState(done, ["a"], 2), "busy 1 jobs");
    assert.equal(scanState([done[0], library("Shows", "failed", "no folder")], [], 2), "failed Shows: no folder");
  });

  test("shares each library with a person by id or with everyone", () => {
    const libraries = new Map([["Movies", "lib-m"], ["Shows", "lib-s"]]);
    const users = new Map([["mateo", "u-m"], ["aiko", "u-a"], ["kids", "u-k"]]);
    assert.deepEqual(grantArgs({ library: "Movies", principal: "aiko", level: "view" }, libraries, users), {
      resource: { type: "library", id: "lib-m" },
      principal: { kind: "user", userId: "u-a" },
      level: "view",
    });
    assert.deepEqual(grantArgs({ library: "Shows", principal: "household", level: "view" }, libraries, users).principal, {
      kind: "household",
    });
    assert.throws(() => grantArgs({ library: "Music", principal: "aiko", level: "view" }, libraries, users), /no library named Music/);
    assert.throws(() => grantArgs({ library: "Movies", principal: "sam", level: "view" }, libraries, users), /no user sam/);
    for (const grant of GRANTS) assert.ok(grantArgs(grant, libraries, users));
  });

  test("seeds music on the core with the demo data for the same people", () => {
    const libraries = new Map([["Music", "lib-u"]]);
    const users = new Map([["mateo", "u-m"], ["aiko", "u-a"], ["sam", "u-s"]]);
    assert.deepEqual(MUSIC_GRANTS.map((grant) => grantArgs(grant, libraries, users).principal), [
      { kind: "user", userId: "u-m" },
      { kind: "household" },
    ]);
    assert.equal(ALBUMS, 5);
    assert.deepEqual(PLAYLISTS.map((playlist) => [playlist.owner, playlist.name, playlist.songs.length]), [
      ["lucia", "Sunday morning", 4],
      ["lucia", "Deep focus", 4],
      ["mateo", "Lossless", 7],
      ["aiko", "Waltzes", 2],
    ]);
    assert.deepEqual(PLAYLISTS[0].share.map((share) => share.with), ["mateo", "aiko", "sam"]);
    assert.equal(Object.values(LIKES).flat().length, 6);
    assert.deepEqual(LISTENERS, ["lucia", "mateo", "aiko", "sam"]);
    assert.equal(KID_LIMITS.hideExplicitMusic, true);
  });

  test("gives each person's CLI their own config and none of the caller's servers", () => {
    const env = cliEnv("/state", "aiko", { PATH: "/bin", MEDIA_CORE_URL: "http://real", MEDIA_CORE_SIGN_IN_URL: "http://real/api/auth/sign-in", MEDIA_CORE_API_KEY: "k" });
    assert.deepEqual(env, { PATH: "/bin", XDG_CONFIG_HOME: "/state/cli/aiko" });
  });
});
