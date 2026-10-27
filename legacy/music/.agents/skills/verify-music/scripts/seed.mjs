#!/usr/bin/env node
// Seeds a side with the demo people and what they made: three people join from invites, then
// each makes playlists, likes songs, and shares through their own API key, as a user would.
// verify-music.sh runs it after first-run setup, against the demo library.
//
//   seed.mjs --state <dir> --server <url> --cli <music.js> --browser <browser.mjs>
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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

// Lucía is the owner that setup created. Everyone signs in with the same password. Sam is a
// guest, and guests can't make API keys, so Sam has no CLI.
const PEOPLE = [
  { handle: "mateo", name: "Mateo", email: "mateo@music.local", role: "member" },
  { handle: "aiko", name: "Aiko", email: "aiko@music.local", role: "member" },
  { handle: "sam", name: "Sam", email: "sam@music.local", role: "guest" },
];

// The admin's key is `key` and the CLI's config is `cli-config`, as verify-music.sh expects.
const keyFile = (handle) => join(flags.state, handle === "lucia" ? "key" : `key.${handle}`);
const configDir = (handle) => join(flags.state, handle === "lucia" ? "cli-config" : `cli-config.${handle}`);

const music = (handle, ...args) =>
  JSON.parse(
    execFileSync("node", [flags.cli, ...args, "--json"], {
      encoding: "utf8",
      env: {
        ...process.env,
        MUSIC_SERVER: flags.server,
        MUSIC_API_KEY: readFileSync(keyFile(handle), "utf8").trim(),
        XDG_CONFIG_HOME: configDir(handle),
      },
    }),
  );
const browser = (...args) =>
  execFileSync("node", [flags.browser, ...args, "--state", flags.state], { encoding: "utf8" }).trim();

const tracks = new Map();
for (const { id } of music("lucia", "albums", "list").items) {
  for (const track of music("lucia", "albums", "get", id).tracks) tracks.set(track.title, track);
}
const ids = (...titles) =>
  titles
    .map((title) => {
      const track = tracks.get(title);
      if (!track) throw new Error(`the demo library has no song "${title}"; is this the demo library?`);
      return track.id;
    })
    .join(",");

for (const person of PEOPLE) {
  const { code } = music("lucia", "invites", "create", "--email", person.email, "--role", person.role);
  browser("join", "--page", person.handle, "--code", code, "--name", person.name, "--email", person.email);
  if (person.role !== "guest") writeFileSync(keyFile(person.handle), `${browser("create-key", "--page", person.handle)}\n`);
  browser("close-page", "--page", person.handle);
}
const people = new Map(music("lucia", "people", "list").map((person) => [person.email, person.id]));
const user = (handle) => people.get(PEOPLE.find((person) => person.handle === handle).email);

// The library is shared, which members can play. A guest plays only what they're granted.
const library = music("lucia", "libraries", "list").find((folder) => folder.path === "/music");
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

console.log("seeded Mateo, Aiko, and Sam, 4 playlists, and 6 likes");
