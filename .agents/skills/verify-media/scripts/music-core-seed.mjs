#!/usr/bin/env node
// Seeds music's demo data on the core, after core-seed.mjs made the people and signed each one's
// media CLI in: the Music library's grants, then the playlists, sharing, and likes old music's seed
// made (music-seed.mjs), each person through their own CLI. Fails when anyone sees other albums
// than the demo data.
//
//   music-core-seed.mjs --state <side dir> --cli <media.js>
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { cliEnv, grantArgs } from "./core-seed.mjs";

/** The demo library's albums under Music. */
export const ALBUMS = 5;

// Who the Music library is shared with, past Lucía, who made it: Mateo manages it, and everyone on
// the server plays it, as old music's shared /music folder let everyone play, Sam included. The
// kid's restrictions (core-seed.mjs) hide explicit songs from them.
export const MUSIC_GRANTS = [
  { library: "Music", principal: "mateo", level: "manage" },
  { library: "Music", principal: "household", level: "view" },
];

// Old music's demo playlists, by owner, with who each is shared with.
export const PLAYLISTS = [
  {
    owner: "lucia",
    name: "Sunday morning",
    description: "Slow ones for the weekend",
    songs: ["Bell Meditation", "Neptune", "Andromeda", "Wanderer"],
    share: [
      { with: "mateo", role: "collaborator" },
      { with: "aiko", role: "viewer" },
      { with: "sam", role: "viewer" },
    ],
  },
  {
    owner: "lucia",
    name: "Deep focus",
    description: "Only for Lucía",
    songs: ["Hoist", "Decapod", "In Awareness", "Gazing"],
    share: [],
  },
  {
    owner: "mateo",
    name: "Lossless",
    description: "Every FLAC in the library",
    songs: ["wrist watch", "toodaze", "we lift offd", "last march", "reaching", "Drifting Cargo", "Wandering Vessel"],
    share: [],
    visibility: "shared",
  },
  { owner: "aiko", name: "Waltzes", description: "Only for Aiko", songs: ["Naughty Waltz", "Impromptu"], share: [] },
];

export const LIKES = {
  lucia: ["Wanderer", "Doppelgänger", "Hoist"],
  mateo: ["Drifting Cargo"],
  aiko: ["Neptune", "Naughty Waltz"],
};

/** The people who play every demo album. */
export const LISTENERS = ["lucia", "mateo", "aiko", "sam"];

function main() {
  const { values: flags } = parseArgs({
    strict: true,
    options: { state: { type: "string" }, cli: { type: "string" } },
  });
  const run = (handle, args) =>
    spawnSync("node", [flags.cli, ...args], { encoding: "utf8", env: cliEnv(flags.state, handle) });
  const media = (handle, ...args) => {
    const result = run(handle, args);
    if (result.status !== 0) {
      throw new Error(`${handle}: media ${args.join(" ")} exited ${result.status}: ${result.stderr.trim()}`);
    }
    return JSON.parse(result.stdout || "null");
  };
  const json = (handle, args, value) => media(handle, ...args, "--json", JSON.stringify(value));
  const fail = (message) => {
    throw new Error(`music seed check failed: ${message}`);
  };

  const users = new Map(
    media("lucia", "admin", "users", "list", "--limit", "100").page.map((user) => [user.username, user.userId]),
  );
  const libraries = new Map(
    media("lucia", "auth", "libraries", "list").page.map((library) => [library.name, library.libraryId]),
  );
  for (const grant of MUSIC_GRANTS) json("lucia", ["auth", "grants", "set"], grantArgs(grant, libraries, users));

  const albums = media("lucia", "music", "albums", "list", "--limit", "100").page;
  const tracks = new Map();
  for (const album of albums) {
    for (const track of media("lucia", "music", "albums", "tracks", "--album-id", album.id, "--limit", "100").page) {
      tracks.set(track.title, track.id);
    }
  }
  const ids = (titles) =>
    titles.map((title) => tracks.get(title) ?? fail(`the library has no song "${title}"; is this the demo library?`));

  for (const playlist of PLAYLISTS) {
    const created = json(playlist.owner, ["music", "playlists", "create"], {
      name: playlist.name,
      description: playlist.description,
      trackIds: ids(playlist.songs),
    });
    if (created.rest.length > 0) fail(`${playlist.name} left ${created.rest.length} songs to add`);
    for (const share of playlist.share) {
      json(playlist.owner, ["music", "playlists", "share"], {
        playlistId: created.playlistId,
        userId: users.get(share.with) ?? fail(`no user ${share.with}`),
        role: share.role,
      });
    }
    if (playlist.visibility === "shared") {
      json(playlist.owner, ["music", "playlists", "visibility"], { playlistId: created.playlistId, visibility: "shared" });
    }
  }

  for (const [handle, titles] of Object.entries(LIKES)) {
    for (const trackId of ids(titles)) json(handle, ["music", "likes", "set"], { trackId, liked: true });
  }

  for (const handle of LISTENERS) {
    const seen = media(handle, "music", "albums", "list", "--limit", "100").page.length;
    if (seen !== ALBUMS) fail(`${handle} sees ${seen} albums, not ${ALBUMS}`);
  }
  const sunday = media("aiko", "music", "playlists", "shared", "--limit", "100").page.map((playlist) => playlist.name);
  if (!sunday.includes("Sunday morning")) fail(`Aiko's shared playlists are ${sunday.join(", ")}`);

  console.log(
    `seeded music on the core: the Music library for everyone (Mateo manages), ${PLAYLISTS.length} playlists, and ${Object.values(LIKES).flat().length} likes`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
