/**
 * Authorization and auth checks against a real self-hosted Convex backend. Set
 * MUSIC_SECURITY_E2E_SERVER to its URL and MUSIC_SECURITY_E2E_MEDIA_SECRET to its
 * MEDIA_SERVICE_SECRET, for example after `scripts/dev-backend.sh sec 3810`:
 *
 *   MUSIC_SECURITY_E2E_SERVER=http://127.0.0.1:3810 \
 *   MUSIC_SECURITY_E2E_MEDIA_SECRET="$(cd packages/backend && pnpm exec convex env get MEDIA_SERVICE_SECRET)" \
 *   pnpm vitest run packages/backend
 *
 * Without them the suite is skipped. On an empty server the first test races two sign-ups for
 * the owner account; later runs sign in as whichever of them won and skip that test.
 */
import { createHash } from "node:crypto";

import {
  AlbumId,
  ApiKeyId,
  ArtistId,
  DeviceId,
  InviteId,
  JobId,
  LibraryId,
  PlaylistId,
  PlaylistItemId,
  TrackId,
  UserId,
} from "@music/commands/ids";
import type { AssignableRole, Role } from "@music/commands/models";
import { can } from "@music/commands/permissions";
import { commands, isCommandName } from "@music/commands/registry";
import type { CommandResult } from "@music/commands/registry";
import { inviteLookup, passwordResetLookup, setupStatus } from "@music/sdk/functions";
import { makeFunctionReference } from "convex/server";
import { beforeAll, describe, expect, it } from "vitest";

import {
  anonymous,
  expectReadFailure,
  expectRunFailure,
  failure,
  failureCode,
  passwordSignIn,
  resetPassword,
  runId,
  signIn,
  signOut,
  signUp,
  upsertTracks,
  withTokens,
  type Session,
} from "./harness";

const server = process.env["MUSIC_SECURITY_E2E_SERVER"] ?? "";

const mediaSecret = process.env["MUSIC_SECURITY_E2E_MEDIA_SECRET"] ?? "";

/** One file as the media service reports it. */
interface ScannedSong {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly title: string;
  readonly artist: string;
  readonly album: string;
  readonly durationMs: number;
  readonly codec: string;
  readonly lossless: boolean;
  readonly artHash?: string;
  readonly folderArt?: string;
  readonly lyricsFiles: string;
  readonly lyricsReader: number;
  readonly lyrics: ReadonlyArray<never>;
}

/** No lyric files and no lyrics, from no lyrics reader. */
const NO_LYRICS = { lyricsFiles: "", lyricsReader: 0, lyrics: [] } as const;

/** The one song of the cover test, with the art the media service found for it. */
const coverSong = (artHash: string, folderArt: string): ScannedSong => ({
  path: "Album/song.flac",
  size: 1234,
  mtimeMs: 1_700_000_000_000,
  title: `Cover Song ${TOKEN}`,
  artist: `Painter ${TOKEN}`,
  album: `Canvas ${TOKEN}`,
  durationMs: 100_000,
  codec: "flac",
  lossless: true,
  artHash,
  folderArt,
  ...NO_LYRICS,
});

/** A song of the cover test's album at `path`, with the art the media service found for it. */
const canvasSong = (
  path: string,
  art: Pick<ScannedSong, "artHash" | "folderArt">,
): ScannedSong => ({
  path,
  size: path.length * 100,
  mtimeMs: 1_700_000_000_000,
  title: `Cover ${path} ${TOKEN}`,
  artist: `Painter ${TOKEN}`,
  album: `Canvas ${TOKEN}`,
  durationMs: 100_000,
  codec: "flac",
  lossless: true,
  ...NO_LYRICS,
  ...art,
});

const upsertTracksRef = makeFunctionReference<
  "mutation",
  { secret: string; libraryId: string; tracks: ReadonlyArray<ScannedSong> },
  { upserted: number }
>("media:upsertTracks");

const moveTracksRef = makeFunctionReference<
  "mutation",
  {
    secret: string;
    libraryId: string;
    moves: ReadonlyArray<{ from: string; track: ScannedSong }>;
  },
  { moved: number }
>("media:moveTracks");

const fingerprintsRef = makeFunctionReference<
  "query",
  { secret: string; libraryId: string; cursor: string | null },
  {
    files: ReadonlyArray<{
      path: string;
      missing: boolean;
      folderArt?: string;
      durationMs?: number;
      title?: string;
      artist?: string;
      album?: string;
    }>;
    cursor: string;
    done: boolean;
  }
>("media:fingerprints");

const artHashesRef = makeFunctionReference<
  "query",
  { secret: string; table: "tracks" | "albums" | "artists"; cursor: string | null },
  { hashes: ReadonlyArray<string>; cursor: string; done: boolean }
>("media:artHashes");

const PASSWORD = "security-e2e-password";

const RACERS = ["race-a@music.test", "race-b@music.test"] as const;

const id = runId();

/** Every track title, album, and artist carries this token, so search finds this run's catalog. */
const TOKEN = `run${id}`;

type Track = CommandResult<"search">["tracks"][number];

interface Fixture {
  /** Outcome of the two concurrent first sign-ups, when the server started empty. */
  readonly race: { readonly fulfilled: number; readonly codes: ReadonlyArray<string> } | null;
  readonly usersAfterRace: number;
  /** The owner: the first account. Owns the shared library and the private library `alpha`. */
  readonly adminA: Session;
  /** A second admin who owns the private library `beta`. */
  readonly adminB: Session;
  readonly member: Session;
  /** Added to no library to begin with. */
  readonly guest: Session;
  readonly shared: { readonly libraryId: LibraryId; readonly track: Track };
  readonly alpha: { readonly libraryId: LibraryId; readonly jobId: JobId; readonly track: Track };
  readonly beta: { readonly libraryId: LibraryId; readonly jobId: JobId; readonly track: Track };
}

const findTrack = async (session: Session, title: string): Promise<Track> => {
  const results = await session.music.read("search", { query: TOKEN, limit: 50 });
  const track = results.tracks.find((candidate) => candidate.title === title);

  if (track === undefined) throw new Error(`Seeded track ${title} is not searchable by its owner`);

  return track;
};

/** This run's names that carry an accent or ß; earlier runs on the same server match too. */
const accentedOnly = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  names.filter((name) => /[äöüß]/u.test(name) && name.endsWith(TOKEN));

/** Every page of a paginated list command, flattened. */
const allPages = async <Item>(
  read: (cursor: string | undefined) => Promise<{
    readonly items: ReadonlyArray<Item>;
    readonly cursor: string;
    readonly done: boolean;
  }>,
): Promise<ReadonlyArray<Item>> => {
  const collect = async (
    cursor: string | undefined,
    seen: ReadonlyArray<Item>,
  ): Promise<ReadonlyArray<Item>> => {
    const page = await read(cursor);
    const items = [...seen, ...page.items];

    return page.done ? items : collect(page.cursor, items);
  };

  return collect(undefined, []);
};

const signUpAdmin = async (): Promise<Pick<Fixture, "race" | "usersAfterRace" | "adminA">> => {
  const status = await anonymous(server).convex.query(setupStatus, {});

  if (status.hasUsers) {
    const attempts = await Promise.allSettled(
      RACERS.map((email) => passwordSignIn(server, email, PASSWORD)),
    );

    const admin = attempts.find((attempt) => attempt.status === "fulfilled");

    if (admin === undefined) {
      throw new Error("The server already has users; point the suite at a fresh backend");
    }

    return { race: null, usersAfterRace: 0, adminA: admin.value };
  }

  const attempts = RACERS.map((email) => signUp(server, { email, password: PASSWORD }));

  const [settled, codes] = await Promise.all([
    Promise.allSettled(attempts),
    Promise.all(attempts.map(failureCode)),
  ]);

  const winner = settled.find((attempt) => attempt.status === "fulfilled");

  if (winner === undefined) throw new Error("Neither first sign-up succeeded");

  const people = await winner.value.music.read("people.list", {});

  return {
    race: { fulfilled: codes.filter((code) => code === "succeeded").length, codes },
    usersAfterRace: people.length,
    adminA: winner.value,
  };
};

const invite = async (admin: Session, email: string, role: AssignableRole): Promise<Session> => {
  const created = await admin.music.run("invites.create", { email, role });

  return signUp(server, { email, password: PASSWORD, inviteCode: created.code });
};

