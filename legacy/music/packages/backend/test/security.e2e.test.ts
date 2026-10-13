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
 * the admin account; later runs sign in as whichever of them won and skip that test.
 */
import {
  AlbumId,
  ApiKeyId,
  ArtistId,
  DeviceId,
  JobId,
  LibraryId,
  PlaylistId,
  PlaylistItemId,
  TrackId,
} from "@music/commands/ids";
import type { CommandResult } from "@music/commands/registry";
import { setupStatus, inviteLookup } from "@music/sdk/functions";
import { makeFunctionReference } from "convex/server";
import { beforeAll, describe, expect, it } from "vitest";

import {
  anonymous,
  expectReadFailure,
  expectRunFailure,
  failureCode,
  passwordSignIn,
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
  /** Owns the shared library and the private library `alpha`. */
  readonly adminA: Session;
  /** A second admin who owns the private library `beta`. */
  readonly adminB: Session;
  readonly member: Session;
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

/** The names that carry an accent or ß, such as the accented catalog one test adds. */
const accentedOnly = (names: ReadonlyArray<string>): ReadonlyArray<string> =>
  names.filter((name) => /[äöüß]/u.test(name));

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

const invite = async (
  admin: Session,
  email: string,
  role: "admin" | "member",
): Promise<Session> => {
  const created = await admin.music.run("invites.create", { email, role });

  return signUp(server, { email, password: PASSWORD, inviteCode: created.code });
};

const setup = async (): Promise<Fixture> => {
  const { race, usersAfterRace, adminA } = await signUpAdmin();
  const adminB = await invite(adminA, `admin-b-${id}@music.test`, "admin");
  const member = await invite(adminA, `member-${id}@music.test`, "member");

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
    shared: {
      libraryId: shared.libraryId,
      track: await findTrack(adminA, `Open Song ${TOKEN}`),
    },
    alpha: { ...alpha, track: await findTrack(adminA, `Alpha Song ${TOKEN}`) },
    beta: { ...beta, track: await findTrack(adminB, `Beta Song ${TOKEN}`) },
  };
};

/**
 * Checks that `viewer` cannot see or use anything in the private library `hidden`, through every
 * command that lists, searches, or takes an ID of library-owned data.
 */
const expectInvisible = async (
  viewer: Session,
  hidden: Fixture["alpha"],
  visible: Fixture["shared"],
): Promise<void> => {
  const { track } = hidden;
  const libraries = await viewer.music.read("libraries.list", {});
  const libraryIds = libraries.map((library) => library.id);

  expect(libraryIds).toContain(visible.libraryId);
  expect(libraryIds).not.toContain(hidden.libraryId);

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

  const jobs = await viewer.music.read("jobs.list", {});

  expect(jobs.map((job) => job.libraryId)).not.toContain(hidden.libraryId);
  expect(jobs.map((job) => job.id)).not.toContain(hidden.jobId);
  await expectReadFailure(viewer, "jobs.get", { jobId: hidden.jobId }, "not_found");
};

describe.skipIf(server === "" || mediaSecret === "")("backend authorization", () => {
  let fixture: Fixture;

  beforeAll(async () => {
    fixture = await setup();
  }, 120_000);

  it("creates exactly one admin when two people sign up on an empty server at once", (context) => {
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

  it("hides another admin's private library from an admin, including its jobs", async () => {
    const { adminA, adminB, alpha, beta, shared } = fixture;

    await expectInvisible(adminB, alpha, shared);
    await expectInvisible(adminA, beta, shared);

    await expectRunFailure(adminB, "libraries.scan", { libraryId: alpha.libraryId }, "not_found");
    await expectRunFailure(adminB, "jobs.cancel", { jobId: alpha.jobId }, "not_found");
    await expectRunFailure(adminB, "libraries.delete", { libraryId: alpha.libraryId }, "not_found");

    const own = await adminA.music.read("libraries.list", {});

    expect(own.map((library) => library.id)).toContain(alpha.libraryId);
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
      visitor.mutation(makeFunctionReference<"mutation">("media:claimJob"), {
        secret,
        jobId: fixture.alpha.jobId,
        workerId: "intruder",
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
});
