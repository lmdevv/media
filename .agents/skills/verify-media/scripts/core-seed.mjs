#!/usr/bin/env node
//   core-seed.mjs wait --state <dir> --cli <media.js> --container <name> --want <libraries>
//   core-seed.mjs seed --state <dir> --server <core convex url> --cli <media.js> --browser <browser.mjs>
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export const PASSWORD = "password123";

// Lucía is the owner that setup created, and her CLI signed in during `up`. The kid is a member
// the owner limits to PG.
export const PEOPLE = [
  { handle: "mateo", role: "admin", joins: "invite" },
  { handle: "aiko", role: "member", joins: "invite" },
  { handle: "sam", role: "member", joins: "invite" },
  { handle: "kids", role: "member", joins: "account" },
];

// Ratings the owner sets, since the demo films ship unrated and the kid's limits hide unrated
// titles. The Feature Test stays unrated.
export const RATINGS = {
  "Big Buck Bunny": ["G", 0],
  Caminandes: ["TV-Y", 0],
  "Cosmos Laundromat: First Cycle": ["PG", 7],
  "Elephants Dream": ["PG-13", 13],
  Sintel: ["PG-13", 13],
  "Tears of Steel": ["PG-13", 13],
  "Pioneer One": ["TV-14", 14],
};

// PG is a minimum viewer age of 7 on the core; unrated titles stay hidden from the kid.
export const KID_LIMITS = { maxMovieAge: 7, hideUnrated: true, hideExplicitMusic: true, libraries: null };

export const ALL_MOVIES = [
  "Big Buck Bunny",
  "Cosmos Laundromat: First Cycle",
  "Elephants Dream",
  "Sintel",
  "Tears of Steel",
  "[movies] Feature Test",
];
export const SHOWS = ["Caminandes", "Pioneer One"];
export const KID_SEES = ["Big Buck Bunny", "Caminandes", "Cosmos Laundromat: First Cycle"];

// Who each library is shared with, past Lucía, who made both and manages them. On the core a
// library is private until shared, admins included, so Mateo manages both; Movies is for Aiko and
// the kid; Shows is for everyone on the server.
export const GRANTS = [
  { library: "Movies", principal: "mateo", level: "manage" },
  { library: "Movies", principal: "aiko", level: "view" },
  { library: "Movies", principal: "kids", level: "view" },
  { library: "Shows", principal: "mateo", level: "manage" },
  { library: "Shows", principal: "household", level: "view" },
];

/**
 * The grant `core.permissions.grants.set` takes for one of GRANTS, given the libraries' ids by name
 * and the users' ids by username.
 */
export const grantArgs = (grant, libraries, users) => {
  const id = libraries.get(grant.library);
  if (id === undefined) throw new Error(`no library named ${grant.library}`);
  const principal =
    grant.principal === "household"
      ? { kind: "household" }
      : { kind: "user", userId: users.get(grant.principal) ?? missing(`user ${grant.principal}`) };
  return { resource: { type: "library", id }, principal, level: grant.level };
};

const missing = (what) => {
  throw new Error(`no ${what}`);
};

/**
 * The core jobs still open in the media service's log: claimed and never ended. The service logs
 * one JSON record per line; the core has no command that lists jobs. Order doesn't count, since
 * Docker keeps the service's two output streams apart.
 */
export const openJobs = (log) => {
  const claimed = new Set();
  const ended = new Set();
  for (const line of log.split("\n")) {
    const start = line.indexOf('{"message":"CoreJobs.');
    if (start < 0) continue;
    let record;
    try {
      record = JSON.parse(line.slice(start));
    } catch {
      continue;
    }
    const jobId = record.annotations?.jobId;
    if (typeof jobId !== "string") continue;
    if (record.message === "CoreJobs.claimed") claimed.add(jobId);
    else if (record.message === "CoreJobs.job_ended") ended.add(jobId);
  }
  return [...claimed].filter((jobId) => !ended.has(jobId));
};

/**
 * Where first scans stand: `failed <error>` when a scan failed, `done` when `want` libraries exist,
 * each scanned with nothing queued or running and no job open, else `busy <why>`.
 */