const setup = async (): Promise<Fixture> => {
  const { race, usersAfterRace, adminA } = await signUpAdmin();
  const adminB = await invite(adminA, `admin-b-${id}@music.test`, "admin");
  const member = await invite(adminA, `member-${id}@music.test`, "member");
  const guest = await invite(adminA, `guest-${id}@music.test`, "guest");

  const shared = await adminA.music.run("libraries.create", {
    name: `Shared ${id}`,
    path: `/security-${id}/shared`,
  });

  const alpha = await adminA.music.run("libraries.create", {
    name: `Alpha ${id}`,
    path: `/security-${id}/alpha`,
    visibility: "private",
  });

  const beta = await adminB.music.run("libraries.create", {
    name: `Beta ${id}`,
    path: `/security-${id}/beta`,
    visibility: "private",
  });

  const seed = (libraryId: string, name: string, art: string) =>
    upsertTracks(server, mediaSecret, libraryId, [
      {
        path: `${name}/song.flac`,
        title: `${name} Song ${TOKEN}`,
        artist: `${name} Artist ${TOKEN}`,
        album: `${name} Album ${TOKEN}`,
        artHash: art.repeat(64),
      },
    ]);

  await seed(shared.libraryId, "Open", "1");
  await seed(alpha.libraryId, "Alpha", "2");
  await seed(beta.libraryId, "Beta", "3");

  return {
    race,
    usersAfterRace,
    adminA,
    adminB,
    member,
    guest,
    shared: {
      libraryId: shared.libraryId,
      track: await findTrack(adminA, `Open Song ${TOKEN}`),
    },
    alpha: { ...alpha, track: await findTrack(adminA, `Alpha Song ${TOKEN}`) },
    beta: { ...beta, track: await findTrack(adminB, `Beta Song ${TOKEN}`) },
  };
};

/**
 * Checks that `viewer` cannot hear or use anything in the library `hidden`, through every command
 * that lists, searches, or takes an ID of library-owned data. An admin manages every library, so
 * they see that it exists (unreadable) and its jobs, and nothing in it.
 */
const expectInvisible = async (
  viewer: Session,
  hidden: Fixture["alpha"],
  visible: Fixture["shared"],
): Promise<void> => {
  const { track } = hidden;
  const role = (await viewer.music.read("account.me", {})).role;
  const libraries = await viewer.music.read("libraries.list", {});
  const listed = libraries.find((library) => library.id === hidden.libraryId);

  expect(libraries.map((library) => library.id)).toContain(visible.libraryId);

  // Admins see that it exists; only the server's owner, who manages it, sees its folder.
  if (can(role, "owner")) expect(listed).toMatchObject({ readable: false, manageable: true });
  else if (can(role, "admin")) {
    expect(listed).toMatchObject({ readable: false, manageable: false, path: null });
  } else expect(listed).toBeUndefined();

  const search = await viewer.music.read("search", { query: TOKEN, limit: 50 });

  expect(search.tracks.map((found) => found.id)).not.toContain(track.id);
  expect(search.albums.map((found) => found.id)).not.toContain(track.albumId);
  expect(search.artists.map((found) => found.id)).not.toContain(track.artistId);
  expect(search.tracks.map((found) => found.id)).toContain(visible.track.id);

  const tracks = await allPages((cursor) =>
    viewer.music.read(
      "tracks.list",
      cursor === undefined ? { limit: 200 } : { cursor, limit: 200 },
    ),
  );

  const albums = await allPages((cursor) =>
    viewer.music.read(
      "albums.list",
      cursor === undefined ? { limit: 200 } : { cursor, limit: 200 },
    ),
  );

  const artists = await allPages((cursor) =>
    viewer.music.read(
      "artists.list",
      cursor === undefined ? { limit: 200 } : { cursor, limit: 200 },
    ),
  );

  expect(tracks.map((found) => found.id)).not.toContain(track.id);
  expect(albums.map((found) => found.id)).not.toContain(track.albumId);
  expect(artists.map((found) => found.id)).not.toContain(track.artistId);

  const home = await viewer.music.read("library.home", {});

  expect(home.recentlyAdded.map((album) => album.id)).not.toContain(track.albumId);

  await expectReadFailure(viewer, "albums.get", { albumId: track.albumId }, "not_found");
  await expectReadFailure(viewer, "artists.get", { artistId: track.artistId }, "not_found");
  await expectReadFailure(
    viewer,
    "stream.url",
    { trackId: track.id, profile: "original" },
    "not_found",
  );

  await expectRunFailure(viewer, "likes.set", { trackId: track.id, liked: true }, "not_found");
  await expectRunFailure(viewer, "playback.play", { trackIds: [track.id] }, "not_found");
  await expectRunFailure(viewer, "queue.add", { trackIds: [track.id] }, "not_found");
  await expectRunFailure(
    viewer,
    "playlists.create",
    { name: "Sneaky", trackIds: [track.id] },
    "not_found",
  );

  if (can(role, "owner")) return;
  const jobs = await viewer.music.read("jobs.list", {});

  expect(jobs.map((job) => job.libraryId)).not.toContain(hidden.libraryId);
  expect(jobs.map((job) => job.id)).not.toContain(hidden.jobId);
  await expectReadFailure(viewer, "jobs.get", { jobId: hidden.jobId }, "not_found");
};

/**
 * Claims a library's real folder, as the media service does before every scan, with the folder's
 * identity and its parents' (made up here; the media service reads them with `stat`).
 */
const claimRoot = (
  libraryId: string,
  realPath: string,
  rootIds: ReadonlyArray<string>,
  fsPath: string | null = null,
  bootId: string | null = "security-boot",
) =>
  anonymous(server).convex.mutation(
    makeFunctionReference<
      "mutation",
      {
        secret: string;
        libraryId: string;
        realPath: string;
        rootIds: ReadonlyArray<string>;
        fsPath: string | null;
        bootId: string | null;
      },
      { ok: boolean; error?: string }
    >("media:claimRoot"),
    { secret: mediaSecret, libraryId, realPath, rootIds, fsPath, bootId },
  );

const pause = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Waits until `sessions` holds at least `count`, so a race starts once the sign-ins are really
 * landing, however slow the machine; gives up after about 30 seconds.
 */
const opened = async (
  sessions: ReadonlyArray<unknown>,
  count: number,
  attemptsLeft = 600,
): Promise<void> => {
  if (sessions.length >= count || attemptsLeft === 0) return;

  await pause(50);

  return opened(sessions, count, attemptsLeft - 1);
};

/**
 * Sign-ins at once in `raceSignIns`. Each checks a password with scrypt inside a Convex
 * mutation, so a small CI runner keeps up with about 8; 24, as the security review ran it, shows
 * the old OCC failures on a workstation (`MUSIC_SIGN_IN_LOOPS=24 scripts/backend-e2e.sh security`).
 */
const SIGN_IN_LOOPS = Number(process.env["MUSIC_SIGN_IN_LOOPS"] ?? "8");

/**
 * Signs in as `email` with `PASSWORD` from `SIGN_IN_LOOPS` loops at once, the way a script hammering sign-in
 * would; once sign-ins are landing, runs `act` against them, then stops the loops, even when
 * `act` fails. Returns what `act` returned and every session that opened.
 */
const raceSignIns = async <A>(
  email: string,
  act: () => Promise<A>,
): Promise<{ readonly result: A; readonly sessions: ReadonlyArray<Session> }> => {
  const sessions: Array<Session> = [];
  const failures: Array<string> = [];
  const stop = { done: false };

  const loop = async (): Promise<void> => {
    if (stop.done) return;

    const session = await passwordSignIn(server, email, PASSWORD).catch((error: Error) => {
      failures.push(error.message);

      return null;
    });

    if (session !== null) sessions.push(session);

    return loop();
  };

  const loops = Promise.all(Array.from({ length: SIGN_IN_LOOPS }, loop));

  try {
    await opened(sessions, 1);

    if (sessions.length === 0) {
      throw new Error(`No sign-in opened a session; the first failure: ${failures[0] ?? "none"}`);
    }

    return { result: await act(), sessions };
  } finally {
    stop.done = true;
    await loops;
  }
};

