#!/usr/bin/env node
// Seeds a side with the demo people and what they watch, through the paths a person uses: the
// owner adds a kids profile and invites three people from the web app, each joins from their
// invite link in a browser of their own, and then everyone uses their own signed-in CLI.
// verify-movies.sh runs it after first-run setup, against the demo library, and it fails when
// anyone sees more or less than the demo data says.
//
//   seed.mjs --state <dir> --server <convex-url> --media-url <url> --cli <movies.js> --browser <browser.mjs>
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  strict: true,
  options: {
    state: { type: "string" },
    server: { type: "string" },
    "media-url": { type: "string" },
    cli: { type: "string" },
    browser: { type: "string" },
  },
});

const PASSWORD = "password123";
// Lucía is the owner that setup created, and her CLI signed in during `up`.
const PEOPLE = [
  { handle: "mateo", name: "Mateo", email: "mateo@movies.local", role: "admin" },
  { handle: "aiko", name: "Aiko", email: "aiko@movies.local", role: "member" },
  { handle: "sam", name: "Sam", email: "sam@movies.local", role: "member" },
];
// Ratings the owner sets, since the demo films ship unrated and a limited profile hides unrated
// titles. The Feature Test stays unrated.
const RATINGS = {
  "Big Buck Bunny": ["G", 0],
  Caminandes: ["TV-Y", 0],
  "Cosmos Laundromat: First Cycle": ["PG", 7],
  "Elephants Dream": ["PG-13", 13],
  Sintel: ["PG-13", 13],
  "Tears of Steel": ["PG-13", 13],
  "Pioneer One": ["TV-14", 14],
};