export const scanState = (libraries, jobs, want) => {
  const failed = libraries.find((library) => library.scan?.status === "failed");
  if (failed) return `failed ${failed.name}: ${failed.scan.error ?? "no error given"}`;
  if (libraries.length < want) return `busy ${libraries.length} of ${want} libraries`;
  const scanning = libraries.filter((library) => library.scan?.status !== "succeeded");
  if (scanning.length > 0) return `busy scanning ${scanning.map((library) => library.name).join(", ")}`;
  if (jobs.length > 0) return `busy ${jobs.length} jobs`;
  return "done";
};

/** The settings in the caller's shell that would point a CLI at another server or person. */
export const FOREIGN_SETTINGS = [
  "MEDIA_CONVEX_URL",
  "MEDIA_SERVER_URL",
  "MEDIA_API_KEY",
  "MEDIA_PROFILE",
  "MEDIA_PASSWORD",
  "MEDIA_CORE_URL",
  "MEDIA_CORE_API_KEY",
  "MEDIA_CORE_ADMIN_KEY",
];

/** The environment for one person's CLI: their own config folder, and none of the caller's settings. */
export const cliEnv = (state, handle, env = process.env) => {
  const clean = { ...env, XDG_CONFIG_HOME: join(state, "cli", handle) };
  for (const name of FOREIGN_SETTINGS) delete clean[name];
  return clean;
};

const sorted = (names) => [...names].sort();
const same = (actual, expected) => JSON.stringify(sorted(actual)) === JSON.stringify(sorted(expected));