/** The outcome of reading as each of `sessions`: a set of one code when they all agree. */
const endedEverywhere = async (sessions: ReadonlyArray<Session>) =>
  new Set(await Promise.all(sessions.map((one) => failureCode(one.music.read("account.me", {})))));

describe.skipIf(server === "" || mediaSecret === "")("backend authorization", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await setup();
  }, 120_000);

  it("creates exactly one owner when two people sign up on an empty server at once", (context) => {
    const { race, usersAfterRace } = fixture;

    if (race === null) {
      context.skip("The server already had users");

      return;
    }

    expect(race.fulfilled).toBe(1);
    expect(race.codes.toSorted()).toEqual(["signup_closed", "succeeded"]);
    expect(usersAfterRace).toBe(1);
  });

  it("hides another user's private library from a member", async () => {
    await expectInvisible(fixture.member, fixture.alpha, fixture.shared);
    await expectInvisible(fixture.member, fixture.beta, fixture.shared);
  });

  it("keeps another admin's private library unheard and out of an admin's hands", async () => {
    const { adminA, adminB, alpha, beta, shared } = fixture;
    const { id: adminBId } = await adminB.music.read("account.me", {});

    await expectInvisible(adminB, alpha, shared);
    await expectInvisible(adminA, beta, shared);

    // An admin manages only libraries they can hear: everything else about it is not found.
    const unheard = { libraryId: alpha.libraryId };

    await expectRunFailure(
      adminB,
      "libraries.update",
      { ...unheard, visibility: "shared" },
      "not_found",
    );
    await expectRunFailure(
      adminB,
      "libraries.grant",
      { ...unheard, userId: adminBId },
      "not_found",
    );
    await expectRunFailure(adminB, "libraries.scan", unheard, "not_found");
    await expectRunFailure(adminB, "libraries.update", { ...unheard, name: "Mine" }, "not_found");
    await expectRunFailure(adminB, "jobs.cancel", { jobId: alpha.jobId }, "not_found");
    await expectReadFailure(adminB, "jobs.get", { jobId: alpha.jobId }, "not_found");

    // The delete-and-re-add takeover: remove the folder, add it back as one's own, scan it.
    await expectRunFailure(adminB, "libraries.delete", unheard, "not_found");

    const readded = await failureCode(
      adminB.music.run("libraries.create", { name: "Mine", path: `/security-${id}/alpha` }),
    );

    expect(readded).toBe("conflict");

    // Had it worked, the scan would index the same files into a library the attacker owns.
    const stolen = await adminB.music.read("search", { query: `Alpha ${TOKEN}`, limit: 50 });

    expect(stolen.tracks.map((found) => found.id)).not.toContain(alpha.track.id);

    const own = await adminA.music.read("libraries.list", {});

    expect(own.find((library) => library.id === alpha.libraryId)).toMatchObject({
      readable: true,
    });
  });

  it("finds accented names typed without accents, only in libraries the viewer can read", async () => {
    const { adminA, member, shared, alpha } = fixture;

    const accented = (folder: string) => ({
      path: `${folder}/doppelganger.flac`,
      title: `Doppelgänger ${TOKEN}`,
      artist: `Mötley Crüe ${TOKEN}`,
      album: `Straße ${TOKEN}`,
      artHash: "4".repeat(64),
    });

    await upsertTracks(server, mediaSecret, shared.libraryId, [accented("Open")]);
    await upsertTracks(server, mediaSecret, alpha.libraryId, [accented("Alpha")]);

    // Search matches any word, so the run's other names come back too; keep the accented ones.
    const search = async (session: Session, query: string) => {
      const results = await session.music.read("search", { query: `${query} ${TOKEN}`, limit: 50 });

      return {
        tracks: accentedOnly(results.tracks.map((track) => track.title)),
        albums: accentedOnly(results.albums.map((album) => album.title)),
        artists: accentedOnly(results.artists.map((artist) => artist.name)),
      };
    };

    const own = await search(adminA, "doppelganger");

    expect(own.tracks).toEqual([`Doppelgänger ${TOKEN}`, `Doppelgänger ${TOKEN}`]);
    expect((await search(adminA, "STRASSE")).albums).toEqual([
      `Straße ${TOKEN}`,
      `Straße ${TOKEN}`,
    ]);

    expect(await search(member, "motley crue")).toEqual({
      tracks: [`Doppelgänger ${TOKEN}`],
      albums: [`Straße ${TOKEN}`],
      artists: [`Mötley Crüe ${TOKEN}`],
    });
  });

  it("refuses IDs from one table where another table's ID belongs", async () => {
    const { member, adminA, shared, alpha } = fixture;
    const { track } = shared;
    const playlist = await member.music.run("playlists.create", { name: `Mine ${id}` });

    await expectReadFailure(member, "albums.get", { albumId: AlbumId.make(track.id) }, "not_found");
    await expectReadFailure(
      member,
      "artists.get",
      { artistId: ArtistId.make(track.albumId) },
      "not_found",
    );

    await expectReadFailure(
      member,
      "stream.url",
      { trackId: TrackId.make(track.albumId), profile: "original" },
      "not_found",
    );

    await expectReadFailure(
      member,
      "playlists.get",
      { playlistId: PlaylistId.make(track.id) },
      "not_found",
    );

    await expectRunFailure(
      member,
      "playlists.remove",
      { playlistId: playlist.playlistId, itemId: PlaylistItemId.make(track.id) },
      "not_found",
    );

    await expectRunFailure(
      member,
      "keys.revoke",
      { apiKeyId: ApiKeyId.make(playlist.playlistId) },
      "not_found",
    );

    await expectReadFailure(
      member,
      "jobs.get",
      { jobId: JobId.make(alpha.libraryId) },
      "not_found",
    );
    await expectRunFailure(
      adminA,
      "libraries.scan",
      { libraryId: LibraryId.make(alpha.jobId) },
      "not_found",
    );
  });

  it("keeps playlists, keys, devices, and playback sessions with their owner", async () => {
    const { adminA, member, shared } = fixture;
    const trackIds = [shared.track.id];

    const { playlistId } = await adminA.music.run("playlists.create", {
      name: `A ${id}`,
      trackIds,
    });

    const owned = await adminA.music.read("playlists.get", { playlistId });
    const [item] = owned.items;

    if (item === undefined) throw new Error("The owner's playlist lost its song");

    await expectReadFailure(member, "playlists.get", { playlistId }, "not_found");
    await expectRunFailure(member, "playlists.rename", { playlistId, name: "Mine" }, "not_found");
    await expectRunFailure(member, "playlists.add", { playlistId, trackIds }, "not_found");
    await expectRunFailure(
      member,
      "playlists.remove",
      { playlistId, itemId: item.itemId },
      "not_found",
    );

    await expectRunFailure(member, "playlists.delete", { playlistId }, "not_found");
    expect((await member.music.read("playlists.list", {})).map((list) => list.id)).not.toContain(
      playlistId,
    );

    const { apiKey } = await adminA.music.run("keys.create", { name: `A key ${id}` });

    await expectRunFailure(member, "keys.revoke", { apiKeyId: apiKey.id }, "not_found");
    expect((await member.music.read("keys.list", {})).map((key) => key.id)).not.toContain(
      apiKey.id,
    );

    const deviceId = DeviceId.make(`a-device-${id}`);

    await adminA.music.run("devices.heartbeat", { deviceId, name: "A's laptop", kind: "web" });
    await adminA.music.run("playback.play", { trackIds, deviceId });
    expect((await member.music.read("devices.list", {})).map((device) => device.id)).not.toContain(
      deviceId,
    );

    await expectRunFailure(member, "playback.transfer", { deviceId }, "not_found");
    await member.music.run("playback.pause", {});
    await member.music.run("queue.clear", {});

    const theirs = await adminA.music.read("playback.state", {});

    expect(theirs.playing).toBe(true);
    expect(theirs.queue.map((track) => track.id)).toEqual(trackIds);
    expect((await member.music.read("playback.state", {})).activeDevice?.id).not.toBe(deviceId);
  });

  it("keeps admin commands for admins", async () => {
    const { member, shared, alpha } = fixture;

    await expectReadFailure(member, "people.list", {}, "forbidden");
    await expectReadFailure(member, "invites.list", {}, "forbidden");
    await expectRunFailure(member, "invites.create", {}, "forbidden");
    await expectRunFailure(
      member,
      "libraries.create",
      { name: "Mine", path: `/security-${id}/member` },
      "forbidden",
    );

    await expectRunFailure(member, "libraries.scan", { libraryId: shared.libraryId }, "forbidden");
    await expectRunFailure(
      member,
      "libraries.delete",
      { libraryId: shared.libraryId },
      "forbidden",
    );
    await expectRunFailure(member, "jobs.cancel", { jobId: alpha.jobId }, "forbidden");

    const created = await fixture.adminA.music.run("invites.create", {});

    await expectRunFailure(member, "invites.revoke", { inviteId: created.id }, "forbidden");
  });

  it("answers signed-out callers with nothing but first-run state", async () => {
    const visitor = anonymous(server);

    await expectReadFailure(visitor, "account.me", {}, "unauthenticated");
    await expectReadFailure(visitor, "library.home", {}, "unauthenticated");
    await expectReadFailure(
      visitor,
      "stream.url",
      { trackId: fixture.shared.track.id, profile: "original" },
      "unauthenticated",
    );

    await expectRunFailure(visitor, "playback.pause", {}, "unauthenticated");

    expect(await visitor.convex.query(setupStatus, {})).toEqual({
      hasUsers: true,
      hasLibraries: true,
    });

    expect(await visitor.convex.query(inviteLookup, { code: "not-a-code" })).toEqual({
      state: "invalid",
    });
  });

  it("keeps a song's likes and playlist entries when the media service moves its file", async () => {
    const { adminA } = fixture;
    // The media service's connection: no user, only the shared secret.
    const media = anonymous(server).convex;

    const { libraryId } = await adminA.music.run("libraries.create", {
      name: `Moves ${id}`,
      path: `/security-${id}/moves`,
    });

    const song = {
      path: "Before/song.flac",
      size: 4321,
      mtimeMs: 1_700_000_000_000,
      title: `Moving Song ${TOKEN}`,
      artist: `Mover ${TOKEN}`,
      album: `Boxes ${TOKEN}`,
      durationMs: 200_000,
      codec: "flac",
      lossless: true,
      ...NO_LYRICS,
    };

    await media.mutation(upsertTracksRef, { secret: mediaSecret, libraryId, tracks: [song] });
    const before = await findTrack(adminA, song.title);

    await adminA.music.run("likes.set", { trackId: before.id, liked: true });

    const { playlistId } = await adminA.music.run("playlists.create", {
      name: `Moves ${id}`,
      trackIds: [before.id],
    });

    expect(
      await media.mutation(moveTracksRef, {
        secret: mediaSecret,
        libraryId,
        moves: [{ from: song.path, track: { ...song, path: "After/song.flac" } }],
      }),
    ).toEqual({ moved: 1, released: [] });

    expect((await findTrack(adminA, song.title)).id).toBe(before.id);
    expect((await adminA.music.read("likes.list", {})).map((track) => track.id)).toContain(
      before.id,
    );
    expect(
      (await adminA.music.read("playlists.get", { playlistId })).items.map(
        (item) => item.track?.id,
      ),
    ).toEqual([before.id]);

    const known = await media.query(fingerprintsRef, {
      secret: mediaSecret,
      libraryId,
      cursor: null,
    });

    expect(known.files).toEqual([
      expect.objectContaining({
        path: "After/song.flac",
        missing: false,
        durationMs: song.durationMs,
        title: song.title,
        artist: song.artist,
        album: song.album,
      }),
    ]);
  });

  it("moves an album's art to a replaced cover and lists only the art in use", async () => {
    const { adminA } = fixture;
    const media = anonymous(server).convex;

    const { libraryId } = await adminA.music.run("libraries.create", {
      name: `Covers ${id}`,
      path: `/security-${id}/covers`,
    });

    const [oldHash, newHash] = ["old", "new"].map((cover) =>
      createHash("sha256").update(`${cover} cover ${id}`).digest("hex"),
    );

    if (oldHash === undefined || newHash === undefined) throw new Error("No cover hashes");

    const albumArt = async (): Promise<string | null> => {
      const results = await adminA.music.read("search", { query: TOKEN, limit: 50 });
      const album = results.albums.find((found) => found.title === `Canvas ${TOKEN}`);

      if (album === undefined) throw new Error("The cover test's album is not searchable");

      return album.artUrl;
    };

    const artInUse = async (): Promise<ReadonlyArray<string>> => {
      const pages = await Promise.all(
        (["tracks", "albums", "artists"] as const).map(async (table) => {
          const collect = async (
            cursor: string | null,
            hashes: ReadonlyArray<string>,
          ): Promise<ReadonlyArray<string>> => {
            const page = await media.query(artHashesRef, { secret: mediaSecret, table, cursor });
            const all = [...hashes, ...page.hashes];

            return page.done ? all : collect(page.cursor, all);
          };

          return collect(null, []);
        }),
      );

      return pages.flat();
    };

    await media.mutation(upsertTracksRef, {
      secret: mediaSecret,
      libraryId,
      tracks: [coverSong(oldHash, "Album/cover.jpg:10:1")],
    });
    expect(await albumArt()).toContain(`/art/${oldHash}?`);
    expect(await artInUse()).toContain(oldHash);

    await media.mutation(upsertTracksRef, {
      secret: mediaSecret,
      libraryId,
      tracks: [coverSong(newHash, "Album/cover.jpg:20:2")],
    });
    expect(await albumArt()).toContain(`/art/${newHash}?`);
    expect(await artInUse()).toContain(newHash);
    expect(await artInUse()).not.toContain(oldHash);

    const known = await media.query(fingerprintsRef, {
      secret: mediaSecret,
      libraryId,
      cursor: null,
    });

    expect(known.files).toEqual([expect.objectContaining({ folderArt: "Album/cover.jpg:20:2" })]);

    // A second song of the album gets a picture of its own: the album keeps its cover.
    const picture = createHash("sha256").update(`picture ${id}`).digest("hex");

    const upsert = (song: ScannedSong) =>
      media.mutation(upsertTracksRef, { secret: mediaSecret, libraryId, tracks: [song] });

    await upsert(
      canvasSong("Album/second.flac", { artHash: newHash, folderArt: "Album/cover.jpg:20:2" }),
    );
    await upsert(
      canvasSong("Album/second.flac", { artHash: picture, folderArt: "Album/cover.jpg:20:2" }),
    );
    expect(await albumArt()).toContain(`/art/${newHash}?`);

    // The cover is removed: the album takes the art its other song still has, then none.
    await upsert(canvasSong("Album/song.flac", {}));
    expect(await albumArt()).toContain(`/art/${picture}?`);
    expect(await artInUse()).not.toContain(newHash);
    await upsert(canvasSong("Album/second.flac", {}));
    expect(await albumArt()).toBeNull();
    expect(await artInUse()).not.toContain(picture);
  });

  it("refuses media service functions without the service secret", async () => {
    const visitor = anonymous(server).convex;
    const secret = `${mediaSecret}x`;
    const { libraryId } = fixture.shared;

    const calls: ReadonlyArray<Promise<unknown>> = [
      visitor.query(makeFunctionReference<"query">("media:pendingJobs"), { secret }),
      visitor.query(makeFunctionReference<"query">("media:libraries"), { secret }),
      visitor.query(makeFunctionReference<"query">("media:trackSource"), {
        secret,
        trackId: fixture.alpha.track.id,
      }),
      visitor.query(makeFunctionReference<"query">("media:fingerprints"), {
        secret,
        libraryId,
        cursor: null,
      }),
      visitor.mutation(makeFunctionReference<"mutation">("media:requestScan"), {
        secret,
        libraryId,
      }),
      visitor.mutation(makeFunctionReference<"mutation">("media:markMissing"), {
        secret,
        libraryId,
        paths: ["Open/song.flac"],
      }),
      visitor.mutation(makeFunctionReference<"mutation">("media:moveTracks"), {
        secret,
        libraryId,
        moves: [],
      }),
      visitor.query(makeFunctionReference<"query">("media:artHashes"), {
        secret,
        table: "tracks",
        cursor: null,
      }),
      visitor.mutation(makeFunctionReference<"mutation">("media:claimJob"), {
        secret,
        jobId: fixture.alpha.jobId,
        workerId: "intruder",
      }),
      visitor.mutation(makeFunctionReference<"mutation">("media:moveTracks"), {
        secret,
        libraryId: fixture.alpha.libraryId,
        moves: [],
      }),
      visitor.query(makeFunctionReference<"query">("media:artHashes"), {
        secret,
        table: "tracks",
        cursor: null,
      }),
      visitor.mutation(makeFunctionReference<"mutation">("media:claimRoot"), {
        secret,
        libraryId,
        realPath: "/",
        rootIds: [],
        fsPath: null,
        bootId: null,
      }),
      visitor.mutation(makeFunctionReference<"mutation">("media:refuseRoot"), {
        secret,
        libraryId,
      }),
    ];

    const codes = await Promise.all(calls.map(failureCode));

    expect(codes).toEqual(calls.map(() => "forbidden"));
  });

  it("binds invites to their email, uses each once, and sets the invited role", async () => {
    const { adminA } = fixture;
    const bound = await adminA.music.run("invites.create", { email: `Bound-${id}@Music.Test` });
    const inviteCode = bound.code;

    const signUpAs = (email: string, code: string) =>
      failureCode(signUp(server, { email, password: PASSWORD, inviteCode: code }));

    expect(await signUpAs(`other-${id}@music.test`, inviteCode)).toBe("signup_closed");
    expect(await signUpAs(`BOUND-${id}@music.test`, inviteCode)).toBe("succeeded");
    expect(await signUpAs(`again-${id}@music.test`, inviteCode)).toBe("signup_closed");

    const invitee = await passwordSignIn(server, `bound-${id}@music.test`, PASSWORD);

    expect(await invitee.music.read("account.me", {})).toMatchObject({ role: "member" });

    const revoked = await adminA.music.run("invites.create", {});

    await adminA.music.run("invites.revoke", { inviteId: revoked.id });
    expect(await signUpAs(`revoked-${id}@music.test`, revoked.code)).toBe("signup_closed");
    expect(
      await failureCode(
        signUp(server, { email: `uninvited-${id}@music.test`, password: PASSWORD }),
      ),
    ).toBe("signup_closed");

    const open = await adminA.music.run("invites.create", {});

    expect(
      await failureCode(
        signUp(server, {
          email: `short-${id}@music.test`,
          password: "short",
          inviteCode: open.code,
        }),
      ),
    ).toBe("invalid_args");
  });

  it("stores API keys hashed, records their use, and ends their sessions on revocation", async () => {
    const { member } = fixture;
    const created = await member.music.run("keys.create", { name: `CLI ${id}` });

    expect(created.key).toMatch(/^mk_[a-km-np-z2-9]{40}$/u);
    expect(created.apiKey.prefix).toBe(created.key.slice(0, 10));
    expect(created.apiKey.lastUsedAt).toBeNull();

    const tokens = await signIn(server, { provider: "apikey", params: { key: created.key } });

    if (tokens === null) throw new Error("A fresh API key did not sign in");

    const cli = withTokens(server, tokens);
    const me = await member.music.read("account.me", {});

    expect(await cli.music.read("account.me", {})).toEqual(me);

    const listed = await member.music.read("keys.list", {});

    expect(listed.find((key) => key.id === created.apiKey.id)?.lastUsedAt).toEqual(
      expect.any(Number),
    );

    await member.music.run("keys.revoke", { apiKeyId: created.apiKey.id });

    expect(await signIn(server, { provider: "apikey", params: { key: created.key } })).toBeNull();
    await expectReadFailure(cli, "account.me", {}, "unauthenticated");
    const refreshed = await signIn(server, { refreshToken: tokens.refreshToken }).catch(() => null);

    expect(refreshed).toBeNull();
  });

  it("ends a password session on sign-out, including its unexpired token", async () => {
    const session = await passwordSignIn(server, `member-${id}@music.test`, PASSWORD);

    if (session.tokens === null) throw new Error("Password sign-in returned no tokens");

    await signOut(server, session.tokens);
    await expectReadFailure(session, "account.me", {}, "unauthenticated");
  });

  it("makes the first account the owner and invited people the role they were invited as", async () => {
    const { adminA, adminB, member, guest } = fixture;

    expect((await adminA.music.read("account.me", {})).role).toBe("owner");
    expect((await adminB.music.read("account.me", {})).role).toBe("admin");
    expect((await member.music.read("account.me", {})).role).toBe("member");
    expect((await guest.music.read("account.me", {})).role).toBe("guest");

    const owners = (await adminA.music.read("people.list", {})).filter(
      (person) => person.role === "owner",
    );

    expect(owners).toHaveLength(1);
  });

  it("gives each role exactly the commands its capabilities allow", async () => {
    const { adminA, adminB, member, guest, shared } = fixture;
    // IDs of the wrong table: allowed callers get `not_found` and change nothing.
    const nobody = UserId.make(shared.libraryId);
    const noLibrary = LibraryId.make(shared.track.id);

    /** Each gated command, called so that it changes nothing; resolves the failure code. */
    const calls = {
      "libraries.create": ({ music }) =>
        failureCode(
          music.run("libraries.create", { name: "Again", path: `/security-${id}/shared` }),
        ),
      "libraries.scan": ({ music }) =>
        failureCode(music.run("libraries.scan", { libraryId: noLibrary })),
      "libraries.delete": ({ music }) =>
        failureCode(music.run("libraries.delete", { libraryId: noLibrary })),
      "libraries.update": ({ music }) =>
        failureCode(music.run("libraries.update", { libraryId: noLibrary, name: "Renamed" })),
      "libraries.people": ({ music }) =>
        failureCode(music.read("libraries.people", { libraryId: noLibrary })),
      "libraries.grant": ({ music }) =>
        failureCode(music.run("libraries.grant", { libraryId: noLibrary, userId: nobody })),
      "libraries.revoke": ({ music }) =>
        failureCode(music.run("libraries.revoke", { libraryId: noLibrary, userId: nobody })),
      "jobs.cancel": ({ music }) =>
        failureCode(music.run("jobs.cancel", { jobId: JobId.make(shared.libraryId) })),
      "keys.list": ({ music }) => failureCode(music.read("keys.list", {})),
      "keys.create": ({ music }) => failureCode(music.run("keys.create", { name: `Matrix ${id}` })),
      "keys.revoke": ({ music }) =>
        failureCode(music.run("keys.revoke", { apiKeyId: ApiKeyId.make(shared.libraryId) })),
      "people.list": ({ music }) => failureCode(music.read("people.list", {})),
      "people.directory": ({ music }) => failureCode(music.read("people.directory", {})),
      "server.settings": ({ music }) => failureCode(music.read("server.settings", {})),
      // No change asked for: checks who may, without turning guest accounts on.
      "server.update": ({ music }) => failureCode(music.run("server.update", {})),
      "playlists.visibility": ({ music }) =>
        failureCode(
          music.run("playlists.visibility", {
            playlistId: PlaylistId.make(shared.libraryId),
            visibility: "shared",
          }),
        ),
      "playlists.share": ({ music }) =>
        failureCode(
          music.run("playlists.share", {
            playlistId: PlaylistId.make(shared.libraryId),
            userId: nobody,
          }),
        ),
      "people.role": ({ music }) =>
        failureCode(music.run("people.role", { userId: nobody, role: "member" })),
      "people.suspend": ({ music }) => failureCode(music.run("people.suspend", { userId: nobody })),
      "people.unsuspend": ({ music }) =>
        failureCode(music.run("people.unsuspend", { userId: nobody })),
      "people.reset": ({ music }) => failureCode(music.run("people.reset", { userId: nobody })),
      "people.remove": ({ music }) => failureCode(music.run("people.remove", { userId: nobody })),
      "people.transfer": ({ music }) =>
        failureCode(music.run("people.transfer", { userId: nobody })),
      "invites.list": ({ music }) => failureCode(music.read("invites.list", {})),
      "invites.create": ({ music }) => failureCode(music.run("invites.create", { role: "guest" })),
      "invites.revoke": ({ music }) =>
        failureCode(music.run("invites.revoke", { inviteId: InviteId.make(shared.libraryId) })),
      // Queues lookups only; nothing in this suite runs the media service that would send them.
      "lyrics.backfill": ({ music }) => failureCode(music.run("lyrics.backfill", {})),
    } satisfies Record<string, (session: Session) => Promise<string>>;

    const attempts = new Map(Object.entries(calls));

    // Every command that needs more than a signed-in user is in the matrix.
    const gated = Object.keys(commands)
      .filter(isCommandName)
      .filter((name) => commands[name].access !== "user");

    expect([...attempts.keys()].toSorted()).toEqual(gated.toSorted());

    const roles: ReadonlyArray<readonly [Role, Session]> = [
      ["owner", adminA],
      ["admin", adminB],
      ["member", member],
      ["guest", guest],
    ];

    const outcomes = await Promise.all(
      gated.flatMap((name) =>
        roles.map(async ([role, session]) => {
          const attempt = attempts.get(name);
          const code = attempt === undefined ? "missing" : await attempt(session);

          return { name, role, code, allowed: can(role, commands[name].access) };
        }),
      ),
    );

    for (const { name, role, code, allowed } of outcomes) {
      expect(
        allowed ? ["succeeded", "not_found", "conflict"] : ["forbidden"],
        `${role} running ${name} got ${code}`,
      ).toContain(code);
    }
  });

  it("keeps guests to the libraries they are added to", async () => {
    const { adminA, guest, shared } = fixture;
    const { id: guestId } = await guest.music.read("account.me", {});

    const expectShut = async () => {
      const libraries = await guest.music.read("libraries.list", {});
      const search = await guest.music.read("search", { query: TOKEN, limit: 50 });

      expect(libraries.map((library) => library.id)).not.toContain(shared.libraryId);
      expect(search.tracks.map((found) => found.id)).not.toContain(shared.track.id);
      await expectReadFailure(guest, "albums.get", { albumId: shared.track.albumId }, "not_found");
      await expectReadFailure(
        guest,
        "stream.url",
        { trackId: shared.track.id, profile: "original" },
        "not_found",
      );
    };

    await expectShut();

    await adminA.music.run("libraries.grant", { libraryId: shared.libraryId, userId: guestId });

    const libraries = await guest.music.read("libraries.list", {});
    const search = await guest.music.read("search", { query: TOKEN, limit: 50 });

    expect(libraries.map((library) => library.id)).toEqual([shared.libraryId]);
    expect(search.tracks.map((found) => found.id)).toContain(shared.track.id);
    expect(search.tracks.map((found) => found.id)).not.toContain(fixture.alpha.track.id);

    const stream = await guest.music.read("stream.url", {
      trackId: shared.track.id,
      profile: "original",
    });

    expect(stream.url).toContain("/stream/");

    const people = await adminA.music.read("libraries.people", { libraryId: shared.libraryId });

    expect(people.map((person) => person.id)).toEqual([guestId]);

    await adminA.music.run("libraries.revoke", { libraryId: shared.libraryId, userId: guestId });
    await expectShut();
  });

  it("lets only the people added listen to a restricted library", async () => {
    const { adminA, adminB, member, shared } = fixture;

    const gamma = await adminA.music.run("libraries.create", {
      name: `Gamma ${id}`,
      path: `/security-${id}/gamma`,
      visibility: "restricted",
    });

    await upsertTracks(server, mediaSecret, gamma.libraryId, [
      {
        path: "Gamma/song.flac",
        title: `Gamma Song ${TOKEN}`,
        artist: `Gamma Artist ${TOKEN}`,
        album: `Gamma Album ${TOKEN}`,
        artHash: "5".repeat(64),
      },
    ]);

    const hidden = { ...gamma, track: await findTrack(adminA, `Gamma Song ${TOKEN}`) };
    const { id: memberId } = await member.music.read("account.me", {});

    await expectInvisible(member, hidden, shared);

    // Another admin sees that it exists, without hearing or managing it.
    const managed = (await adminB.music.read("libraries.list", {})).find(
      (library) => library.id === gamma.libraryId,
    );

    expect(managed).toMatchObject({ visibility: "restricted", readable: false, path: null });
    await expectReadFailure(
      adminB,
      "stream.url",
      { trackId: hidden.track.id, profile: "original" },
      "not_found",
    );

    // Only its owner lets people in.
    await expectRunFailure(
      adminB,
      "libraries.grant",
      { libraryId: gamma.libraryId, userId: memberId },
      "not_found",
    );
    await adminA.music.run("libraries.grant", { libraryId: gamma.libraryId, userId: memberId });
    expect(
      (await adminA.music.read("libraries.people", { libraryId: gamma.libraryId })).map(
        (person) => person.id,
      ),
    ).toEqual([memberId]);

    const search = await member.music.read("search", { query: `Gamma ${TOKEN}`, limit: 50 });

    expect(search.tracks.map((found) => found.id)).toContain(hidden.track.id);
    expect(
      (await member.music.read("stream.url", { trackId: hidden.track.id, profile: "original" }))
        .trackId,
    ).toBe(hidden.track.id);

    await expectRunFailure(
      adminB,
      "libraries.revoke",
      { libraryId: gamma.libraryId, userId: memberId },
      "not_found",
    );
    await adminA.music.run("libraries.revoke", { libraryId: gamma.libraryId, userId: memberId });
    await expectInvisible(member, hidden, shared);

    // Its owner opens it up; then the other admin hears it, and may rename it.
    await adminA.music.run("libraries.update", {
      libraryId: gamma.libraryId,
      visibility: "shared",
    });
    await adminB.music.run("libraries.update", {
      libraryId: gamma.libraryId,
      name: `Gamma for all ${id}`,
    });

    expect(
      (await member.music.read("libraries.list", {})).find(
        (library) => library.id === gamma.libraryId,
      ),
    ).toMatchObject({ name: `Gamma for all ${id}`, readable: true });

    // Private puts it back with its owner alone: another admin still sees it, unheard and shut.
    await adminA.music.run("libraries.update", {
      libraryId: gamma.libraryId,
      visibility: "private",
    });
    expect(
      (await adminB.music.read("libraries.list", {})).find(
        (library) => library.id === gamma.libraryId,
      ),
    ).toMatchObject({ readable: false, path: null });
    await expectRunFailure(
      adminB,
      "libraries.update",
      { libraryId: gamma.libraryId, visibility: "shared" },
      "not_found",
    );
    await expectRunFailure(
      adminA,
      "libraries.grant",
      { libraryId: gamma.libraryId, userId: memberId },
      "invalid_args",
    );
  });

  it("locks a suspended person out at once: sessions, API keys, and sign-in", async () => {
    const { adminB } = fixture;
    const email = `suspended-${id}@music.test`;
    const person = await invite(fixture.adminA, email, "member");
    const { id: userId } = await person.music.read("account.me", {});
    const { key } = await person.music.run("keys.create", { name: `CLI ${id}` });
    const keyTokens = await signIn(server, { provider: "apikey", params: { key } });

    if (keyTokens === null) throw new Error("A fresh API key did not sign in");

    const cli = withTokens(server, keyTokens);

    await adminB.music.run("people.suspend", { userId });

    await expectReadFailure(person, "account.me", {}, "unauthenticated");
    await expectReadFailure(cli, "account.me", {}, "unauthenticated");
    expect(await failureCode(signIn(server, { provider: "apikey", params: { key } }))).toBe(
      "forbidden",
    );
    expect(await failure(passwordSignIn(server, email, PASSWORD))).toEqual({
      code: "forbidden",
      message: "This account is suspended. Ask an admin on this server.",
    });
    expect(
      (await adminB.music.read("people.list", {})).find((found) => found.id === userId),
    ).toMatchObject({ suspended: true });

    await adminB.music.run("people.unsuspend", { userId });

    // Unsuspending lets them sign in again; it does not bring old sessions back.
    await expectReadFailure(person, "account.me", {}, "unauthenticated");
    await expectReadFailure(cli, "account.me", {}, "unauthenticated");

    const back = await passwordSignIn(server, email, PASSWORD);

    expect((await back.music.read("account.me", {})).id).toBe(userId);
    expect(await signIn(server, { provider: "apikey", params: { key } })).not.toBeNull();
  });

  it("protects the owner, and nobody changes their own account", async () => {
    const { adminA, adminB, member } = fixture;
    const owner = await adminA.music.read("account.me", {});
    const admin = await adminB.music.read("account.me", {});
    const { id: memberId } = await member.music.read("account.me", {});

    // Nobody reaches the owner, and the owner cannot leave the server without one.
    await Promise.all(
      [adminB, adminA].flatMap((session) => [
        expectRunFailure(session, "people.role", { userId: owner.id, role: "member" }, "forbidden"),
        expectRunFailure(session, "people.suspend", { userId: owner.id }, "forbidden"),
        expectRunFailure(session, "people.reset", { userId: owner.id }, "forbidden"),
        expectRunFailure(session, "people.remove", { userId: owner.id }, "forbidden"),
      ]),
    );

    // The last admin besides the owner cannot step down or lock themselves out either.
    await expectRunFailure(
      adminB,
      "people.role",
      { userId: admin.id, role: "member" },
      "forbidden",
    );
    await expectRunFailure(adminB, "people.suspend", { userId: admin.id }, "forbidden");
    await expectRunFailure(adminB, "people.remove", { userId: admin.id }, "forbidden");

    await expectRunFailure(adminA, "people.transfer", { userId: memberId }, "invalid_args");
    await expectRunFailure(adminA, "people.transfer", { userId: owner.id }, "invalid_args");

    await adminA.music.run("people.transfer", { userId: admin.id });

    expect((await adminB.music.read("account.me", {})).role).toBe("owner");
    expect((await adminA.music.read("account.me", {})).role).toBe("admin");
    await expectRunFailure(adminA, "people.suspend", { userId: admin.id }, "forbidden");

    const owners = (await adminA.music.read("people.list", {})).filter(
      (person) => person.role === "owner",
    );

    expect(owners.map((person) => person.id)).toEqual([admin.id]);

    await adminB.music.run("people.transfer", { userId: owner.id });
    expect((await adminA.music.read("account.me", {})).role).toBe("owner");
  });

  it("changes roles up to the changer's own, and takes API keys from new guests", async () => {
    const { adminA, adminB } = fixture;
    const person = await invite(adminA, `promoted-${id}@music.test`, "member");
    const { id: userId } = await person.music.read("account.me", {});
    const { key } = await person.music.run("keys.create", { name: `CLI ${id}` });
    const keyTokens = await signIn(server, { provider: "apikey", params: { key } });

    if (keyTokens === null) throw new Error("A fresh API key did not sign in");

    const keySignIn = () =>
      signIn(server, { provider: "apikey", params: { key } }).catch(() => null);

    await adminB.music.run("people.role", { userId, role: "guest" });

    // A guest still listens, but their keys stop signing in and the sessions they opened end.
    expect((await person.music.read("account.me", {})).role).toBe("guest");
    await expectReadFailure(person, "keys.list", {}, "forbidden");
    expect(await keySignIn()).toBeNull();
    await expect
      .poll(() => failureCode(withTokens(server, keyTokens).music.read("account.me", {})))
      .toBe("unauthenticated");

    await adminB.music.run("people.role", { userId, role: "admin" });
    expect((await person.music.read("people.list", {})).map((found) => found.id)).toContain(userId);
    // Revoked, not just refused: a promotion does not bring the key back.
    await expect.poll(keySignIn).toBeNull();

    // Only the owner manages admins, so another admin can't reset or demote them into reach of
    // their private libraries.
    await expectRunFailure(adminB, "people.reset", { userId }, "forbidden");
    await expectRunFailure(adminB, "people.role", { userId, role: "member" }, "forbidden");
    await expectRunFailure(adminB, "people.suspend", { userId }, "forbidden");

    await adminA.music.run("people.role", { userId, role: "member" });
    await expectReadFailure(person, "people.list", {}, "forbidden");
  });

  it("takes an admin's invites when they step down, and leaves their private library theirs to hear", async () => {
    const { adminA, adminB } = fixture;
    const keeper = await invite(adminA, `keeper-${id}@music.test`, "admin");
    const { id: keeperId } = await keeper.music.read("account.me", {});
    const adminInvite = await keeper.music.run("invites.create", { role: "admin" });
    const guestInvite = await keeper.music.run("invites.create", { role: "guest" });

    const vault = await keeper.music.run("libraries.create", {
      name: `Vault ${id}`,
      path: `/security-${id}/vault`,
      visibility: "private",
    });

    const listed = async () =>
      (await adminB.music.read("libraries.list", {})).find(
        (library) => library.id === vault.libraryId,
      );

    expect(await listed()).toMatchObject({ readable: false });

    await adminA.music.run("people.role", { userId: keeperId, role: "member" });

    // A member can't invite anyone, so neither invite they sent works any more.
    expect(
      await failureCode(
        signUp(server, {
          email: `via-admin-${id}@music.test`,
          password: PASSWORD,
          inviteCode: adminInvite.code,
        }),
      ),
    ).toBe("signup_closed");
    expect(await anonymous(server).convex.query(inviteLookup, { code: guestInvite.code })).toEqual({
      state: "invalid",
    });

    // Their private library is still theirs to hear. Another admin can't touch it. The server's
    // owner manages it, and may let fewer people in, never more: they could otherwise demote an
    // admin, let themselves in, and promote them again.
    expect(await listed()).toMatchObject({ readable: false, path: null });
    await expectRunFailure(
      adminB,
      "libraries.update",
      { libraryId: vault.libraryId, name: `Vault taken ${id}` },
      "not_found",
    );
    await adminA.music.run("libraries.update", {
      libraryId: vault.libraryId,
      name: `Vault kept ${id}`,
    });
    await expectRunFailure(
      adminA,
      "libraries.update",
      { libraryId: vault.libraryId, visibility: "restricted" },
      "forbidden",
    );
    await expectRunFailure(
      adminA,
      "libraries.grant",
      { libraryId: vault.libraryId, userId: (await adminA.music.read("account.me", {})).id },
      "forbidden",
    );
    expect((await keeper.music.read("libraries.list", {})).map((library) => library.id)).toContain(
      vault.libraryId,
    );
    await expectReadFailure(
      keeper,
      "libraries.people",
      { libraryId: vault.libraryId },
      "forbidden",
    );
  });

  it(
    "suspends and resets while sign-ins pour in, and no session from before outlives either",
    { timeout: 120_000 },
    async () => {
      const { adminA } = fixture;

      // Suspension, with sign-ins racing it.
      const busy = `busy-${id}@music.test`;
      const busyPerson = await invite(adminA, busy, "member");
      const { id: busyId } = await busyPerson.music.read("account.me", {});

      const suspension = await raceSignIns(busy, async () =>
        failureCode(adminA.music.run("people.suspend", { userId: busyId })),
      );

      expect(suspension.result).toBe("succeeded");
      expect(suspension.sessions.length).toBeGreaterThan(0);
      expect(await endedEverywhere(suspension.sessions)).toEqual(new Set(["unauthenticated"]));

      // A password reset, with sign-ins on the old password racing it.
      const rushed = `rushed-${id}@music.test`;
      const rushedPerson = await invite(adminA, rushed, "member");
      const { id: rushedId } = await rushedPerson.music.read("account.me", {});

      const reset = await raceSignIns(rushed, async () => {
        const { token } = await adminA.music.run("people.reset", { userId: rushedId });

        return resetPassword(server, token, "after-the-race-1");
      });

      expect(reset.sessions.length).toBeGreaterThan(0);
      expect(await endedEverywhere(reset.sessions)).toEqual(new Set(["unauthenticated"]));
      expect((await reset.result.music.read("account.me", {})).id).toBe(rushedId);
    },
  );

  it("removes a person with their sessions, keys, and data, and gives their libraries to the owner", async () => {
    const { adminA, adminB, shared } = fixture;
    const email = `leaver-${id}@music.test`;
    const leaver = await invite(adminA, email, "admin");
    const { id: leaverId } = await leaver.music.read("account.me", {});
    const { id: ownerId } = await adminA.music.read("account.me", {});
    const { key } = await leaver.music.run("keys.create", { name: `CLI ${id}` });

    await leaver.music.run("playlists.create", { name: "Mine", trackIds: [shared.track.id] });
    await leaver.music.run("likes.set", { trackId: shared.track.id, liked: true });
    await leaver.music.run("devices.heartbeat", {
      deviceId: DeviceId.make(`leaver-${id}`),
      name: "Leaver's laptop",
      kind: "web",
    });

    const delta = await leaver.music.run("libraries.create", {
      name: `Delta ${id}`,
      path: `/security-${id}/delta`,
      visibility: "private",
    });

    const before = (await adminA.music.read("people.list", {})).find(
      (person) => person.id === leaverId,
    );

    expect(before?.lastActiveAt).toEqual(expect.any(Number));

    await adminA.music.run("people.remove", { userId: leaverId });

    await expectReadFailure(leaver, "account.me", {}, "unauthenticated");
    expect(await signIn(server, { provider: "apikey", params: { key } })).toBeNull();
    expect(await failureCode(passwordSignIn(server, email, PASSWORD))).not.toBe("succeeded");
    expect((await adminA.music.read("people.list", {})).map((person) => person.id)).not.toContain(
      leaverId,
    );

    // Ownership moves in the batched clean-up right after the removal.
    const listedTo = async (session: Session) =>
      (await session.music.read("libraries.list", {})).find(
        (library) => library.id === delta.libraryId,
      );

    await expect
      .poll(() => listedTo(adminA))
      .toMatchObject({ ownerId, visibility: "private", readable: true });
    // Now the owner's private library: other admins see it exists, and can't touch it.
    expect(await listedTo(adminB)).toMatchObject({ readable: false, path: null });
    await expectRunFailure(
      adminB,
      "libraries.update",
      { libraryId: delta.libraryId, visibility: "shared" },
      "not_found",
    );

    // The email can join again, as someone new with nothing of the old account.
    const again = await invite(adminA, email, "member");

    expect((await again.music.read("account.me", {})).id).not.toBe(leaverId);
    expect(await again.music.read("playlists.list", {})).toEqual([]);
    expect(await again.music.read("likes.list", {})).toEqual([]);
  });

  it("resets a password with a one-time link and ends the old sessions", async () => {
    const { adminB } = fixture;
    const email = `forgetful-${id}@music.test`;
    const person = await invite(fixture.adminA, email, "member");
    const { id: userId } = await person.music.read("account.me", {});
    const reset = await adminB.music.run("people.reset", { userId });

    const lookup = (token: string) =>
      anonymous(server).convex.query(passwordResetLookup, { token });

    expect(await lookup(reset.token)).toMatchObject({ state: "open", email });
    expect(await lookup("not-a-token")).toEqual({ state: "invalid" });
    expect(await failureCode(resetPassword(server, reset.token, "short"))).toBe("invalid_args");

    const fresh = await resetPassword(server, reset.token, "a-new-password");

    expect((await fresh.music.read("account.me", {})).id).toBe(userId);
    await expectReadFailure(person, "account.me", {}, "unauthenticated");
    expect(await failureCode(passwordSignIn(server, email, PASSWORD))).not.toBe("succeeded");
    expect((await passwordSignIn(server, email, "a-new-password")).tokens).not.toBeNull();

    expect(await failure(resetPassword(server, reset.token, "another-password"))).toEqual({
      code: "invalid_args",
      message: "This reset link was already used",
    });
    expect(await lookup(reset.token)).toMatchObject({ state: "used" });
  });

  it("voids a reset link once its maker loses the right to reset that person", async () => {
    const { adminA } = fixture;
    const issuer = await invite(adminA, `issuer-${id}@music.test`, "admin");
    const { id: issuerId } = await issuer.music.read("account.me", {});
    const target = await invite(adminA, `target-${id}@music.test`, "member");
    const { id: targetId } = await target.music.read("account.me", {});
    const { token } = await issuer.music.run("people.reset", { userId: targetId });

    await adminA.music.run("people.suspend", { userId: issuerId });

    expect(await anonymous(server).convex.query(passwordResetLookup, { token })).toEqual({
      state: "invalid",
    });
    expect(await failureCode(resetPassword(server, token, "taken-over-1"))).toBe("invalid_args");
    expect(await failureCode(passwordSignIn(server, `target-${id}@music.test`, PASSWORD))).toBe(
      "succeeded",
    );
  });

  it("voids a reset link made for someone who has since become an admin", async () => {
    const { adminA, adminB } = fixture;
    const rising = await invite(adminA, `rising-${id}@music.test`, "member");
    const { id: risingId } = await rising.music.read("account.me", {});
    const { token } = await adminB.music.run("people.reset", { userId: risingId });

    await adminA.music.run("people.role", { userId: risingId, role: "admin" });

    // Otherwise adminB could take over an admin and reach their private libraries.
    expect(await failureCode(resetPassword(server, token, "taken-over-2"))).toBe("invalid_args");
    expect(await failureCode(passwordSignIn(server, `rising-${id}@music.test`, PASSWORD))).toBe(
      "succeeded",
    );
  });

  it("answers an unknown email and a wrong password alike, and refuses sign-up over an account", async () => {
    const generic = { code: "unauthenticated", message: "Invalid email or password" };

    expect(await failure(passwordSignIn(server, `nobody-${id}@music.test`, PASSWORD))).toEqual(
      generic,
    );
    expect(await failure(passwordSignIn(server, `member-${id}@music.test`, "wrong-pass"))).toEqual(
      generic,
    );

    // Without a valid invite, sign-up answers every email alike, so it can't tell which exist.
    const withoutInvite = await Promise.all(
      [`member-${id}@music.test`, `nobody-${id}@music.test`].map((email) =>
        failureCode(signUp(server, { email, password: PASSWORD })),
      ),
    );

    expect(withoutInvite).toEqual(["signup_closed", "signup_closed"]);

    // With one, sign-up over an existing account is refused before any password check, which
    // would have no rate limit there.
    const { code } = await fixture.adminA.music.run("invites.create", {});

    expect(
      await failure(
        signUp(server, { email: `member-${id}@music.test`, password: PASSWORD, inviteCode: code }),
      ),
    ).toEqual(generic);
  });
  it("keeps a library's files from a second library under another name for the folder", async () => {
    const { adminA, adminB, alpha } = fixture;

    // The media service resolves each library's folder before a scan and claims it.
    expect(
      await claimRoot(alpha.libraryId, `/security-${id}/alpha`, [`${id}:alpha`, `${id}:top`]),
    ).toEqual({ ok: true });

    // A link (or /proc/self/root, or a bind mount) names the folder around it differently.
    const alias = await adminB.music.run("libraries.create", {
      name: `Alias ${id}`,
      path: `/elsewhere-${id}/link`,
    });

    const refused = await claimRoot(alias.libraryId, `/security-${id}`, [`${id}:top`]);

    expect(refused.ok).toBe(false);
    // The refusal is the job's error, which the alias's owner reads: it names no folder.
    expect(refused.error).not.toMatch(/security-/u);

    // A bind mount keeps the folder's identity, so a path that says nothing of it is refused too.
    expect(
      await claimRoot(alias.libraryId, `/elsewhere-${id}/link`, [`${id}:alpha`, `${id}:mnt`]),
    ).toMatchObject({ ok: false });

    // A refused claim stops its library streaming until a claim succeeds again.
    const play = () =>
      failureCode(
        adminA.music.read("stream.url", { trackId: alpha.track.id, profile: "original" }),
      );

    expect(await play()).toBe("succeeded");
    expect(await claimRoot(alpha.libraryId, "/proc/1/root", [])).toMatchObject({ ok: false });
    expect(await play()).toBe("not_found");
    expect(
      await claimRoot(alpha.libraryId, `/security-${id}/alpha`, [`${id}:alpha`, `${id}:top`]),
    ).toEqual({ ok: true });
    expect(await play()).toBe("succeeded");

    // Only a library's own owner or the server's owner removes it: an admin added to it could
    // otherwise remove it and add its folder back as their own.
    const shared = await adminA.music.run("libraries.create", {
      name: `Lent ${id}`,
      path: `/security-${id}/lent`,
      visibility: "restricted",
    });

    const { id: adminBId } = await adminB.music.read("account.me", {});

    await adminA.music.run("libraries.grant", { libraryId: shared.libraryId, userId: adminBId });
    await expectRunFailure(
      adminB,
      "libraries.delete",
      { libraryId: shared.libraryId },
      "forbidden",
    );
    await adminB.music.run("libraries.update", { libraryId: shared.libraryId, name: `Lent ${id}` });

    // An overlap with a library the admin can't hear names neither folder.
    expect(
      await failure(
        adminB.music.run("libraries.create", { name: "Probe", path: `/security-${id}/alpha/x` }),
      ),
    ).toEqual({ code: "conflict", message: "This folder overlaps another library" });
  });
});
