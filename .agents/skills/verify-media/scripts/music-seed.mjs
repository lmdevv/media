#!/usr/bin/env node
// Seeds a side's old [music] with the movies demo people, their playlists, and likes, through
// invites, the web app, and each person's own API key. Needs music's first-run setup on the demo
// library and <state>/music/key.lucia; fails when anyone sees other albums than the demo data.
//
//   music-seed.mjs --state <side dir> --server <music url>/convex --cli <music.js> --browser <browser.mjs>
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: flags } = parseArgs({
  strict: true,
  options: {
    state: { type: "string" },
    server: { type: "string" },
    cli: { type: "string" },
    browser: { type: "string" },
  },
});

const PEOPLE = [
  { handle: "mateo", name: "Mateo", email: "mateo@movies.local", role: "admin" },
  { handle: "aiko", name: "Aiko", email: "aiko@movies.local", role: "member" },
  { handle: "sam", name: "Sam", email: "sam@movies.local", role: "guest" },
];
const ALBUMS = 5;
const musicState = join(flags.state, "music");

const music = (handle, ...args) => {
  const env = {
    ...process.env,
    MUSIC_SERVER: flags.server,
    MUSIC_API_KEY: readFileSync(join(musicState, `key.${handle}`), "utf8").trim(),
    XDG_CONFIG_HOME: join(musicState, "cli", handle),
  };
  delete env.MUSIC_INSECURE;
  mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
  return JSON.parse(execFileSync("node", [flags.cli, ...args, "--json"], { encoding: "utf8", env }));
};
const browser = (...args) =>
  execFileSync("node", [flags.browser, ...args, "--app", "music", "--state", flags.state], { encoding: "utf8" }).trim();
const fail = (message) => {
  throw new Error(`music seed check failed: ${message}`);
};

const tracks = new Map();
const albums = music("lucia", "albums", "list").items;
for (const { id } of albums) {
  for (const track of music("lucia", "albums", "get", id).tracks) tracks.set(track.title, track);
}
const ids = (...titles) =>
  titles
    .map((title) => tracks.get(title)?.id ?? fail(`the library has no song "${title}"; is this the demo library?`))
    .join(",");

for (const person of PEOPLE) {
  const page = `music-${person.handle}`;
  const { code } = music("lucia", "invites", "create", "--email", person.email, "--role", person.role);
  browser("join", "--page", page, `--code=${code}`, "--name", person.name, "--email", person.email);
  if (person.role !== "guest") writeFileSync(join(musicState, `key.${person.handle}`), `${browser("create-key", "--page", page)}\n`);
  browser("close-page", "--page", page);
}
const people = new Map(music("lucia", "people", "list").map((person) => [person.email, person]));
const user = (handle) => people.get(PEOPLE.find((person) => person.handle === handle).email).id;

const library = music("lucia", "libraries", "list").find((folder) => folder.path === "/music") ?? fail("no /music library");
music("lucia", "libraries", "grant", "--library-id", library.id, "--user-id", user("sam"));

const playlist = (handle, name, description, titles) =>
  music(handle, "playlists", "create", name, "--description", description, "--track-ids", ids(...titles)).playlistId;

const sunday = playlist("lucia", "Sunday morning", "Slow ones for the weekend", [
  "Bell Meditation", "Neptune", "Andromeda", "Wanderer",
]);
music("lucia", "playlists", "share", "--playlist-id", sunday, "--user-id", user("mateo"), "--role", "collaborator");
music("lucia", "playlists", "share", "--playlist-id", sunday, "--user-id", user("aiko"), "--role", "viewer");
music("lucia", "playlists", "share", "--playlist-id", sunday, "--user-id", user("sam"), "--role", "viewer");
playlist("lucia", "Deep focus", "Only for Lucía", ["Hoist", "Decapod", "In Awareness", "Gazing"]);

const lossless = playlist("mateo", "Lossless", "Every FLAC in the library", [
  "wrist watch", "toodaze", "we lift offd", "last march", "reaching", "Drifting Cargo", "Wandering Vessel",
]);
music("mateo", "playlists", "visibility", "--playlist-id", lossless, "--visibility", "shared");
playlist("aiko", "Waltzes", "Only for Aiko", ["Naughty Waltz", "Impromptu"]);

const likes = { lucia: ["Wanderer", "Doppelgänger", "Hoist"], mateo: ["Drifting Cargo"], aiko: ["Neptune", "Naughty Waltz"] };
for (const [handle, titles] of Object.entries(likes)) {
  for (const title of titles) music(handle, "likes", "set", ids(title), "--liked");
}

if (albums.length !== ALBUMS) fail(`Lucía sees ${albums.length} albums, not ${ALBUMS}`);
for (const handle of ["mateo", "aiko"]) {
  const seen = music(handle, "albums", "list").items.length;
  if (seen !== ALBUMS) fail(`${handle} sees ${seen} albums, not ${ALBUMS}`);
}
for (const person of PEOPLE) {
  const role = people.get(person.email)?.role;
  if (role !== person.role) fail(`${person.name} is ${role ?? "missing"} in music, not ${person.role}`);
}

writeFileSync(join(musicState, "people"), "lucia\nmateo\naiko\n");
console.log("seeded music: Mateo (admin), Aiko (member), Sam (guest), 4 playlists, and 6 likes");