function main() {
  const { values: flags, positionals } = parseArgs({
    strict: true,
    allowPositionals: true,
    options: {
      state: { type: "string" },
      server: { type: "string" },
      cli: { type: "string" },
      browser: { type: "string" },
      container: { type: "string" },
      want: { type: "string" },
    },
  });
  const run = (handle, args, input) =>
    spawnSync("node", [flags.cli, ...args], { encoding: "utf8", env: cliEnv(flags.state, handle), input });
  const media = (handle, ...args) => {
    const result = run(handle, args);
    if (result.status !== 0) {
      throw new Error(`${handle}: media ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
    }
    return JSON.parse(result.stdout || "null");
  };
  const json = (handle, args, value) => media(handle, ...args, "--json", JSON.stringify(value));
  const fail = (message) => {
    throw new Error(`seed check failed: ${message}`);
  };

  if (positionals[0] === "wait") return waitForScans();
  if (positionals[0] === "seed") return seed();
  throw new Error("usage: core-seed.mjs wait|seed --state <dir> ...");

  // Waits until the first scans are really done: `want` libraries, each scanned, and no core job
  // open, including the metadata and scrub-thumbnail jobs a scan queues. The quiet must hold for
  // three checks in a row, since a scan's follow-up jobs appear just as it finishes.
  async function waitForScans() {
    let quiet = 0;
    let now = "busy";
    let said = "";
    for (;;) {
      try {
        const listed = media("lucia", "auth", "libraries", "list").page;
        const libraries = listed.map((library) => media("lucia", "auth", "libraries", "get", "--library-id", library.libraryId));
        // The service logs to both streams, and Docker keeps them apart.
        const logs = spawnSync("docker", ["logs", flags.container], { encoding: "utf8", maxBuffer: 1 << 28, timeout: 15_000 });
        if (logs.status !== 0) throw new Error(`docker logs exited ${logs.status}`);
        now = scanState(libraries, openJobs(`${logs.stdout}\n${logs.stderr}`), Number(flags.want));
      } catch (error) {
        now = `busy (${error.message.split("\n")[0]})`;
      }
      if (now.startsWith("failed")) throw new Error(`a first scan ${now}`);
      quiet = now === "done" ? quiet + 1 : 0;
      if (quiet >= 3) return;
      if (now !== said) process.stderr.write(`first scans: ${now}\n`);
      said = now;
      await sleep(2000);
    }
  }

  function seed() {
    const browser = (...args) =>
      execFileSync("node", [flags.browser, ...args, "--state", flags.state], { encoding: "utf8" }).trim();
    const login = (handle) => {
      mkdirSync(join(flags.state, "cli", handle), { recursive: true });
      const result = run(handle, ["auth", "login", "--server", flags.server, "--username", handle], PASSWORD);
      if (result.status !== 0) fail(`${handle} could not sign the CLI in: ${result.stderr.trim()}`);
    };
    const titlesFor = (handle) => media(handle, "movies", "titles", "list", "--limit", "100").page;

    const titles = new Map(titlesFor("lucia").map((title) => [title.name, title]));
    const id = (name) => titles.get(name)?.id ?? fail(`the library has no "${name}"; is this the demo library?`);
    for (const [name, [certification, ageRating]] of Object.entries(RATINGS)) {
      json("lucia", ["movies", "metadata", "edit"], { titleId: id(name), set: { certification, ageRating } });
    }

    for (const person of PEOPLE) {
      if (person.joins === "invite") {
        const code = browser("invite", "--invite-role", person.role);
        // One flag word: a code can start with a dash, which parseArgs refuses as a separate value.
        browser("join", "--page", person.handle, `--code=${code}`, "--username", person.handle);
        browser("close-page", "--page", person.handle);
      } else {
        browser("create-account", "--username", person.handle, "--invite-role", person.role);
      }
      login(person.handle);
    }

    const users = new Map(
      media("lucia", "admin", "users", "list", "--limit", "100").page.map((user) => [user.username, user.userId]),
    );
    const libraries = new Map(
      media("lucia", "auth", "libraries", "list").page.map((library) => [library.name, library.libraryId]),
    );
    for (const grant of GRANTS) json("lucia", ["auth", "grants", "set"], grantArgs(grant, libraries, users));
    const kid = users.get("kids") ?? fail("no kid user");
    json("lucia", ["admin", "restrictions", "set"], { userId: kid, restrictions: KID_LIMITS });
    json("lucia", ["auth", "tiles", "set-listed"], { userId: kid, listed: true });

    for (const name of ["Sintel", "Tears of Steel", "Caminandes"]) {
      media("aiko", "movies", "my-list", "add", "--title-id", id(name));
    }
    const play = media("aiko", "movies", "play", "start", "--title-id", id("Elephants Dream"));
    const duration = play.file.probe.durationMs;
    const half = Math.round(duration / 2);
    json("aiko", ["movies", "play", "report"], {
      fileId: play.file.id,
      positionMs: half,
      durationMs: duration,
      event: "pause",
      playbackId: play.playbackId,
      startedAt: play.startedAt,
    });
    const episodes = media("aiko", "movies", "titles", "episodes", "--title-id", id("Pioneer One"), "--season-number", "1").page;
    for (const episode of [...episodes].sort((a, b) => a.episodeNumber - b.episodeNumber).slice(0, 2)) {
      media("aiko", "movies", "history", "mark-watched", "--title-id", id("Pioneer One"), "--episode-id", episode.id);
    }
    media("mateo", "movies", "my-list", "add", "--title-id", id("Cosmos Laundromat: First Cycle"));

    const seen = (handle) => titlesFor(handle).map((title) => title.name);
    for (const handle of ["lucia", "mateo", "aiko"]) {
      if (!same(seen(handle), [...ALL_MOVIES, ...SHOWS])) fail(`${handle} sees ${seen(handle).join(", ")}`);
    }
    if (!same(seen("sam"), SHOWS)) fail(`Sam should see only Shows, but sees ${seen("sam").join(", ")}`);
    const samSintel = run("sam", ["movies", "titles", "get", "--title-id", id("Sintel")]);
    if (samSintel.status !== 5) fail(`Sam opening Sintel should be notFound (exit 5), got ${samSintel.status}`);
    if (run("sam", ["movies", "play", "start", "--title-id", id("Sintel")]).status === 0) fail("Sam could start Sintel");
    if (!same(seen("kids"), KID_SEES)) fail(`the kid sees ${seen("kids").join(", ")}`);

    const next = media("aiko", "movies", "history", "continue-watching");
    const resume = next.find((item) => item.title.name === "Elephants Dream" && item.reason === "resume");
    const upNext = next.find((item) => item.title.name === "Pioneer One");
    if (!resume || !upNext || upNext.episode?.episodeNumber !== 3) {
      fail(`Aiko's Continue Watching is ${JSON.stringify(next.map((item) => [item.reason, item.title.name, item.episode?.episodeNumber]))}`);
    }

    writeFileSync(join(flags.state, "people"), `lucia\n${PEOPLE.map((person) => person.handle).join("\n")}\n`);
    console.log(
      [
        "seeded Mateo (admin), Aiko and Sam (members), and the kid user kids (PG, unrated hidden)",
        `Movies is shared with Mateo, Aiko, and kids; Sam sees ${seen("sam").join(" and ")}; kids sees ${seen("kids").join(", ")}`,
        `Aiko resumes Elephants Dream at ${Math.round(half / 1000)}s and Pioneer One at episode 3`,
      ].join("\n"),
    );
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