// The owner's shell may point the CLI at a real server (MEDIA_CONVEX_URL and friends); each
// person's CLI uses only their own config folder.
const env = (handle) => {
  const clean = { ...process.env, XDG_CONFIG_HOME: join(flags.state, "cli", handle) };
  for (const name of ["MEDIA_CONVEX_URL", "MEDIA_SERVER_URL", "MEDIA_API_KEY", "MEDIA_PROFILE", "MEDIA_PASSWORD"]) {
    delete clean[name];
  }
  return clean;
};
const run = (handle, args, input) => spawnSync("node", [flags.cli, ...args], { encoding: "utf8", env: env(handle), input });
const movies = (handle, ...args) => {
  const result = run(handle, args);
  if (result.status !== 0) throw new Error(`${handle}: media ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
  return JSON.parse(result.stdout);
};
const browser = (...args) =>
  execFileSync("node", [flags.browser, ...args, "--state", flags.state], { encoding: "utf8" }).trim();
const fail = (message) => {
  throw new Error(`seed check failed: ${message}`);
};
const names = (titles) => titles.map((title) => title.name).sort();
const same = (actual, expected) => JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort());

const titles = new Map(movies("lucia", "titles", "list", "--limit", "100").items.map((title) => [title.name, title]));
const id = (name) => titles.get(name)?.id ?? fail(`the library has no "${name}"; is this the demo library?`);

// Lucía: a Kids profile with the kids limit (PG) and a PIN, from the web app.
browser("add-profile", "--profile", "Kids", "--kids", "--pin", "1234");
for (const [name, [certification, ageRating]] of Object.entries(RATINGS)) {
  movies("lucia", "metadata", "edit", id(name), "--set", JSON.stringify({ certification, ageRating }));
}

// Mateo, Aiko, and Sam: an invite link each from Admin, Users, accepted in their own browser.
for (const person of PEOPLE) {
  const code = browser("invite", "--invite-role", person.role);
  // One flag word: an invite code can start with a dash, which parseArgs refuses as a separate value.
  browser("join", "--page", person.handle, `--code=${code}`, "--name", person.name, "--email", person.email);
  browser("close-page", "--page", person.handle);
  mkdirSync(join(flags.state, "cli", person.handle), { recursive: true });
  const login = run(
    person.handle,
    ["login", "--server", flags.server, "--media-url", flags["media-url"], "--email", person.email, "--password"],
    PASSWORD,
  );
  if (login.status !== 0) fail(`${person.handle} could not sign the CLI in: ${login.stderr.trim()}`);
}
const users = new Map(movies("lucia", "users", "list").map((user) => [user.email, user.id]));
const user = (handle) => users.get(PEOPLE.find((person) => person.handle === handle).email);

// Movies is for the people Lucía chooses: Aiko. Admins see every library; Sam sees only Shows.
const libraries = movies("lucia", "libraries", "list");
const moviesLibrary = libraries.find((library) => library.kind === "movies") ?? fail("no Movies library");
movies("lucia", "libraries", "update", moviesLibrary.id, "--access", "restricted");
movies("lucia", "users", "set-library-access", "--user-id", user("aiko"), "--library-ids", moviesLibrary.id);

// Aiko: My List, Elephants Dream stopped halfway, and the first two episodes of Pioneer One.
for (const name of ["Sintel", "Tears of Steel", "Caminandes"]) movies("aiko", "my-list", "add", id(name));
const session = movies("aiko", "playback", "create-session", id("Elephants Dream"));
const duration = session.file.probe.durationMs;
const half = Math.round(duration / 2);
movies("aiko", "playback", "report-progress", "--session-id", session.sessionId, "--position-ms", String(half),
  "--duration-ms", String(duration), "--event", "pause");
movies("aiko", "playback", "end-session", "--session-id", session.sessionId, "--position-ms", String(half));
const episodes = movies("aiko", "titles", "episodes", "--title-id", id("Pioneer One"), "--season-number", "1");
const episodeList = Array.isArray(episodes) ? episodes : episodes.items;
for (const episode of episodeList.slice(0, 2)) {
  movies("aiko", "history", "mark-watched", id("Pioneer One"), "--episode-id", episode.id);
}
movies("mateo", "my-list", "add", id("Cosmos Laundromat: First Cycle"));

// Check that everyone sees what the demo data says, through their own CLI.
const allMovies = ["Big Buck Bunny", "Cosmos Laundromat: First Cycle", "Elephants Dream", "Sintel", "Tears of Steel", "[movies] Feature Test"];
const shows = ["Caminandes", "Pioneer One"];
const seen = (handle, ...extra) => names(movies(handle, "titles", "list", "--limit", "100", ...extra).items);
for (const handle of ["lucia", "mateo", "aiko"]) {
  if (!same(seen(handle), [...allMovies, ...shows])) fail(`${handle} sees ${seen(handle).join(", ")}`);
}
if (!same(seen("sam"), shows)) fail(`Sam should see only Shows, but sees ${seen("sam").join(", ")}`);
const samSintel = run("sam", ["titles", "get", id("Sintel")]);
if (samSintel.status !== 5) fail(`Sam opening Sintel should be notFound (exit 5), got ${samSintel.status}`);
const samPlay = run("sam", ["playback", "create-session", id("Sintel")]);
if (samPlay.status === 0) fail("Sam could start Sintel");

const kids = movies("lucia", "profiles", "list").find((profile) => profile.name === "Kids") ?? fail("no Kids profile");
if (!kids.kids || kids.maxAgeRating !== 7 || !kids.hasPin) fail(`Kids is ${JSON.stringify(kids)}`);
const lockedKids = run("lucia", ["titles", "list", "--profile-id", kids.id]);
if (lockedKids.status === 0) fail("the Kids profile listed titles without its PIN");
movies("lucia", "profiles", "unlock", "--profile-id", kids.id, "1234");
const kidsSee = seen("lucia", "--profile-id", kids.id);
movies("lucia", "profiles", "lock", "--profile-id", kids.id);
if (!same(kidsSee, ["Big Buck Bunny", "Caminandes", "Cosmos Laundromat: First Cycle"])) fail(`Kids sees ${kidsSee.join(", ")}`);

const next = movies("aiko", "continue");
const resume = next.find((item) => item.title.name === "Elephants Dream" && item.reason === "resume");
const upNext = next.find((item) => item.title.name === "Pioneer One");
if (!resume || !upNext || upNext.episode?.episodeNumber !== 3) {
  fail(`Aiko's Continue Watching is ${JSON.stringify(next.map((item) => [item.reason, item.title.name, item.episode?.episodeNumber]))}`);
}

writeFileSync(join(flags.state, "people"), "lucia\nmateo\naiko\nsam\n");
console.log(
  [
    "seeded Mateo (admin), Aiko and Sam (members), and Lucía's Kids profile (PG, PIN 1234)",
    `Movies is restricted to Aiko; Sam sees ${seen("sam").join(" and ")}; Kids sees ${kidsSee.join(", ")}`,
    `Aiko resumes Elephants Dream at ${Math.round(half / 1000)}s and Pioneer One at episode 3`,
  ].join("\n"),
);
