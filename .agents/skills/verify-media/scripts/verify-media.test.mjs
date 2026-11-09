import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

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

const serveApp = (name) =>
  new Promise((resolve) => {
    const server = createServer((request, response) => {
      if (request.url === "/tone.wav") {
        response.writeHead(200, { "content-type": "audio/wav" }).end(toneWav());
        return;
      }
      const app = name === "media" ? (request.url.startsWith("/movies/") ? "movies" : "account") : name;
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
      for (const name of ["media", "music"]) servers[name] = await serveApp(name);
      host = spawn(
        "node",
        [
          browserJs, "serve", "--state", state,
          "--base", `http://localhost:${portOf(servers.media)}/movies/`,
          "--account", `http://localhost:${portOf(servers.media)}`,
          "--music", `http://localhost:${portOf(servers.music)}`,
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

    test("opens a movies page under /movies, an account page at /, and a music page on music", async () => {
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
      assert.equal(music.stdout.trim(), `http://localhost:${portOf(servers.music)}/`);
      const pages = await browser("pages");
      assert.match(pages.stdout, /^main\tmovies\t/m);
      assert.match(pages.stdout, /^music\tmusic\t/m);
    });

    test("keeps a page in the app it was created for", async () => {
      const result = await browser("--app", "movies", "--page", "music", "open", "/");
      assert.equal(result.status, 1);
      assert.match(result.stderr, /page music is a music page/);
      const moviesOnly = await browser("--page", "music", "invite");
      assert.equal(moviesOnly.status, 1);
      assert.match(moviesOnly.stderr, /unknown music command "invite"/);
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
    const cli = helperCommand("cli", "--app", "music", "--", "albums", "list");
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /no after side in run test-\d+; run `up --side after`/);
    const side = helperCommand("doctor", "--side", "sideways");
    assert.equal(side.status, 1);
    assert.match(side.stderr, /--side must be after or before, not sideways/);
  });

  test("takes down a run that never started", () => {
    const result = helperCommand("down");
    assert.equal(result.status, 0, result.stderr);
  });
});

// A stand-in for Docker whose stack never answers: `compose up` starts a server on the side's port
// that accepts connections and never replies, as a container behind a missing route does.
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
        nohup node -e 'const held = []; require("node:net").createServer((socket) => held.push(socket)).listen(Number(process.argv[1]), "127.0.0.1")' "$port" >/dev/null 2>&1 &
        echo "$!" > "$FAKE_DOCKER_DIR/silent.pid"
      elif [[ "$arg" == down ]]; then
        kill "$(cat "$FAKE_DOCKER_DIR/silent.pid")" 2>/dev/null || true
      elif [[ "$arg" == logs ]]; then
        echo "media-1  | starting"
      fi
    done ;;
esac
`;

describe("verify-media.sh up against a stack that never answers", () => {
  const dir = join(scratch, "fake-docker");
  const library = join(scratch, "silent-library");
  const run = `silent-${process.pid}`;
  const env = {
    ...process.env,
    PATH: `${dir}:${process.env.PATH}`,
    TMPDIR: join(scratch, "silent-tmp"),
    MEDIA_VERIFY_RUN: run,
    MEDIA_VERIFY_HEALTH_SECONDS: "3",
    FAKE_DOCKER_DIR: dir,
  };

  before(() => {
    mkdirSync(join(library, "Movies"), { recursive: true });
    mkdirSync(env.TMPDIR, { recursive: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "docker"), fakeDocker, { mode: 0o755 });
  });

  after(() => {
    const pid = join(dir, "silent.pid");
    if (existsSync(pid)) spawnSync("sh", ["-c", `kill "$(cat '${pid}')" 2>/dev/null || true`]);
    rmSync(here(`../../../../captures/verify/${run}`), { recursive: true, force: true });
  });

  test("gives up at its deadline, names the silent URL and the route to check, and removes the side", async () => {
    const began = Date.now();
    const result = await new Promise((resolve) => {
      execFile(
        helper,
        ["up", "--image", "media:silent", "--library", library, "--no-music", "--no-setup"],
        { encoding: "utf8", env, timeout: 60_000 },
        (error, stdout, stderr) => resolve({ status: error ? error.code : 0, stdout, stderr }),
      );
    });
    const seconds = (Date.now() - began) / 1000;

    assert.equal(result.status, 1, result.stderr);
    assert.ok(seconds < 30, `up returned after ${seconds}s`);
    assert.match(result.stderr, /http:\/\/localhost:\d+\/api\/health never answered/);
    assert.match(result.stderr, /`ip route get 172\.31\.255\.2`/);
    assert.match(result.stderr, /media-1 {2}\| starting/);
    assert.match(result.stderr, /did not become healthy in 3s/);
    const calls = execFileSync("cat", [join(dir, "calls")], { encoding: "utf8" });
    assert.match(calls, /compose .* down --volumes/);
    assert.equal(existsSync(join(env.TMPDIR, "media-verify", run, "after")), false, "the side's state is gone");
  });
});
